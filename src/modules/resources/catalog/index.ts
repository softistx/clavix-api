import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { resources } from "../resources.model";
import type { scopes } from "../scopes.model";
import type {
  DescriptionInput,
  ScopeInput,
  StoredResourceDoc,
  StoredScopeDoc,
} from "./input";
import {
  createResource,
  deleteResource,
  findResource,
  listResources,
  updateResource,
} from "./resources";
import {
  createScope,
  deleteScope,
  findScope,
  listScopes,
  replaceResourceScopes,
  updateScope,
} from "./scopes";

export type {
  Description,
  DescriptionInput,
  ScopeInput,
  StoredResourceDoc,
  StoredScopeDoc,
} from "./input";
export { scopeNamesByResource } from "./scopes";

export interface CatalogOptions {
  resources: TypedCollection<typeof resources>;
  scopes: TypedCollection<typeof scopes>;
  /** The tenant's userinfo URL, a built-in resource that cannot be registered. */
  userinfoOf: (tenantSlug: string) => string;
}

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

  listResources(tenantId: ObjectId): Promise<StoredResourceDoc[]> {
    return listResources(this.resourcesOf(tenantId));
  }

  findResource(
    tenantId: ObjectId,
    resourceId: string,
  ): Promise<StoredResourceDoc | undefined> {
    return findResource(this.resourcesOf(tenantId), resourceId);
  }

  listScopes(
    tenantId: ObjectId,
    filter: { resourceId?: ObjectId | null } = {},
  ): Promise<StoredScopeDoc[]> {
    return listScopes(this.scopesOf(tenantId), filter);
  }

  createResource(
    tenantId: ObjectId,
    tenantSlug: string,
    input: { uri: string; name?: string | undefined },
  ): Promise<StoredResourceDoc> {
    return createResource(
      this.resourcesOf(tenantId),
      this.options.userinfoOf(tenantSlug),
      input,
    );
  }

  updateResource(
    tenantId: ObjectId,
    resourceId: string,
    input: { name: string },
  ): Promise<StoredResourceDoc> {
    return updateResource(this.resourcesOf(tenantId), resourceId, input);
  }

  /** Deletes the resource and its scopes; `false` when it was not there. */
  deleteResource(tenantId: ObjectId, resourceId: string): Promise<boolean> {
    return deleteResource(
      this.resourcesOf(tenantId),
      this.scopesOf(tenantId),
      resourceId,
    );
  }

  findScope(
    tenantId: ObjectId,
    scopeId: string,
  ): Promise<StoredScopeDoc | undefined> {
    return findScope(this.scopesOf(tenantId), scopeId);
  }

  createScope(tenantId: ObjectId, input: ScopeInput): Promise<StoredScopeDoc> {
    return createScope(
      this.scopesOf(tenantId),
      (id) => this.findResource(tenantId, id),
      input,
    );
  }

  /** The name and the resource of a scope never change: tokens and clients carry them. */
  updateScope(
    tenantId: ObjectId,
    scopeId: string,
    input: {
      description?: DescriptionInput | undefined;
      claims?: readonly string[] | undefined;
    },
  ): Promise<StoredScopeDoc> {
    return updateScope(this.scopesOf(tenantId), scopeId, input);
  }

  /** `false` when it was not there. */
  deleteScope(tenantId: ObjectId, scopeId: string): Promise<boolean> {
    return deleteScope(this.scopesOf(tenantId), scopeId);
  }

  /** Makes `names` the scopes of the resource: see `replaceResourceScopes`. */
  replaceResourceScopes(
    tenantId: ObjectId,
    resource: ObjectId,
    names: readonly string[],
  ): Promise<void> {
    return replaceResourceScopes(this.scopesOf(tenantId), resource, names);
  }
}
