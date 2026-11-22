import { OptimisticLockError } from "@softistx/mongo";
import type {
  Tenant,
  TenantSocialService,
  TenantsService,
} from "@/modules/tenants";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { badInput } from "@/shared/errors";
import { refusal } from "./sign-in-methods.errors";
import {
  checkedSocial,
  methodChange,
  nextMfa,
  requireFirstParty,
  requireUsable,
  resealEntries,
  withMethods,
} from "./sign-in-methods.rules";
import {
  type MethodEntry,
  type MfaPolicy,
  methodsOf,
  type SignInPolicy,
  type SocialEntry,
  type SocialProviderId,
} from "./sign-in-methods.schema";
import {
  emptySecretResealCounts,
  type SecretBox,
  type SecretResealCounts,
  secretContext,
} from "./sign-in-methods.secrets";
import type { CheckedSocial, SocialInput } from "./sign-in-methods.types";
import { holdsSecret, sameValue, withSocial } from "./sign-in-methods.utils";

/**
 * The sign-in policy of a tenant (ADR-0035): which methods it offers and its
 * own social apps. Every change is one tenant write: it bumps the tenant's
 * version, so the resolver cache drops the host and the tenant's janus is
 * rebuilt. A change that changes nothing writes nothing (idempotent). Secrets
 * are sealed before they reach the document and never come back out.
 */
export class SignInPolicyService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly social: TenantSocialService,
    private readonly box: SecretBox,
    private readonly log: (message: string) => void,
  ) {}

  /** The tenant (suspended included: its policy stays readable), or NOT_FOUND (404) for an unknown or trashed one. */
  async get(tenantId: string): Promise<Tenant> {
    const [tenant] = await this.tenants.liveByIds([tenantId]);
    if (tenant === undefined) throw refusal("NOT_FOUND", "No such tenant", 404);
    return tenant;
  }

  /** Turns methods on or off; a type with no entry keeps its value. */
  async updateMethods(
    tenantId: string,
    entries: readonly MethodEntry[],
  ): Promise<Tenant> {
    const change = methodChange(entries);
    await this.get(tenantId);
    return this.write(tenantId, ({ signIn, slug }) => {
      const current = methodsOf(signIn);
      const methods = withMethods(signIn, change);
      if (sameValue(methods, current)) return null;
      const next = { ...signIn, methods };
      if (slug === PLATFORM_TENANT_SLUG) requireFirstParty(next);
      return requireUsable(next);
    });
  }

  /**
   * Sets the tenant's multi-factor policy (D7); a field left out keeps its
   * value, and a change that changes nothing writes nothing.
   */
  async updateMfa(
    tenantId: string,
    input: Partial<MfaPolicy>,
  ): Promise<Tenant> {
    await this.get(tenantId);
    return this.write(tenantId, ({ signIn }) => {
      const mfa = nextMfa(signIn.mfa, input);
      return sameValue(mfa, signIn.mfa) ? null : { ...signIn, mfa };
    });
  }

  /** Sets the tenant's own app for a provider, sealing a secret that is given. */
  async setSocial(tenantId: string, input: SocialInput): Promise<Tenant> {
    const given = checkedSocial(input);
    await this.get(tenantId);
    return this.write(tenantId, (tenant) =>
      this.socialChange(tenant, input, given),
    );
  }

  /** Removes the tenant's app for a provider, and its sealed secret. */
  async removeSocial(
    tenantId: string,
    provider: SocialProviderId,
  ): Promise<Tenant> {
    await this.get(tenantId);
    return this.write(tenantId, ({ signIn }) => {
      const social = signIn.social.filter((e) => e.provider !== provider);
      if (social.length === signIn.social.length) return null;
      return requireUsable({ ...signIn, social });
    });
  }

  /**
   * Seals the tenant's social client secrets again under the keyring's first
   * key (`keys:reseal`, a master-key rotation), a tenant in the trash
   * included. One write for the tenant, refused when it changed meanwhile
   * (`skipped`: run again). A secret no key opens is left as it is and logged
   * by provider and tenant, never by value (`unreadable`).
   */
  async resealSecrets(tenantId: string): Promise<SecretResealCounts> {
    const counts = emptySecretResealCounts();
    const tenant = await this.tenants.anyById(tenantId);
    if (tenant === undefined) return counts;
    const { social, pending } = resealEntries(
      tenant._id.toHexString(),
      tenant.signIn.social,
      this.box,
      this.log,
      counts,
    );
    if (pending > 0) {
      const written = await this.social.replaceSocial(tenant, social);
      if (written) counts.resealed += pending;
      else counts.skipped += pending;
    }
    const after = await this.tenants.anyById(tenantId);
    counts.behind = (after?.signIn.social ?? []).filter(
      (entry) => entry.secret.kid !== this.box.kid,
    ).length;
    return counts;
  }

  /** One tenant write; other changes that keep winning the race end in CONFLICT (409), nothing stored. */
  private async write(
    tenantId: string,
    change: (tenant: Tenant) => SignInPolicy | null,
  ): Promise<Tenant> {
    try {
      return await this.tenants.updateSignIn(tenantId, change);
    } catch (error) {
      if (error instanceof OptimisticLockError) {
        throw refusal(
          "CONFLICT",
          "The sign-in policy was changed at the same time; read it and try again",
          409,
        );
      }
      throw error;
    }
  }

  /** The policy with the provider's app set, or `null` when it is the stored one already. */
  private socialChange(
    { _id, signIn }: Tenant,
    input: SocialInput,
    given: CheckedSocial,
  ): SignInPolicy | null {
    // The stored tenant's own id binds the secret, not the caller's string.
    const owner = _id.toHexString();
    const current = signIn.social.find((e) => e.provider === input.provider);
    const clientId = given.clientId ?? current?.clientId;
    if (clientId === undefined) throw badInput("clientId is required");
    const entry: SocialEntry = {
      provider: input.provider,
      clientId,
      secret: this.secretOf(owner, input.provider, current, given.clientSecret),
      enabled: input.enabled ?? current?.enabled ?? true,
    };
    if (current !== undefined && sameValue(current, entry)) return null;
    return requireUsable({
      ...signIn,
      social: withSocial(signIn.social, entry),
    });
  }

  /** The secret an entry stores: the stored one when none is given or the same is, else the one given, sealed. */
  private secretOf(
    owner: string,
    provider: SocialProviderId,
    current: SocialEntry | undefined,
    clientSecret: string | undefined,
  ): SocialEntry["secret"] {
    // The same secret again is no change (a fresh seal never equals the old one).
    if (
      clientSecret !== undefined &&
      !holdsSecret(this.box, owner, current, clientSecret)
    ) {
      return this.box.seal(clientSecret, secretContext(owner, provider));
    }
    if (current === undefined) {
      throw refusal(
        "SOCIAL_SECRET_REQUIRED",
        "A new social provider needs its clientSecret",
        400,
      );
    }
    return current.secret;
  }
}
