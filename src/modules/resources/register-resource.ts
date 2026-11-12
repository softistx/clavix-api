import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { userinfoOf } from "@/oauth/issuers";
import type { ResourcesFor } from "@/oauth/ports";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import {
  ClientInputError,
  type ClientTenant,
  SuspendedTenantError,
  UnknownTenantError,
} from "./errors";
import type { resources } from "./resources.model";

export { ClientInputError as ResourceInputError };

export interface RegisterResourceInput {
  /** The tenant's slug. */
  tenant: string;
  /** The resource's URI: the `aud` of its access tokens, and the key of idempotency. */
  uri: string;
  /** Default: the URI's host. */
  name?: string;
  /** What a client may request on it (at least one). Re-running replaces the list. */
  scopes: readonly string[];
}

export interface RegisteredResource {
  created: boolean;
  tenant: string;
  uri: string;
  name: string;
  scopes: readonly string[];
}

export interface RegisterResourceOptions {
  collection: TypedCollection<typeof resources>;
  findTenant: (slug: string) => Promise<ClientTenant | undefined>;
  /** The issuer of a tenant, to refuse its userinfo URL as a resource. */
  issuerOf: (slug: string) => string;
}

// Same shape as an OAuth scope token (RFC 6749 §3.3): printable ASCII, no
// space, quote or backslash.
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** The resource URI's problem (RFC 8707 §2: absolute, no fragment), or `null`. */
export function resourceUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "must be an absolute URI";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must be https (http only on a loopback host)";
  }
  if (url.hash !== "" || uri.includes("#")) return "must have no fragment";
  if (url.username !== "" || url.password !== "") {
    return "must carry no credentials";
  }
  return null;
}

function validate(input: RegisterResourceInput) {
  const uri = input.uri.trim();
  const problem = resourceUriProblem(uri);
  if (problem !== null) {
    throw new ClientInputError(`resource URI "${uri}": ${problem}`);
  }
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()))];
  if (scopes.length === 0 || scopes.includes("")) {
    throw new ClientInputError("a resource needs at least one scope");
  }
  for (const scope of scopes) {
    if (!SCOPE_PATTERN.test(scope)) {
      throw new ClientInputError(
        `scope "${scope}" must be printable ASCII without space, quote or backslash`,
      );
    }
  }
  const name = (input.name ?? new URL(uri).host).trim();
  if (name === "") throw new ClientInputError("a resource needs a name");
  return { uri, name, scopes };
}

/**
 * Registers a resource on a tenant, or updates it (idempotent on the URI: the
 * name and the scopes are replaced). Stored through the tenant's scope, so it
 * is that tenant's only. The tenant's own userinfo URL is refused: it is
 * built in and its scopes are the OpenID Connect ones.
 */
export async function registerResource(
  options: RegisterResourceOptions,
  input: RegisterResourceInput,
): Promise<RegisteredResource> {
  const { uri, name, scopes } = validate(input);
  const tenant = await options.findTenant(input.tenant);
  if (tenant === undefined) throw new UnknownTenantError(input.tenant);
  if (tenant.status !== "active") throw new SuspendedTenantError(tenant.slug);
  if (uri === userinfoOf(options.issuerOf(tenant.slug))) {
    throw new ClientInputError(
      `"${uri}" is the tenant's userinfo endpoint, a built-in resource`,
    );
  }
  const scoped = scopeToTenant(options.collection, tenant._id);
  const existing = await scoped.findFirst({ uri });
  if (existing === undefined) {
    await scoped.create({ uri, name, scopes });
  } else {
    await scoped.update(existing._id, { name, scopes });
  }
  return {
    created: existing === undefined,
    tenant: tenant.slug,
    uri,
    name,
    scopes,
  };
}

/**
 * The real `ResourcesFor`: a tenant's stored resources, read through its scope
 * (another tenant's are not visible), by URI.
 */
export const storedResourcesFor =
  (collection: TypedCollection<typeof resources>): ResourcesFor =>
  async (tenant: ResolvedTenant) => {
    const scoped = scopeToTenant(collection, new ObjectId(tenant.tenantId));
    const found = await scoped.findMany();
    return Object.fromEntries(
      found.map((resource) => [resource.uri, { scopes: resource.scopes }]),
    );
  };
