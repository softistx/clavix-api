import { JanusError } from "@softistx/janus";
import { requireFresh } from "@softistx/janus-graphql";
import { ObjectId } from "mongodb";
import { userKey } from "@/console/modules/user-key";
import type { Context } from "@/http/context";
import { afterAnswer } from "@/modules/auth/auth.outbox";
import { currentUserOf } from "@/modules/auth/auth.utils";
import { FRESH_WITHIN } from "@/modules/mfa/mfa.utils";
import {
  checkUnlocked,
  cleanProfile,
  patchOf,
  profileOf,
} from "@/modules/profile";
import type { TenantJanus } from "@/modules/users";
import { badInput, fail, refuseCommon } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";
import { emailChangeInvalid } from "./account.errors";
import type { AccountPorts } from "./account.types";
import { cleanName, valueChangesOf } from "./account.utils";

/** The janus refusals of a change token: one `EMAIL_CHANGE_INVALID`, the page offers a new request. */
const TOKEN_REFUSALS = new Set([
  "TOKEN_UNKNOWN",
  "TOKEN_SPENT",
  "TOKEN_EXPIRED",
  "TOKEN_STALE",
  "USER_INACTIVE",
]);

/**
 * The signed-in user's own account, for the hosted pages of the tenant the
 * request's host names: their profile fields (the tenant's locks bind them),
 * the attributes they may set themselves, and the change of their e-mail
 * address (a link mailed to the new address; the account moves only when it is
 * redeemed). A user's writes run under their `userKey`, as the console's do.
 */
export class AccountService {
  constructor(private readonly ports: AccountPorts) {}

  /** The janus instance and the tenant of the request's host; a host that names no active tenant is a NOT_FOUND. */
  private async tenantOf(ctx: Context) {
    const [auth, tenant] = await Promise.all([
      this.ports.issuers.forRequest(ctx.request),
      ctx.tenant(),
    ]);
    if (auth === null || tenant === null) {
      throw fail("NOT_FOUND", "No such tenant", { status: 404 });
    }
    requireLive(tenant);
    return { auth, tenant, tenantId: new ObjectId(tenant.tenantId) };
  }

  /** The signed-in user of the request, or UNAUTHENTICATED (401). */
  private async signedIn(auth: TenantJanus, request: Request) {
    const current = await auth.authenticate(request);
    if (current === null)
      throw fail("UNAUTHENTICATED", "Not signed in", { status: 401 });
    return current.user;
  }

  /** The user's standard profile fields, as `CurrentUser.profile`. */
  async profile(ctx: Context, userId: string) {
    const { auth } = await this.tenantOf(ctx);
    const user = await auth.findUser(userId);
    if (user === null)
      throw fail("UNAUTHENTICATED", "Not signed in", { status: 401 });
    return profileOf(user);
  }

  /** The tenant's locked profile fields, as `CurrentUser.lockedFields`. */
  async lockedFields(ctx: Context) {
    const { tenantId } = await this.tenantOf(ctx);
    return this.ports.profilePolicies.lockedFor(tenantId);
  }

  /** The attributes the user may set themselves, with their values, as `CurrentUser.attributes`. */
  async attributes(ctx: Context, userId: string) {
    const { tenantId } = await this.tenantOf(ctx);
    return this.ports.values.editableOf(tenantId, userId);
  }

  /**
   * Changes the user's own profile fields. A locked field is refused before
   * anything is written, an invalid value too; a changed phone starts
   * unverified; a repeat writes nothing. Read, checked and written under the
   * user's lock, on the version read (`CONFLICT` when it moved).
   */
  async updateMyProfile(
    ctx: Context,
    input: Parameters<typeof cleanProfile>[0],
  ) {
    const { auth, tenantId } = await this.tenantOf(ctx);
    const session = await this.signedIn(auth, ctx.request);
    ctx.set.headers.set("cache-control", "no-store");
    const { name, ...fields } = input;
    const changes = {
      ...cleanProfile(fields, this.ports.now()),
      ...(name === undefined ? {} : { name: cleanName(name ?? "") }),
    };
    checkUnlocked(
      changes,
      await this.ports.profilePolicies.lockedFor(tenantId),
    );
    return this.ports.exclusive(
      userKey(tenantId.toHexString(), session.id),
      async () => {
        const user = await auth.findUser(session.id);
        if (user === null)
          throw fail("UNAUTHENTICATED", "Not signed in", { status: 401 });
        const patch = patchOf(changes, user);
        if (Object.keys(patch).length === 0) return currentUserOf(user);
        try {
          return currentUserOf(
            await auth.update(user, patch, { ifVersion: user.version }),
          );
        } catch (error) {
          if (
            error instanceof JanusError &&
            error.code === "VERSION_CONFLICT"
          ) {
            refuseCommon(
              "CONFLICT",
              "Your account changed meanwhile; read it and try again",
            );
          }
          throw error;
        }
      },
    );
  }

