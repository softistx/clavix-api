import { GraphQLError } from "graphql";
import type { Context } from "@/http/context";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import type { TenantJanus } from "@/modules/users/users.tenant-janus";
import { fail } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";
import {
  goneCode,
  guarded,
  invalid,
  ResendRefusedError,
  TenantUnavailableError,
} from "./invitations.errors";
import {
  adminTenantOf,
  DEFAULT_MAX_PENDING,
  inviteRefusal,
  RESEND_COOLDOWN_MS,
  retryAfterSeconds,
} from "./invitations.rules";
import type {
  InvitationSource,
  InvitationsAuth,
  InvitationsOptions,
  InvitationsPorts,
  InviteInput,
  PendingInvitation,
  ResendInput,
  StoredInvitation,
  TenantInvitations,
} from "./invitations.types";
import { toPending } from "./invitations.utils";

/** Reads a tenant's invitation source on every call; `null` means the tenant is missing or suspended. */
type SourceOf = () => Promise<InvitationSource | null>;

/**
 * The invitations: the hosted `/invitation` page (preview and accept, for the
 * host's own tenant) and a tenant's user pool (issue and mail, resend, list,
 * revoke), which a console reaches through `bind`.
 */
export class InvitationsService {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly maxPending: number;

  constructor(
    private readonly ports: InvitationsPorts,
    {
      now,
      cooldownMs = RESEND_COOLDOWN_MS,
      maxPending = DEFAULT_MAX_PENDING,
    }: InvitationsOptions,
  ) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.maxPending = maxPending;
  }

  /** `TenantInvitations` over one tenant: `source` is read on every call (a tenant's instance is rebuilt when it changes). */
  bind(source: SourceOf): TenantInvitations {
    return {
      invite: (input) => this.invite(source, input),
      resend: (input) => this.resend(source, input),
      pending: (scope) => this.pending(source, scope),
      revoke: (scope, id) => this.revoke(source, scope, id),
    };
  }

  /** What an invitation code is for, on the request's host (`invitationPreview`). */
  async preview(ctx: Context, code: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    ctx.set.headers.set("cache-control", "no-store");
    const preview = await guarded(() => auth.invitations.preview(code));
    return {
      email: preview.email,
      organization: await this.organizationOf(preview.scope, tenant),
      role: preview.role,
      expiresAt: preview.expiresAt,
    };
  }

  /** Accepts the code: signs the invitee in, or tells them to sign in as usual (`acceptInvitation`). */
  async accept(ctx: Context, code: string) {
    const { auth, tenant } = await this.tenantOf(ctx);
    requireLive(tenant);
    ctx.set.headers.set("cache-control", "no-store");
    const accepted = await guarded(() => auth.invitations.accept({ code }));
    const organization = await this.organizationOf(
      accepted.invitation.scope,
      tenant,
    ).catch((error: unknown) => {
      // Accepted already: a tenant gone since is no refusal.
      if (error instanceof GraphQLError) return "";
      throw error;
    });
    if (accepted.status !== "signedIn") {
      // The address already had an account (they sign in as usual).
      return { signedIn: false, user: null, expiresAt: null, organization };
    }
    ctx.set.headers.append(
      "set-cookie",
      auth.cookie.serialize(accepted.token, accepted.session),
    );
    const user = await auth.findUser(accepted.user.id);
    if (user === null) throw invalid();
    // The sign-in counts as the month's activity, like any other sign-in.
    await this.ports.usage.recordActive(tenant.tenantId, user.id);
    return {
      signedIn: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        emailVerified: user.emailVerified,
      },
      expiresAt: accepted.session.expiresAt,
      organization,
    };
  }

  /**
   * Issues the invitation (a pending one of the same scope and address is
   * replaced) and mails its link. Throws `ResendRefusedError`:
   * `INVITE_TOO_SOON` or `PENDING_INVITATIONS_LIMIT`.
   */
  async invite(
    source: SourceOf,
    { scope, organization, email, role, invitedBy }: InviteInput,
  ): Promise<PendingInvitation> {
    const { auth, mail, link } = await this.need(source);
    const refusal = inviteRefusal(await this.listPending(auth, scope), email, {
      now: this.now(),
      cooldownMs: this.cooldownMs,
      maxPending: this.maxPending,
    });
    if (refusal !== null) throw refusal;
    const issued = await auth.invitations.issue({
      scope,
      email,
      name: email.split("@")[0] ?? email,
      role,
      invitedBy: invitedBy === null ? null : { id: invitedBy.id },
    });
    await mail.invitation(
      { email },
      {
        ...(invitedBy?.name === undefined ? {} : { inviter: invitedBy.name }),
        organization,
        role,
        link: link(issued.code),
        expiresAt: issued.invitation.expiresAt,
      },
    );
    return toPending(issued.invitation);
  }

  /**
   * Sends a pending invitation again with a new code and lifetime, and mails
   * the new link. Throws `ResendRefusedError`: `NOT_FOUND`,
   * `INVITATION_NOT_PENDING` or `RESEND_TOO_SOON`.
   */
  async resend(
    source: SourceOf,
    { scope, invitationId, organization, by }: ResendInput,
  ): Promise<PendingInvitation> {
    const { auth, mail, link } = await this.need(source);
    const found = await auth.invitations.get({ id: invitationId, scope });
    if (found === null) throw new ResendRefusedError("NOT_FOUND");
    if (found.status !== "pending") {
      throw new ResendRefusedError("INVITATION_NOT_PENDING");
    }
    const wait = retryAfterSeconds(
      found.updatedAt,
      this.cooldownMs,
      this.now(),
    );
    if (wait > 0) throw new ResendRefusedError("RESEND_TOO_SOON", wait);
    let sent: Awaited<ReturnType<typeof auth.invitations.resend>>;
    try {
      sent = await auth.invitations.resend({
        id: invitationId,
        scope,
        by: by.id,
      });
    } catch (error) {
      // Accepted or revoked between the read and the write.
      const gone = goneCode(error);
      if (gone !== null) throw new ResendRefusedError(gone);
      throw error;
    }
    await mail.invitation(
      { email: sent.invitation.email },
      {
        ...(by.name === undefined ? {} : { inviter: by.name }),
        organization,
        role: sent.invitation.role,
        link: link(sent.code),
        expiresAt: sent.invitation.expiresAt,
      },
    );
    return toPending(sent.invitation);
  }

  /** The pending, unlapsed invitations of the scope, all of them. */
  async pending(source: SourceOf, scope: string): Promise<PendingInvitation[]> {
    const { auth } = await this.need(source);
    return (await this.listPending(auth, scope)).map(toPending);
  }

  /** Revokes a pending invitation of the scope; `false` when it is not one. */
  async revoke(
    source: SourceOf,
    scope: string,
    invitationId: string,
  ): Promise<boolean> {
    const { auth } = await this.need(source);
    try {
      await auth.invitations.revoke({ id: invitationId, scope });
      return true;
    } catch (error) {
      // Not this scope's, or no longer pending: nothing to revoke.
      if (goneCode(error) !== null) return false;
      throw error;
    }
  }

  private async need(source: SourceOf): Promise<InvitationSource> {
    const found = await source();
    if (found === null) throw new TenantUnavailableError();
    return found;
  }

  private async listPending(
    auth: InvitationsAuth,
    scope: string,
  ): Promise<StoredInvitation[]> {
    const found: StoredInvitation[] = [];
    let after: string | null = null;
    do {
      const page = await auth.invitations.list(scope, {
        status: "pending",
        lapsed: "exclude",
        limit: 100,
        after,
      });
      found.push(...page.items);
      after = page.nextCursor;
    } while (after !== null);
    return found;
  }

  /** The janus instance and the tenant of the request's host. */
  private async tenantOf(ctx: Context) {
    const [auth, tenant]: [
      TenantJanus | null,
      Awaited<ReturnType<Context["tenant"]>>,
    ] = await Promise.all([
      this.ports.issuers.forRequest(ctx.request),
      ctx.tenant(),
    ]);
    if (auth === null || tenant === null) {
      throw fail("NOT_FOUND", "No such tenant", { status: 404 });
    }
    return { auth, tenant };
  }

  /**
   * What the invitee joins: the tenant they will administer for an admin
   * invitation (gone or suspended: the invitation is invalid), else the tenant
   * of the host, whose user pool they enter.
   */
  private async organizationOf(
    scope: string,
    host: { name: string; slug: string },
  ): Promise<string> {
    // An admin scope only has that meaning where admins are invited: on `clavix`.
    const managed =
      host.slug === PLATFORM_TENANT_SLUG ? adminTenantOf(scope) : null;
    if (managed === null) return host.name;
    const [tenant] = await this.ports.tenants.activeByIds([managed]);
    if (tenant === undefined) throw invalid();
    return tenant.name;
  }
}
