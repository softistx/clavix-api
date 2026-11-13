import { OptimisticLockError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { Tenant } from "@/modules/tenants/tenants.model";
import type { TenantsService } from "@/modules/tenants/tenants.service";
import { type SecretBox, secretContext } from "./secrets";
import {
  hasSignInMethod,
  isAvailable,
  type MethodEntry,
  type MethodType,
  methodsOf,
  type SignInPolicy,
  type SocialEntry,
  type SocialProviderId,
} from "./sign-in.schema";

const refusal = (code: string, message: string, status: number) =>
  new GraphQLError(message, { extensions: { code, http: { status } } });

const badInput = (message: string) => refusal("BAD_USER_INPUT", message, 400);

/** The change a tenant makes to one social app. A value left out keeps the stored one. */
export interface SocialInput {
  provider: SocialProviderId;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  enabled?: boolean | undefined;
}

const MAX = 512;

/** The methods that need no outside provider. */
const FIRST_PARTY: readonly MethodType[] = ["passkey", "emailCode"];

function checked(name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX) {
    throw badInput(`${name} must be 1 to ${MAX} characters`);
  }
  return trimmed;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

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
    private readonly box: SecretBox,
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
    const change = new Map(entries.map(({ type, enabled }) => [type, enabled]));
    if (change.size !== entries.length) {
      throw badInput("A sign-in method is given twice");
    }
    for (const { type, enabled } of entries) {
      if (enabled && !isAvailable(type)) {
        throw refusal(
          "SIGN_IN_METHOD_UNAVAILABLE",
          `Sign-in by ${type} is not available yet`,
          409,
        );
      }
    }
    await this.get(tenantId);
    return this.write(tenantId, ({ signIn, slug }) => {
      const current = methodsOf(signIn);
      const methods = current.map(({ type, enabled }) => ({
        type,
        enabled: change.get(type) ?? enabled,
      }));
      if (same(methods, current)) return null;
      const next = { ...signIn, methods };
      if (slug === PLATFORM_TENANT_SLUG) this.firstParty(next);
      return this.usable(next);
    });
  }

  /** Sets the tenant's own app for a provider, sealing a secret that is given. */
  async setSocial(tenantId: string, input: SocialInput): Promise<Tenant> {
    const clientId =
      input.clientId === undefined
        ? undefined
        : checked("clientId", input.clientId);
    const clientSecret =
      input.clientSecret === undefined
        ? undefined
        : checked("clientSecret", input.clientSecret);
    await this.get(tenantId);
    return this.write(tenantId, ({ _id, signIn }) => {
      // The stored tenant's own id binds the secret, not the caller's string.
      const owner = _id.toHexString();
      const current = signIn.social.find(
        (entry) => entry.provider === input.provider,
      );
      const id = clientId ?? current?.clientId;
      if (id === undefined) throw badInput("clientId is required");
      // The same secret again is no change (a fresh seal never equals the old one).
      const secret =
        clientSecret === undefined || this.holds(owner, current, clientSecret)
          ? current?.secret
          : this.box.seal(clientSecret, secretContext(owner, input.provider));
      if (secret === undefined) {
        throw refusal(
          "SOCIAL_SECRET_REQUIRED",
          "A new social provider needs its clientSecret",
          400,
        );
      }
      const entry: SocialEntry = {
        provider: input.provider,
        clientId: id,
        secret,
        enabled: input.enabled ?? current?.enabled ?? true,
      };
      if (current !== undefined && same(current, entry)) return null;
      const social = [
        ...signIn.social.filter((e) => e.provider !== input.provider),
        entry,
      ].sort((a, b) => a.provider.localeCompare(b.provider));
      return this.usable({ ...signIn, social });
    });
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
      return this.usable({ ...signIn, social });
    });
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

  /** Whether the stored entry already holds this secret. */
  private holds(
    tenantId: string,
    current: SocialEntry | undefined,
    secret: string,
  ): boolean {
    if (current === undefined) return false;
    try {
      return (
        this.box.open(
          current.secret,
          secretContext(tenantId, current.provider),
        ) === secret
      );
    } catch {
      return false;
    }
  }

  /**
   * The platform tenant signs the console's operators in, so it always keeps
   * a first-party method (passkey or e-mail code), whatever social providers
   * it has: those depend on an outside provider.
   */
  private firstParty(policy: SignInPolicy): void {
    const methods = methodsOf(policy);
    if (!methods.some((m) => m.enabled && FIRST_PARTY.includes(m.type))) {
      throw refusal(
        "PLATFORM_FIRST_PARTY_METHOD",
        "The platform tenant must keep passkey or e-mail code sign-in enabled",
        409,
      );
    }
  }

  /** A tenant keeps at least one way for its users to sign in. */
  private usable(policy: SignInPolicy): SignInPolicy {
    if (!hasSignInMethod(policy)) {
      throw refusal(
        "NO_SIGN_IN_METHOD",
        "At least one sign-in method must stay enabled",
        409,
      );
    }
    return policy;
  }
}