  /**
   * Sets and clears the user's own attribute values and answers the attributes
   * they may edit. An attribute an administrator alone sets is refused first
   * (`ATTRIBUTE_NOT_EDITABLE`); `required` never blocks a self-service save.
   */
  async setMyAttributeValues(
    ctx: Context,
    values: Parameters<typeof valueChangesOf>[0],
  ) {
    const { auth, tenantId } = await this.tenantOf(ctx);
    const user = await this.signedIn(auth, ctx.request);
    ctx.set.headers.set("cache-control", "no-store");
    const changes = valueChangesOf(values);
    await this.ports.exclusive(
      userKey(tenantId.toHexString(), user.id),
      async () => {
        await this.ports.values.checkEditable(tenantId, changes);
        await this.ports.values.save(
          tenantId,
          user.id,
          changes,
          { kind: "user", id: user.id },
          false,
        );
      },
    );
    return this.ports.values.editableOf(tenantId, user.id);
  }

  /**
   * Mails a link to the NEW address. The session must have proved itself less
   * than ten minutes ago (`STEP_UP_REQUIRED` otherwise, so the page asks for a
   * new sign-in); janus throttles per user and per address (`MAIL_THROTTLED`).
   * Whether somebody holds the address is only told when the link is redeemed.
   */
  async requestEmailChange(ctx: Context, email: string): Promise<true> {
    const { auth, tenant } = await this.tenantOf(ctx);
    await requireFresh(ctx, FRESH_WITHIN);
    const user = await this.signedIn(auth, ctx.request);
    ctx.set.headers.set("cache-control", "no-store");
    const issued = await this.issued(auth, user, email);
    const mail = this.ports.mailOf(tenant);
    afterAnswer(async () => {
      await mail.changeEmail(issued, { name: user.name ?? user.email });
    }, this.ports.log);
    return true;
  }

  /** The change token for `email`: the current or a malformed address is a bad input. */
  private async issued(auth: TenantJanus, user: { id: string }, email: string) {
    try {
      return await auth.changeEmail.send(user, email);
    } catch (error) {
      if (error instanceof JanusError && error.code === "USER_INVALID") {
        throw badInput(
          "The address is the current one or is not valid",
          "email",
        );
      }
      throw error;
    }
  }

  /**
   * Redeems the token for a signed-in session: the account moves to the
   * address the link was sent to, which counts as verified, and the former
   * address is told after the answer. An address another account took
   * meanwhile is `LOGIN_TAKEN` (the token is spent); an unknown, spent,
   * expired or stale token is one `EMAIL_CHANGE_INVALID`.
   */
  async confirmEmailChange(ctx: Context, token: string) {
    const { auth, tenant, tenantId } = await this.tenantOf(ctx);
    const session = await this.signedIn(auth, ctx.request);
    ctx.set.headers.set("cache-control", "no-store");
    const moved = await this.ports.exclusive(
      userKey(tenantId.toHexString(), session.id),
      () => this.redeemed(auth, token),
    );
    if (moved.id !== session.id) return currentUserOf(session);
    const mail = this.ports.mailOf(tenant);
    afterAnswer(async () => {
      await mail.emailChanged({
        name: moved.name ?? moved.email,
        formerEmail: session.email,
        newEmail: moved.email,
      });
    }, this.ports.log);
    return currentUserOf(moved);
  }

  /** `changeEmail.confirm` with the token refusals worded as this module's. */
  private async redeemed(auth: TenantJanus, token: string) {
    try {
      return await auth.changeEmail.confirm(token);
    } catch (error) {
      if (error instanceof JanusError) {
        if (TOKEN_REFUSALS.has(error.code)) throw emailChangeInvalid();
        if (error.code === "VERSION_CONFLICT") {
          refuseCommon(
            "CONFLICT",
            "Your account changed meanwhile; try the link again",
          );
        }
      }
      throw error;
    }
  }
}
