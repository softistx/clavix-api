import {
  ConflictError,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import {
  CliInputError,
  type CliTenant,
  SuspendedTenantError,
  UnknownTenantError,
} from "@/cli/errors";
import { userinfoOf } from "@/oauth/building";
import type { ResourcesFor } from "@/oauth/ports";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { Catalog, scopeNamesByResource } from "./catalog";
import { CatalogError } from "./catalog.errors";
import { detailTypesByResource } from "./detail-types";
import type { detailTypes } from "./detail-types/detail-types.model";
import { resourceUriProblem } from "./resource-uri";
import type { resources } from "./resources.model";
import { scopeNameProblem } from "./scope-name";
import type { scopes } from "./scopes.model";

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
  /** The tenant's `Scope` documents: the resource's scopes are stored there. */
  scopes: TypedCollection<typeof scopes>;
  findTenant: (slug: string) => Promise<CliTenant | undefined>;
  /** The issuer of a tenant, to refuse its userinfo URL as a resource. */
  issuerOf: (slug: string) => string;
}

export { resourceUriProblem };

// Two spellings of one URL (case of scheme and host, default port, empty path,
// dot segments) are the same resource.
const sameUri = (a: string, b: string) => new URL(a).href === new URL(b).href;

function validate(input: RegisterResourceInput) {
  const uri = input.uri.trim();
  const problem = resourceUriProblem(uri);
  if (problem !== null) {
    throw new CliInputError(`resource URI "${uri}": ${problem}`);
  }
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()))];
  if (scopes.length === 0 || scopes.includes("")) {
    throw new CliInputError("a resource needs at least one scope");
  }
  for (const scope of scopes) {
    const scopeProblem = scopeNameProblem(scope);
    if (scopeProblem !== null) throw new CliInputError(scopeProblem);
  }
  const name = (input.name ?? new URL(uri).host).trim();
  if (name === "") throw new CliInputError("a resource needs a name");
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
  if (sameUri(uri, userinfoOf(options.issuerOf(tenant.slug)))) {
    throw new CliInputError(
      `"${uri}" is the tenant's userinfo endpoint, a built-in resource`,
    );
  }
  // Refuse rather than rewrite: `.href` adds "/" to a bare origin, which would
  // change the audience the clients already request.
  const canonical = new URL(uri).href;
  if (canonical !== uri) {
    throw new CliInputError(
      `resource URI "${uri}" is not in canonical form: write it as ${canonical}`,
    );
  }
  const scoped = scopeToTenant(options.collection, tenant._id);
  let existing = await scoped.findFirst({ uri });
  let created = existing === undefined;
  if (existing === undefined) {
    try {
      existing = await scoped.create({ uri, name });
    } catch (error) {
      // A concurrent run created it between our read and write (the unique
      // index refused): read it again and update it like any re-run.
      if (!(error instanceof ConflictError)) throw error;
      existing = await scoped.findFirst({ uri });
      if (existing === undefined) throw error;
      created = false;
      await scoped.update(existing._id, { name });
    }
  } else {
    await scoped.update(existing._id, { name });
  }
  const catalog = new Catalog({
    resources: options.collection,
    scopes: options.scopes,
    userinfoOf: (slug) => userinfoOf(options.issuerOf(slug)),
  });
  try {
    await catalog.replaceResourceScopes(tenant._id, existing._id, scopes);
  } catch (error) {
    if (error instanceof CatalogError) throw new CliInputError(error.message);
    throw error;
  }
  return { created, tenant: tenant.slug, uri, name, scopes };
}

/**
 * The real `ResourcesFor`: a tenant's stored resources, read through its scope
 * (another tenant's are not visible), by URI: its scopes and its compiled
 * authorization detail types (RFC 9396).
 */
export const storedResourcesFor =
  (
    collection: TypedCollection<typeof resources>,
    scopeDocs: TypedCollection<typeof scopes>,
    typeDocs: TypedCollection<typeof detailTypes>,
  ): ResourcesFor =>
  async (tenant: ResolvedTenant) => {
    const tenantId = new ObjectId(tenant.tenantId);
    const found = await scopeToTenant(collection, tenantId).findMany();
    const byResource = await scopeNamesByResource(scopeDocs, tenantId);
    const typesByResource = await detailTypesByResource(typeDocs, tenantId);
    return Object.fromEntries(
      found.map((resource) => {
        const key = resource._id.toHexString();
        const authorizationDetails = typesByResource.get(key);
        return [
          resource.uri,
          {
            scopes: byResource.get(key) ?? [],
            ...(authorizationDetails === undefined
              ? {}
              : { authorizationDetails }),
          },
        ];
      }),
    );
  };
