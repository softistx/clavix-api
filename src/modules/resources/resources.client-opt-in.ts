import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { detailTypes } from "./resources.model";

/** What a client's opt-in to detail types (R3, D3) needs to know of a tenant: the types it stores. */
export interface ClientDetailTypes {
  /** The names of the tenant's stored detail types (read through its scope). */
  namesOf(tenant: { _id: ObjectId }): Promise<ReadonlySet<string>>;
}

/** The real port over the `detailTypes` collection. */
export function mongoClientDetailTypes(
  docs: TypedCollection<typeof detailTypes>,
): ClientDetailTypes {
  return {
    async namesOf(tenant) {
      const found = await scopeToTenant(docs, tenant._id).findMany();
      return new Set(found.map((doc) => doc.type));
    },
  };
}
