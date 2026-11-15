import { ConflictError, type Scoped } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { CatalogError } from "../catalog.errors";
import { resourceUriProblem } from "../resource-uri";
import type { resources } from "../resources.model";
import type { scopes } from "../scopes.model";
import { cleanName, type StoredResourceDoc } from "./input";

type OwnResources = Scoped<typeof resources>;
type OwnScopes = Scoped<typeof scopes>;

const sameUri = (a: string, b: string) => new URL(a).href === new URL(b).href;

export async function listResources(
  own: OwnResources,
): Promise<StoredResourceDoc[]> {
  const found = await own.findMany();
  return found.sort((a, b) => a.uri.localeCompare(b.uri));
}

export async function findResource(
  own: OwnResources,
  resourceId: string,
): Promise<StoredResourceDoc | undefined> {
  if (!ObjectId.isValid(resourceId)) return undefined;
  return own.findById(new ObjectId(resourceId));
}

/** `userinfoUrl` is the tenant's built-in resource, which cannot be registered. */
export async function createResource(
  own: OwnResources,
  userinfoUrl: string,
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
  if (sameUri(uri, userinfoUrl)) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `"${uri}" is the tenant's userinfo endpoint, a built-in resource`,
    );
  }
  const name = cleanName(input.name ?? new URL(uri).host);
  try {
    return await own.create({ uri, name });
  } catch (error) {
    if (error instanceof ConflictError) {
      // A repeat of a call whose audit record failed: the stored resource
      // is returned when it is the one asked for.
      const [existing] = await own.findMany({ filter: { uri } });
      if (existing !== undefined && existing.name === name) return existing;
      throw new CatalogError(
        "CONFLICT",
        `A resource already has the URI "${uri}"`,
      );
    }
    throw error;
  }
}

export async function updateResource(
  own: OwnResources,
  resourceId: string,
  input: { name: string },
): Promise<StoredResourceDoc> {
  const existing = await findResource(own, resourceId);
  if (existing === undefined) {
    throw new CatalogError("NOT_FOUND", "No such resource");
  }
  const name = cleanName(input.name);
  return own.update(existing._id, { name });
}

/** Deletes the resource and its scopes; `false` when it was not there. */
export async function deleteResource(
  own: OwnResources,
  ownScopes: OwnScopes,
  resourceId: string,
): Promise<boolean> {
  const existing = await findResource(own, resourceId);
  if (existing === undefined) return false;
  await ownScopes.hardDeleteMany({ resourceId: existing._id });
  await own.hardDeleteMany({ _id: existing._id });
  return true;
}
