import { ObjectId } from "mongodb";
import { detailTypes, scopes } from "@/modules/resources/resources.model";
import type {
  StoredDetailTypeDoc,
  StoredScopeDoc,
} from "@/modules/resources/resources.types";

const stamp = new Date(0);

/** A complete stored scope, the schema's defaults filled in, `over` applied on top of the fields. */
export function scopeDoc(
  over: Partial<Pick<StoredScopeDoc, "name" | "description" | "claims">> &
    Partial<Pick<StoredScopeDoc, "resourceId">> = {},
): StoredScopeDoc {
  const _id = new ObjectId();
  return {
    ...scopes.schema.parse({
      _id,
      tenantId: new ObjectId(),
      name: "read",
      description: { fr: "", en: "" },
      resourceId: null,
      claims: [],
      ...over,
      createdAt: stamp,
      updatedAt: stamp,
    }),
    id: _id.toHexString(),
  };
}

/** A complete stored detail type with one integer field, `over` applied on top of the fields. */
export function detailTypeDoc(
  over: Partial<Pick<StoredDetailTypeDoc, "type" | "fields" | "actions">> = {},
): StoredDetailTypeDoc {
  const _id = new ObjectId();
  return {
    ...detailTypes.schema.parse({
      _id,
      tenantId: new ObjectId(),
      resourceId: new ObjectId(),
      type: "pay",
      name: { fr: "", en: "" },
      description: { fr: "", en: "" },
      fields: [{ key: "n", kind: "integer", label: {}, required: true }],
      ...over,
      createdAt: stamp,
      updatedAt: stamp,
    }),
    id: _id.toHexString(),
  };
}
