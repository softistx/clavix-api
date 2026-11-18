import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { CatalogError } from "../catalog.errors";
import type { DetailTypeClients } from "../detail-types/client-lists";
import type { detailTypes } from "../detail-types/detail-types.model";
import type { resources } from "../resources.model";
import type { scopes } from "../scopes.model";
import {
  createDetailType,
  type DetailTypeDraft,
  type DetailTypePatch,
  deleteDetailType,
  findDetailType,
  listDetailTypes,
  updateDetailType,
} from "./detail-types";
import type {
  DescriptionInput,
  ScopeInput,
  StoredDetailTypeDoc,
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
  DetailTypeDraft,
  DetailTypePatch,
  FieldDraft,
  ValueDraft,
} from "./detail-types";
export type {
  Description,
  DescriptionInput,
  ScopeInput,
  StoredDetailTypeDoc,
  StoredResourceDoc,
  StoredScopeDoc,
} from "./input";
export { scopeNamesByResource } from "./scopes";

export interface CatalogOptions {
  resources: TypedCollection<typeof resources>;
  scopes: TypedCollection<typeof scopes>;
  detailTypes: TypedCollection<typeof detailTypes>;
  /** The clients' lists of detail types (D6, and the pruning of a deleted resource's). */
  clients: DetailTypeClients;
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

  private typesOf(tenantId: ObjectId) {
    return scopeToTenant(this.options.detailTypes, tenantId);
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

  /**
   * Deletes the resource, its scopes and its detail types (which leave the
   * clients' lists); `false` when it was not there.
   */
  deleteResource(tenantId: ObjectId, resourceId: string): Promise<boolean> {
    return deleteResource(
      this.resourcesOf(tenantId),
      this.scopesOf(tenantId),
      resourceId,
      {
        own: this.typesOf(tenantId),
        clients: this.options.clients,
        tenantId,
      },
    );
  }

  /** The detail types of the tenant, or of one resource, by type name. */
  listDetailTypes(
    tenantId: ObjectId,
    filter: { resourceId?: ObjectId } = {},
  ): Promise<StoredDetailTypeDoc[]> {
    return listDetailTypes(
      this.options.detailTypes,
      tenantId,
      filter.resourceId,
    );
  }

  findDetailType(
    tenantId: ObjectId,
    id: string,
  ): Promise<StoredDetailTypeDoc | undefined> {
    return findDetailType(this.typesOf(tenantId), id);
  }

  /**
   * A detail type of one of the tenant's resources (another tenant's is "no
   * such resource"). The name is unique in the tenant: a repeat is `CONFLICT`.
   */
  async createDetailType(
    tenantId: ObjectId,
    resourceId: string,
    draft: DetailTypeDraft,
  ): Promise<StoredDetailTypeDoc> {
    const resource = await this.findResource(tenantId, resourceId);
    if (resource === undefined) {
      throw new CatalogError("NOT_FOUND", "No such resource");
    }
    return createDetailType(
      this.options.detailTypes,
      tenantId,
      resource._id,
      draft,
    );
  }

  /** The type name and the resource never change; nothing is written when nothing changes. */
  updateDetailType(
    tenantId: ObjectId,
    id: string,
    patch: DetailTypePatch,
  ): Promise<StoredDetailTypeDoc> {
    return updateDetailType(this.options.detailTypes, tenantId, id, patch);
  }

  /** `false` when it was not there; `DETAIL_TYPE_IN_USE` while a client lists it. */
  deleteDetailType(tenantId: ObjectId, id: string): Promise<boolean> {
    return deleteDetailType(
      this.typesOf(tenantId),
      this.options.clients,
      tenantId,
      id,
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
