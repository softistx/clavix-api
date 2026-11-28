import {
  ConflictError,
  type ReadDocumentOf,
  type Scoped,
  scopeToTenant,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { ResourcesFor } from "@/oauth/ports";
import {
  CliInputError,
  SuspendedTenantError,
  UnknownTenantError,
} from "@/shared/cli";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { compileDetailType } from "./resources.compile";
import {
  type DetailTypeDefinition,
  detailTypeProblem,
} from "./resources.compile-rules";
import { canon, cleanDetailType } from "./resources.detail-rules";
import { CatalogError, refuse } from "./resources.errors";
import type { detailTypes, resources, scopes } from "./resources.model";
import {
  checkCanonicalRegistration,
  checkRegistration,
  checkResourceUri,
  checkScopeName,
  cleanClaims,
  cleanName,
  isOidcScope,
  listed,
  SCRIPT_ACTOR,
  MAX_DESCRIPTION,
  MAX_LABEL,
  MAX_LISTED,
  OIDC_SCOPES,
  sameScopeDefinition,
} from "./resources.rules";
import {
  cleanTranslations,
  mergeTranslations,
} from "./resources.translation-rules";
import type {
  CompiledDetailTypes,
  DetailTypeDraft,
  DetailTypeInput,
  DetailTypePatch,
  RegisteredResource,
  RegisterResourceInput,
  ResourcesServiceOptions,
  ScopeInput,
  StoredDetailTypeDoc,
  StoredResourceDoc,
  StoredScopeDoc,
  Texts,
} from "./resources.types";

type OwnResources = Scoped<typeof resources>;
type OwnScopes = Scoped<typeof scopes>;
type OwnTypes = Scoped<typeof detailTypes>;

/**
 * A tenant's resources, scopes and authorization detail types (ADR-0025,
 * RAR D1/D2/D6): the single writer of the three, for the console and the
 * `resources:create` script. Each call takes the tenant's id and reads and
 * writes through its scope, so another tenant's document is "not found".
 * Scopes are documents of their own; a resource's scopes are the ones that
 * point to it. Deleting is idempotent (`false` when nothing was there),
 * creating a name or URI twice is a `CONFLICT`.
 */
export class ResourcesService {
  constructor(private readonly options: ResourcesServiceOptions) {}

  private resourcesOf(tenantId: ObjectId): OwnResources {
    return scopeToTenant(this.options.resources, tenantId);
  }

  private scopesOf(tenantId: ObjectId): OwnScopes {
    return scopeToTenant(this.options.scopes, tenantId);
  }

  private typesOf(tenantId: ObjectId): OwnTypes {
    return scopeToTenant(this.options.detailTypes, tenantId);
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

  /** `userinfoOf(tenantSlug)` is the tenant's built-in resource, which cannot be registered. */
  async createResource(
    tenantId: ObjectId,
    tenantSlug: string,
    input: { uri: string; name?: string | undefined },
  ): Promise<StoredResourceDoc> {
    const uri = checkResourceUri(
      input.uri,
      this.options.userinfoOf(tenantSlug),
    );
    const name = cleanName(input.name ?? new URL(uri).host);
    const own = this.resourcesOf(tenantId);
    try {
      return await own.create({ uri, name });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // A repeat of a call whose audit record failed: the stored resource
      // is returned when it is the one asked for.
      const [existing] = await own.findMany({ filter: { uri } });
      if (existing !== undefined && existing.name === name) return existing;
      throw new CatalogError(
        "CONFLICT",
        `A resource already has the URI "${uri}"`,
      );
    }
  }

  async updateResource(
    tenantId: ObjectId,
    resourceId: string,
    input: {
      name?: string | undefined;
      allowClientCredentials?: boolean | undefined;
    },
  ): Promise<StoredResourceDoc> {
    const existing = await this.findResource(tenantId, resourceId);
    if (existing === undefined) {
      throw new CatalogError("NOT_FOUND", "No such resource");
    }
    return this.resourcesOf(tenantId).update(existing._id, {
      name: input.name === undefined ? existing.name : cleanName(input.name),
      ...(input.allowClientCredentials === undefined
        ? {}
        : { allowClientCredentials: input.allowClientCredentials }),
    });
  }

  /**
   * Deletes the resource, its scopes and its detail types (which leave the
   * clients' lists); `false` when it was not there.
   */
  async deleteResource(
    tenantId: ObjectId,
    resourceId: string,
  ): Promise<boolean> {
    const existing = await this.findResource(tenantId, resourceId);
    if (existing === undefined) return false;
    // Its detail types leave the clients' lists first (as A4 prunes exchange
    // targets), then go: were the types gone before, a retry would find
    // nothing to prune.
    const types = this.typesOf(tenantId);
    const typeDocs = await types.findMany({
      filter: { resourceId: existing._id },
    });
    await this.options.clients.drop(
      tenantId,
      typeDocs.map((doc) => doc.type),
    );
    await types.hardDeleteMany({ resourceId: existing._id });
    await this.scopesOf(tenantId).hardDeleteMany({ resourceId: existing._id });
    await this.resourcesOf(tenantId).hardDeleteMany({ _id: existing._id });
    return true;
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

  /** The scopes of the tenant among `ids`; an id that names none is left out. */
  async findScopes(
    tenantId: ObjectId,
    ids: readonly ObjectId[],
  ): Promise<StoredScopeDoc[]> {
    if (ids.length === 0) return [];
    return this.scopesOf(tenantId).findMany({
      filter: { _id: { $in: [...ids] } },
    });
  }

  async findScope(
    tenantId: ObjectId,
    scopeId: string,
  ): Promise<StoredScopeDoc | undefined> {
    if (!ObjectId.isValid(scopeId)) return undefined;
    return this.scopesOf(tenantId).findById(new ObjectId(scopeId));
  }

  /** The resource a new scope belongs to: `null` for a standard OpenID Connect one. */
  private async resourceOfScope(
    tenantId: ObjectId,
    name: string,
    resourceId: string | null | undefined,
  ): Promise<ObjectId | null> {
    if (resourceId === undefined || resourceId === null) {
      // A scope with no resource is a standard one (it only carries its texts
      // and claims: the userinfo resource serves it); a resource never owns one.
      if (isOidcScope(name)) return null;
      throw new CatalogError(
        "BAD_USER_INPUT",
        `scope "${name}" needs a resource: only ${OIDC_SCOPES.join(", ")} have none`,
      );
    }
    const resource = await this.findResource(tenantId, resourceId);
    if (resource === undefined) {
      throw new CatalogError("NOT_FOUND", "No such resource");
    }
    return resource._id;
  }

  async createScope(
    tenantId: ObjectId,
    input: ScopeInput,
  ): Promise<StoredScopeDoc> {
    const name = checkScopeName(input.name);
    const resourceId = await this.resourceOfScope(
      tenantId,
      name,
      input.resourceId,
    );
    const description = cleanTranslations(
      input.description,
      MAX_DESCRIPTION,
      "a description",
    );
    const claims = cleanClaims(input.claims);
    const own = this.scopesOf(tenantId);
    try {
      return await own.create({ name, description, resourceId, claims });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // A repeat of a call whose audit record failed: the stored scope is
      // returned when it is the one asked for.
      const [existing] = await own.findMany({ filter: { name, resourceId } });
      if (
        existing !== undefined &&
        sameScopeDefinition(existing, description, claims)
      ) {
        return existing;
      }
      throw new CatalogError(
        "CONFLICT",
        resourceId === null
          ? `The standard scope "${name}" is already described`
          : `The resource already has a scope named "${name}"`,
      );
    }
  }

  /**
   * Changes a scope's texts, claims and, for a resource's scope, its name. A
   * standard OpenID Connect scope keeps its name; a rename is refused
   * (`SCOPE_IN_USE`) while a client lists the old name, since clients and
   * tokens carry names. Roles hold scope ids, so they follow a rename.
   */
  async updateScope(
    tenantId: ObjectId,
    scopeId: string,
    input: {
      name?: string | undefined;
      description?: Texts | undefined;
      claims?: readonly string[] | undefined;
    },
  ): Promise<{ scope: StoredScopeDoc; renamed: boolean }> {
    const existing = await this.findScope(tenantId, scopeId);
    if (existing === undefined) {
      throw new CatalogError("NOT_FOUND", "No such scope");
    }
    const name = await this.renamed(tenantId, existing, input.name);
    let scope: StoredScopeDoc;
    try {
      scope = await this.scopesOf(tenantId).update(existing._id, {
        name,
        description: mergeTranslations(
          existing.description,
          input.description,
          MAX_DESCRIPTION,
          "a description",
        ),
        claims:
          input.claims === undefined
            ? existing.claims
            : cleanClaims(input.claims),
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      throw new CatalogError(
        "CONFLICT",
        `The resource already has a scope named "${name}"`,
        "name",
      );
    }
    const renamed = name !== existing.name;
    if (renamed) await this.recheckClients(tenantId, existing, scope);
    return { scope, renamed };
  }

  /**
   * A client may have been updated to list the old name between the check and
   * the write: look again, and put the old name back if so.
   */
  private async recheckClients(
    tenantId: ObjectId,
    existing: StoredScopeDoc,
    renamed: StoredScopeDoc,
  ): Promise<void> {
    const late = await this.clientsListing(tenantId, existing.name);
    if (late.ids.length === 0) return;
    // Only while the scope still carries the new name; a failed revert is
    // logged (ids only) and the refusal still says why.
    try {
      await this.scopesOf(tenantId).updateMany(
        { _id: renamed._id, name: renamed.name },
        { $set: { name: existing.name } },
      );
    } catch {
      this.options.warn(
        `scope ${renamed._id.toHexString()} of tenant ${tenantId.toHexString()} kept its new name: a client listed the old one and the revert failed`,
      );
    }
    throw this.scopeInUse(existing.name, late);
  }

  private async clientsListing(tenantId: ObjectId, name: string) {
    return listed(
      await this.options.scopeClients.listing(tenantId, name, MAX_LISTED + 1),
    );
  }

  private scopeInUse(
    name: string,
    clients: { ids: string[]; truncated: boolean },
  ) {
    return new CatalogError(
      "SCOPE_IN_USE",
      `The scope "${name}" is listed by ${clients.truncated ? "more than " : ""}${clients.ids.length} client(s): remove it from their lists first`,
      undefined,
      { clients: clients.ids, truncated: clients.truncated },
    );
  }

  /** The name the scope ends with: a rename is checked here (see `updateScope`). */
  private async renamed(
    tenantId: ObjectId,
    existing: StoredScopeDoc,
    asked: string | undefined,
  ): Promise<string> {
    if (asked === undefined) return existing.name;
    const name = checkScopeName(asked);
    if (name === existing.name) return name;
    if (existing.resourceId === null) {
      refuse(`The standard scope "${existing.name}" cannot be renamed`, "name");
    }
    const clients = await this.clientsListing(tenantId, existing.name);
    if (clients.ids.length > 0) throw this.scopeInUse(existing.name, clients);
    return name;
  }

  /** `false` when it was not there. */
  async deleteScope(
    tenantId: ObjectId,
    scopeId: string,
    actor: string,
  ): Promise<boolean> {
    const existing = await this.findScope(tenantId, scopeId);
    if (existing === undefined) return false;
    const roles = listed(
      await this.options.rolesGranting(tenantId, existing._id, MAX_LISTED + 1),
    );
    if (roles.ids.length > 0) {
      throw new CatalogError(
        "PERMISSION_IN_USE",
        `The scope "${existing.name}" is granted by ${roles.truncated ? "more than " : ""}${roles.ids.length} role(s): remove it from their permissions first`,
        undefined,
        { roles: roles.ids, truncated: roles.truncated },
      );
    }
    await this.scopesOf(tenantId).hardDeleteMany({ _id: existing._id });
    // A setRolePermissions may have granted it between the check and the
    // delete: pull the dangling id with the cascade's atomic $pull.
    const late = await this.options.rolesGranting(tenantId, existing._id, 1);
    if (late.length > 0)
      await this.options.scopesDropped(tenantId, [existing._id], actor);
    return true;
  }

  /**
   * Makes `names` the scopes of the resource (the `resources:create` script's
   * meaning of "the scopes are replaced"): missing ones are created with empty
   * texts, the others keep theirs, the rest are removed.
   */
  async replaceResourceScopes(
    tenantId: ObjectId,
    resource: ObjectId,
    names: readonly string[],
  ): Promise<void> {
    const own = this.scopesOf(tenantId);
    const current = await own.findMany({ filter: { resourceId: resource } });
    const dropped = current.filter((scope) => !names.includes(scope.name));
    if (dropped.length > 0) {
      // Before the delete, as a deleted resource's: a retry still finds them.
      await this.options.scopesDropped(
        tenantId,
        dropped.map((scope) => scope._id),
        SCRIPT_ACTOR,
      );
    }
    for (const scope of dropped) {
      await own.hardDeleteMany({ _id: scope._id });
    }
    for (const name of names) {
      if (current.some((scope) => scope.name === name)) continue;
      try {
        await own.create({
          name,
          description: [],
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

  /** The detail types of the tenant, or of one resource, by type name. */
  async listDetailTypes(
    tenantId: ObjectId,
    filter: { resourceId?: ObjectId } = {},
  ): Promise<StoredDetailTypeDoc[]> {
    const found = await this.typesOf(tenantId).findMany(
      filter.resourceId === undefined
        ? {}
        : { filter: { resourceId: filter.resourceId } },
    );
    return found.sort((a, b) => a.type.localeCompare(b.type));
  }

  async findDetailType(
    tenantId: ObjectId,
    id: string,
  ): Promise<StoredDetailTypeDoc | undefined> {
    if (!ObjectId.isValid(id)) return undefined;
    return this.typesOf(tenantId).findById(new ObjectId(id));
  }

  /**
   * The compiled detail types of a tenant by resource id (hex): what the token
   * server serves. A stored definition the compiler refuses (written by hand,
   * or before a bound tightened) is left out rather than failing the issuer.
   */
  async compiledDetailTypes(
    tenantId: ObjectId,
  ): Promise<Map<string, CompiledDetailTypes>> {
    const byResource = new Map<string, CompiledDetailTypes>();
    for (const doc of await this.typesOf(tenantId).findMany()) {
      const definition: DetailTypeDefinition = doc;
      if (detailTypeProblem(definition) !== null) continue;
      const key = doc.resourceId.toHexString();
      const own = byResource.get(key) ?? {};
      own[doc.type] = { schema: compileDetailType(definition) };
      byResource.set(key, own);
    }
    return byResource;
  }

  /**
   * Stores a detail type of a resource: the definition must compile, and the
   * name is unique in the tenant (D2), so a name already taken, by this
   * resource or another, is a `CONFLICT` unless `replace` is set and it is
   * this resource's own.
   */
  async saveDetailType(
    tenantId: ObjectId,
    resourceId: ObjectId,
    input: DetailTypeInput,
    options: { replace?: boolean } = {},
  ): Promise<ReadDocumentOf<typeof detailTypes>> {
    const problem = detailTypeProblem(input);
    if (problem !== null) throw new CatalogError("BAD_USER_INPUT", problem);
    const own = this.typesOf(tenantId);
    const taken = new CatalogError(
      "CONFLICT",
      `The detail type "${input.type}" already exists`,
    );
    const existing = await own.findFirst({ type: input.type });
    if (existing !== undefined) {
      if (options.replace !== true || !existing.resourceId.equals(resourceId)) {
        throw taken;
      }
      // `update` merges: a dropped list is written as empty, never left behind.
      return own.update(existing._id, {
        ...input,
        actions: input.actions ?? [],
      });
    }
    try {
      return await own.create({ ...input, resourceId });
    } catch (error) {
      throw error instanceof ConflictError ? taken : error;
    }
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
    const input = cleanDetailType(draft);
    // A repeat of a call whose audit record failed: the stored type is
    // returned when it is this resource's, with the same definition (the
    // caller records the event the first run missed). Anything else stays a
    // CONFLICT.
    const existing = await this.typesOf(tenantId).findFirst({
      type: input.type,
    });
    if (
      existing?.resourceId.equals(resource._id) &&
      canon(input) === canon(existing)
    ) {
      return existing;
    }
    return this.saveDetailType(tenantId, resource._id, input);
  }

  /** The type name and the resource never change; nothing is written when nothing changes. */
  async updateDetailType(
    tenantId: ObjectId,
    id: string,
    patch: DetailTypePatch,
  ): Promise<StoredDetailTypeDoc> {
    const existing = await this.findDetailType(tenantId, id);
    if (existing === undefined) {
      throw new CatalogError("NOT_FOUND", "No such detail type");
    }
    const next = cleanDetailType({
      type: existing.type,
      name: mergeTranslations(existing.name, patch.name, MAX_LABEL, "a name"),
      description: mergeTranslations(
        existing.description,
        patch.description,
        MAX_DESCRIPTION,
        "a description",
      ),
      fields: patch.fields ?? existing.fields,
      actions: patch.actions ?? existing.actions,
    });
    // Nothing changed: nothing written, so no `updatedAt` and no issuer rebuild.
    if (canon(next) === canon(existing)) return existing;
    return this.saveDetailType(tenantId, existing.resourceId, next, {
      replace: true,
    });
  }

  /** `false` when it was not there; refused (D6) while a client lists it. */
  async deleteDetailType(tenantId: ObjectId, id: string): Promise<boolean> {
    const existing = await this.findDetailType(tenantId, id);
    if (existing === undefined) return false;
    const using = await this.options.clients.using(tenantId, [existing.type]);
    if (using.length > 0) {
      throw new CatalogError(
        "DETAIL_TYPE_IN_USE",
        `The detail type "${existing.type}" is listed by ${using.length} client(s): remove it from their lists first`,
      );
    }
    await this.typesOf(tenantId).hardDeleteMany({ _id: existing._id });
    return true;
  }

  /**
   * The real `ResourcesFor`: a tenant's stored resources, read through its
   * scope (another tenant's are not visible), by URI: its scopes and its
   * compiled authorization detail types (RFC 9396).
   */
  storedFor: ResourcesFor = async (tenant: ResolvedTenant) => {
    const tenantId = new ObjectId(tenant.tenantId);
    const found = await this.resourcesOf(tenantId).findMany();
    const byResource = await this.scopeNamesByResource(tenantId);
    const typesByResource = await this.compiledDetailTypes(tenantId);
    return Object.fromEntries(
      found.map((resource) => {
        const key = resource._id.toHexString();
        const authorizationDetails = typesByResource.get(key);
        return [
          resource.uri,
          {
            scopes: byResource.get(key) ?? [],
            ...(resource.allowClientCredentials === true
              ? { clientCredentials: true as const }
              : {}),
            ...(authorizationDetails === undefined
              ? {}
              : { authorizationDetails }),
          },
        ];
      }),
    );
  };

  /** Creates the tenant's resource of that URI, or updates its name (the idempotency key). */
  private async upsertResource(
    own: OwnResources,
    uri: string,
    name: string,
  ): Promise<{ resource: StoredResourceDoc; created: boolean }> {
    const existing = await own.findFirst({ uri });
    if (existing !== undefined) {
      await own.update(existing._id, { name });
      return { resource: existing, created: false };
    }
    try {
      return { resource: await own.create({ uri, name }), created: true };
    } catch (error) {
      // A concurrent run created it between our read and write (the unique
      // index refused): read it again and update it like any re-run.
      if (!(error instanceof ConflictError)) throw error;
      const raced = await own.findFirst({ uri });
      if (raced === undefined) throw error;
      await own.update(raced._id, { name });
      return { resource: raced, created: false };
    }
  }

  /**
   * Registers a resource on a tenant, or updates it (idempotent on the URI:
   * the name and the scopes are replaced). Stored through the tenant's scope,
   * so it is that tenant's only. The tenant's own userinfo URL is refused: it
   * is built in and its scopes are the OpenID Connect ones.
   */
  async registerResource(
    input: RegisterResourceInput,
  ): Promise<RegisteredResource> {
    const { uri, name, scopes } = checkRegistration(input);
    const tenant = await this.options.findTenant(input.tenant);
    if (tenant === undefined) throw new UnknownTenantError(input.tenant);
    if (tenant.status !== "active") throw new SuspendedTenantError(tenant.slug);
    checkCanonicalRegistration(uri, this.options.userinfoOf(tenant.slug));
    const { resource, created } = await this.upsertResource(
      this.resourcesOf(tenant._id),
      uri,
      name,
    );
    try {
      await this.replaceResourceScopes(tenant._id, resource._id, scopes);
    } catch (error) {
      if (error instanceof CatalogError) throw new CliInputError(error.message);
      throw error;
    }
    return { created, tenant: tenant.slug, uri, name, scopes };
  }
}
