import {
  ConflictError,
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { CatalogError } from "./catalog.errors";
import { resourceUriProblem } from "./resource-uri";
import type { resources } from "./resources.model";
import { isOidcScope, OIDC_SCOPES, scopeNameProblem } from "./scope-name";
import type { scopes } from "./scopes.model";

export type StoredResourceDoc = ReadDocumentOf<typeof resources>;
export type StoredScopeDoc = ReadDocumentOf<typeof scopes>;

export interface Description {
  fr: string;
  en: string;
}

/** A text to set; a language left out (or `undefined`) is not touched. */
export interface DescriptionInput {
  fr?: string | undefined;
  en?: string | undefined;
}

export interface ScopeInput {
  name: string;
  description?: DescriptionInput | undefined;
  /** The resource it belongs to; `null` for a standard OpenID Connect scope. */
  resourceId?: string | null | undefined;
  claims?: readonly string[] | undefined;
}

export interface CatalogOptions {
  resources: TypedCollection<typeof resources>;
  scopes: TypedCollection<typeof scopes>;
  /** The tenant's userinfo URL, a built-in resource that cannot be registered. */
  userinfoOf: (tenantSlug: string) => string;
}

const sameUri = (a: string, b: string) => new URL(a).href === new URL(b).href;

const cleanClaims = (claims: readonly string[] | undefined) => [
  ...new Set((claims ?? []).map((claim) => claim.trim())),
];

/**
 * A tenant's resources and scopes, for the console (ADR-0025): each call takes
 * the tenant's id and reads and writes through its scope, so another tenant's
 * document is "not found". Scopes are documents of their own; a resource's
 * scopes are the ones that point to it. Deleting is idempotent (`false` when
 * nothing was there), creating a name or URI twice is a `CONFLICT`.
 */
export class Catalog {
  constructor(private readonly options: CatalogOptions) {}

  private resourcesOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.resources, tenantId);
  }

  private scopesOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.scopes, tenantId);
  }

  async listResources(tenantId: ObjectId): Promise<StoredResourceDoc[]> {
    const found = await this.resourcesOf(tenantId).findMany();
    return found.sort((a, b) => a.uri.localeCompare(b.uri));
  }

  async findResource(
    tenantId: ObjectId,
    resourceId: string,
  ): Promise<StoredResourceDoc | undefined> {
    if (!ObjectId.isValid(resourceId)) return undefined;
    return this.resourcesOf(tenantId).findById(new ObjectId(resourceId));
  }

  async listScopes(
    tenantId: ObjectId,
    filter: { resourceId?: ObjectId | null } = {},
  ): Promise<StoredScopeDoc[]> {
    const found = await this.scopesOf(tenantId).findMany(
      filter.resourceId === undefined
        ? {}
        : { filter: { resourceId: filter.resourceId } },
    );
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createResource(
    tenantId: ObjectId,
    tenantSlug: string,
    input: { uri: string; name?: string | undefined },
  ): Promise<StoredResourceDoc> {
    const uri = input.uri.trim();
    const problem = resourceUriProblem(uri);
    if (problem !== null) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `resource URI "${uri}": ${problem}`,
      );
    }
    const canonical = new URL(uri).href;
    if (canonical !== uri) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `resource URI "${uri}" is not in canonical form: write it as ${canonical}`,
      );
    }
    if (sameUri(uri, this.options.userinfoOf(tenantSlug))) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `"${uri}" is the tenant's userinfo endpoint, a built-in resource`,
      );
    }
    const name = (input.name ?? new URL(uri).host).trim();
    if (name === "") {
      throw new CatalogError("BAD_USER_INPUT", "a resource needs a name");
    }
    try {
      return await this.resourcesOf(tenantId).create({ uri, name });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new CatalogError(
          "CONFLICT",
          `A resource already has the URI "${uri}"`,
        );
      }
      throw error;
    }
  }

  async updateResource(
    tenantId: ObjectId,
    resourceId: string,
    input: { name: string },
  ): Promise<StoredResourceDoc> {
    const existing = await this.findResource(tenantId, resourceId);
    if (existing === undefined) {
      throw new CatalogError("NOT_FOUND", "No such resource");
    }
    const name = input.name.trim();
    if (name === "") {
      throw new CatalogError("BAD_USER_INPUT", "a resource needs a name");
    }
    return this.resourcesOf(tenantId).update(existing._id, { name });
  }

  /** Deletes the resource and its scopes; `false` when it was not there. */
  async deleteResource(
    tenantId: ObjectId,
    resourceId: string,
  ): Promise<boolean> {
    const existing = await this.findResource(tenantId, resourceId);
    if (existing === undefined) return false;
    await this.scopesOf(tenantId).hardDeleteMany({ resourceId: existing._id });
    await this.resourcesOf(tenantId).hardDeleteMany({ _id: existing._id });
    return true;
  }

  async findScope(
    tenantId: ObjectId,
    scopeId: string,
  ): Promise<StoredScopeDoc | undefined> {
    if (!ObjectId.isValid(scopeId)) return undefined;
    return this.scopesOf(tenantId).findById(new ObjectId(scopeId));
  }

  async createScope(
    tenantId: ObjectId,
    input: ScopeInput,
  ): Promise<StoredScopeDoc> {
    const name = input.name.trim();
    const problem =
      name === "" ? "a scope needs a name" : scopeNameProblem(name);
    if (problem !== null) throw new CatalogError("BAD_USER_INPUT", problem);
    let resourceId: ObjectId | null = null;
    if (input.resourceId !== undefined && input.resourceId !== null) {
      const resource = await this.findResource(tenantId, input.resourceId);
      if (resource === undefined) {
        throw new CatalogError("NOT_FOUND", "No such resource");
      }
      resourceId = resource._id;
    }
    // A scope with no resource is a standard one (it only carries its texts
    // and claims: the userinfo resource serves it); a resource never owns one.
    if (resourceId === null && !isOidcScope(name)) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `scope "${name}" needs a resource: only ${OIDC_SCOPES.join(", ")} have none`,
      );
    }
    if (resourceId !== null && isOidcScope(name)) {
      throw new CatalogError(
        "BAD_USER_INPUT",
        `scope "${name}" is a standard OpenID Connect scope: it belongs to no resource`,
      );
    }
    try {
      return await this.scopesOf(tenantId).create({
        name,
        description: {
          fr: input.description?.fr?.trim() ?? "",
          en: input.description?.en?.trim() ?? "",
        },
        resourceId,
        claims: cleanClaims(input.claims),
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new CatalogError(
          "CONFLICT",
          `A scope is already named "${name}"`,
        );
      }
      throw error;
    }
  }

  /** The name and the resource of a scope never change: tokens and clients carry them. */
  async updateScope(
    tenantId: ObjectId,
    scopeId: string,
    input: {
      description?: DescriptionInput | undefined;
      claims?: readonly string[] | undefined;
    },
  ): Promise<StoredScopeDoc> {
    const existing = await this.findScope(tenantId, scopeId);
    if (existing === undefined) {
      throw new CatalogError("NOT_FOUND", "No such scope");
    }
    return this.scopesOf(tenantId).update(existing._id, {
      description: {
        fr: input.description?.fr?.trim() ?? existing.description.fr,
        en: input.description?.en?.trim() ?? existing.description.en,
      },
      claims:
        input.claims === undefined
          ? existing.claims
          : cleanClaims(input.claims),
    });
  }

  /** `false` when it was not there. */
  async deleteScope(tenantId: ObjectId, scopeId: string): Promise<boolean> {
    const existing = await this.findScope(tenantId, scopeId);
    if (existing === undefined) return false;
    await this.scopesOf(tenantId).hardDeleteMany({ _id: existing._id });
    return true;
  }

  /**
   * Makes `names` the scopes of the resource (the `resources:create` script's
   * meaning of "the scopes are replaced"): missing ones are created with empty
   * texts, the others keep theirs, the rest are removed. A name another
   * resource owns is refused.
   */
  async replaceResourceScopes(
    tenantId: ObjectId,
    resource: ObjectId,
    names: readonly string[],
  ): Promise<void> {
    const scoped = this.scopesOf(tenantId);
    const all = await scoped.findMany();
    for (const name of names) {
      if (isOidcScope(name)) {
        throw new CatalogError(
          "BAD_USER_INPUT",
          `scope "${name}" is a standard OpenID Connect scope: it belongs to no resource`,
        );
      }
      const owner = all.find((scope) => scope.name === name);
      if (owner !== undefined && !owner.resourceId?.equals(resource)) {
        throw new CatalogError(
          "CONFLICT",
          `scope "${name}" already belongs to another resource or is a standard scope`,
        );
      }
    }
    const own = all.filter((scope) => scope.resourceId?.equals(resource));
    for (const scope of own) {
      if (!names.includes(scope.name)) {
        await scoped.hardDeleteMany({ _id: scope._id });
      }
    }
    for (const name of names) {
      if (own.some((scope) => scope.name === name)) continue;
      try {
        await scoped.create({
          name,
          description: { fr: "", en: "" },
          resourceId: resource,
          claims: [],
        });
      } catch (error) {
        // A concurrent run created it: it is ours then (same resource).
        if (!(error instanceof ConflictError)) throw error;
      }
    }
  }

  /** The scope names by resource id (hex) of a tenant: what the token server serves. */
  async scopeNamesByResource(
    tenantId: ObjectId,
  ): Promise<Map<string, string[]>> {
    const byResource = new Map<string, string[]>();
    for (const scope of await this.scopesOf(tenantId).findMany()) {
      if (scope.resourceId === null) continue;
      const key = scope.resourceId.toHexString();
      byResource.set(key, [...(byResource.get(key) ?? []), scope.name]);
    }
    return byResource;
  }
}
