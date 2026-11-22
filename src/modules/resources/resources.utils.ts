import type { ObjectId } from "mongodb";
import type { protectedResourceDocument } from "./resources.protected-document";
import type {
  FieldDraft,
  StoredDetailTypeDoc,
  StoredResourceDoc,
  StoredScopeDoc,
  Texts,
  ValueDraft,
} from "./resources.types";

type ProtectedResourceDocument = Awaited<
  ReturnType<typeof protectedResourceDocument>
>;

// What an admin event names: the document's id and its tenant.
export const target = (
  type: "resource" | "scope" | "detailType",
  tenantId: ObjectId,
  id: ObjectId,
) => ({
  type,
  id: id.toHexString(),
  tenantId: tenantId.toHexString(),
});

export const scopeShape = (scope: StoredScopeDoc) => ({
  id: scope._id.toHexString(),
  name: scope.name,
  description: scope.description,
  resourceId: scope.resourceId?.toHexString() ?? null,
  claims: scope.claims,
});

const KINDS = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  enum: "ENUM",
  "string[]": "STRING_LIST",
} as const;
const KIND_OF = {
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ENUM: "enum",
  STRING_LIST: "string[]",
} as const satisfies Record<
  (typeof KINDS)[keyof typeof KINDS],
  keyof typeof KINDS
>;

export const detailTypeShape = (doc: StoredDetailTypeDoc) => ({
  id: doc._id.toHexString(),
  resourceId: doc.resourceId.toHexString(),
  type: doc.type,
  name: doc.name,
  description: doc.description,
  fields: doc.fields.map((field) => ({
    key: field.key,
    kind: KINDS[field.kind],
    label: field.label,
    required: field.required,
    min: field.min ?? null,
    max: field.max ?? null,
    maxLength: field.maxLength ?? null,
    values: field.values ?? null,
  })),
  actions: doc.actions ?? [],
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export type ValueInput = {
  value: string;
  label?: Texts | null;
};
export const valueDraft = (input: ValueInput): ValueDraft => ({
  value: input.value,
  label: input.label ?? undefined,
});

export type FieldInput = {
  key: string;
  kind: keyof typeof KIND_OF;
  label?: Texts | null;
  required?: boolean | null;
  min?: number | null;
  max?: number | null;
  maxLength?: number | null;
  values?: ValueInput[] | null;
};
export const fieldDraft = (input: FieldInput): FieldDraft => ({
  key: input.key,
  kind: KIND_OF[input.kind],
  label: input.label ?? undefined,
  required: input.required ?? undefined,
  min: input.min ?? undefined,
  max: input.max ?? undefined,
  maxLength: input.maxLength ?? undefined,
  values: input.values?.map(valueDraft),
});

export const resourceShape = (
  resource: StoredResourceDoc,
  scopes: StoredScopeDoc[],
  types: StoredDetailTypeDoc[],
  document: ProtectedResourceDocument | null,
) => ({
  id: resource._id.toHexString(),
  uri: resource.uri,
  name: resource.name,
  scopes: scopes
    .filter((scope) => scope.resourceId?.equals(resource._id))
    .map(scopeShape),
  detailTypes: types
    .filter((doc) => doc.resourceId.equals(resource._id))
    .map(detailTypeShape),
  metadataUrl: document?.metadataUrl ?? null,
  protectedResourceMetadata: document?.metadata ?? null,
  allowClientCredentials: resource.allowClientCredentials === true,
  createdAt: resource.createdAt,
});
