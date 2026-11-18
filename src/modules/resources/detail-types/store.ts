import {
  ConflictError,
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { z } from "zod";
import { CatalogError } from "../catalog.errors";
import {
  compileDetailType,
  type DetailTypeDefinition,
  detailTypeProblem,
} from "./compile";
import type { detailTypes } from "./detail-types.model";

/** What a resource's `authorizationDetails` holds (janus's declaration). */
export type CompiledDetailTypes = Record<string, { schema: z.ZodType }>;

/**
 * The compiled detail types of a tenant by resource id (hex): what the token
 * server serves. Read through the tenant's scope, so another tenant's types
 * are unknown. A stored definition the compiler refuses (written by hand, or
 * before a bound tightened) is left out rather than failing the whole issuer.
 */
export async function detailTypesByResource(
  docs: TypedCollection<typeof detailTypes>,
  tenantId: ObjectId,
): Promise<Map<string, CompiledDetailTypes>> {
  const byResource = new Map<string, CompiledDetailTypes>();
  for (const doc of await scopeToTenant(docs, tenantId).findMany()) {
    const definition: DetailTypeDefinition = doc;
    if (detailTypeProblem(definition) !== null) continue;
    const key = doc.resourceId.toHexString();
    const own = byResource.get(key) ?? {};
    own[doc.type] = { schema: compileDetailType(definition) };
    byResource.set(key, own);
  }
  return byResource;
}

export type DetailTypeInput = Omit<
  ReadDocumentOf<typeof detailTypes>,
  "_id" | "id" | "tenantId" | "resourceId" | "createdAt" | "updatedAt"
>;

/**
 * Stores a detail type of a resource (the console's `Catalog` wraps it): the
 * definition must compile, and the name is unique in the tenant (D2), so a
 * name already taken, by this resource or another, is a `CONFLICT` unless
 * `replace` is set and it is this resource's own.
 */
export async function saveDetailType(
  docs: TypedCollection<typeof detailTypes>,
  tenantId: ObjectId,
  resourceId: ObjectId,
  input: DetailTypeInput,
  options: { replace?: boolean } = {},
): Promise<ReadDocumentOf<typeof detailTypes>> {
  const problem = detailTypeProblem(input);
  if (problem !== null) throw new CatalogError("BAD_USER_INPUT", problem);
  const own = scopeToTenant(docs, tenantId);
  const existing = await own.findFirst({ type: input.type });
  if (existing !== undefined) {
    if (options.replace !== true || !existing.resourceId.equals(resourceId)) {
      throw new CatalogError(
        "CONFLICT",
        `The detail type "${input.type}" already exists`,
      );
    }
    // `update` merges: a dropped list is written as empty, never left behind.
    return own.update(existing._id, { ...input, actions: input.actions ?? [] });
  }
  try {
    return await own.create({ ...input, resourceId });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new CatalogError(
        "CONFLICT",
        `The detail type "${input.type}" already exists`,
      );
    }
    throw error;
  }
}
