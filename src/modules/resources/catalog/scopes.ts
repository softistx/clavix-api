import {
  ConflictError,
  type Scoped,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { CatalogError } from "../catalog.errors";
import { isOidcScope, OIDC_SCOPES, scopeNameProblem } from "../scope-name";
import type { scopes } from "../scopes.model";
import {
  cleanClaims,
  cleanText,
  type DescriptionInput,
  MAX_NAME,
  type ScopeInput,
  type StoredResourceDoc,
  type StoredScopeDoc,
} from "./input";

type OwnScopes = Scoped<typeof scopes>;

/** The scope names by resource id (hex) of a tenant: what the token server serves. */
export async function scopeNamesByResource(
  scopeDocs: TypedCollection<typeof scopes>,
  tenantId: ObjectId,
): Promise<Map<string, string[]>> {
  const byResource = new Map<string, string[]>();
  for (const scope of await scopeToTenant(scopeDocs, tenantId).findMany()) {
    if (scope.resourceId === null) continue;
    const key = scope.resourceId.toHexString();
    byResource.set(key, [...(byResource.get(key) ?? []), scope.name]);
  }
  return byResource;
}

export async function listScopes(
  own: OwnScopes,
  filter: { resourceId?: ObjectId | null } = {},
): Promise<StoredScopeDoc[]> {
  const found = await own.findMany(
    filter.resourceId === undefined
      ? {}
      : { filter: { resourceId: filter.resourceId } },
  );
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function findScope(
  own: OwnScopes,
  scopeId: string,
): Promise<StoredScopeDoc | undefined> {
  if (!ObjectId.isValid(scopeId)) return undefined;
  return own.findById(new ObjectId(scopeId));
}

/** `findResource` looks a resource of the same tenant up by its id (hex). */
export async function createScope(
  own: OwnScopes,
  findResource: (id: string) => Promise<StoredResourceDoc | undefined>,
  input: ScopeInput,
): Promise<StoredScopeDoc> {
  const name = input.name.trim();
  const problem =
    name === ""
      ? "a scope needs a name"
      : name.length > MAX_NAME
        ? `a name has at most ${MAX_NAME} characters`
        : scopeNameProblem(name);
  if (problem !== null) throw new CatalogError("BAD_USER_INPUT", problem);
  let resourceId: ObjectId | null = null;
  if (input.resourceId !== undefined && input.resourceId !== null) {
    const resource = await findResource(input.resourceId);
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
  const description = {
    fr: cleanText(input.description?.fr) ?? "",
    en: cleanText(input.description?.en) ?? "",
  };
  const claims = cleanClaims(input.claims);
  try {
    return await own.create({ name, description, resourceId, claims });
  } catch (error) {
    if (error instanceof ConflictError) {
      // A repeat of a call whose audit record failed: the stored scope is
      // returned when it is the one asked for.
      const [existing] = await own.findMany({
        filter: { name, resourceId },
      });
      if (
        existing !== undefined &&
        existing.description.fr === description.fr &&
        existing.description.en === description.en &&
        existing.claims.length === claims.length &&
        existing.claims.every((claim) => claims.includes(claim))
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
    throw error;
  }
}

/** The name and the resource of a scope never change: tokens and clients carry them. */
export async function updateScope(
  own: OwnScopes,
  scopeId: string,
  input: {
    description?: DescriptionInput | undefined;
    claims?: readonly string[] | undefined;
  },
): Promise<StoredScopeDoc> {
  const existing = await findScope(own, scopeId);
  if (existing === undefined) {
    throw new CatalogError("NOT_FOUND", "No such scope");
  }
  return own.update(existing._id, {
    description: {
      fr: cleanText(input.description?.fr) ?? existing.description.fr,
      en: cleanText(input.description?.en) ?? existing.description.en,
    },
    claims:
      input.claims === undefined ? existing.claims : cleanClaims(input.claims),
  });
}

/** `false` when it was not there. */
export async function deleteScope(
  own: OwnScopes,
  scopeId: string,
): Promise<boolean> {
  const existing = await findScope(own, scopeId);
  if (existing === undefined) return false;
  await own.hardDeleteMany({ _id: existing._id });
  return true;
}

/**
 * Makes `names` the scopes of the resource (the `resources:create` script's
 * meaning of "the scopes are replaced"): missing ones are created with empty
 * texts, the others keep theirs, the rest are removed.
 */
export async function replaceResourceScopes(
  own: OwnScopes,
  resource: ObjectId,
  names: readonly string[],
): Promise<void> {
  const current = await own.findMany({ filter: { resourceId: resource } });
  for (const scope of current) {
    if (!names.includes(scope.name)) {
      await own.hardDeleteMany({ _id: scope._id });
    }
  }
  for (const name of names) {
    if (current.some((scope) => scope.name === name)) continue;
    try {
      await own.create({
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
