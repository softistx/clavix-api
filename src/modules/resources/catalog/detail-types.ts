import {
  type Scoped,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { CatalogError } from "../catalog.errors";
import type { DetailTypeClients } from "../detail-types/client-lists";
import type {
  detailTypes,
  FieldKind,
} from "../detail-types/detail-types.model";
import { type DetailTypeInput, saveDetailType } from "../detail-types/store";
import type { DescriptionInput, StoredDetailTypeDoc } from "./input";
import { MAX_DESCRIPTION, MAX_LABEL } from "./input";

type OwnTypes = Scoped<typeof detailTypes>;

/** A label or a description in the draft: a language left out is empty. */
export interface TextDraft {
  fr?: string | undefined;
  en?: string | undefined;
}

export interface ValueDraft {
  value: string;
  label?: TextDraft | undefined;
}

export interface FieldDraft {
  key: string;
  kind: FieldKind;
  label?: TextDraft | undefined;
  required?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
  values?: readonly ValueDraft[] | undefined;
}

/** What the console sends to create a detail type. */
export interface DetailTypeDraft {
  type: string;
  name: TextDraft;
  description?: TextDraft | undefined;
  fields: readonly FieldDraft[];
  actions?: readonly ValueDraft[] | undefined;
}

/** What it sends to change one: the type name never changes; a part left out stays. */
export interface DetailTypePatch {
  name?: DescriptionInput | undefined;
  description?: DescriptionInput | undefined;
  fields?: readonly FieldDraft[] | undefined;
  actions?: readonly ValueDraft[] | undefined;
}

function bounded(text: string | undefined, max: number, what: string) {
  const clean = text?.trim() ?? "";
  if (clean.length > max) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      `${what} has at most ${max} characters`,
    );
  }
  return clean;
}

const label = (text: TextDraft | undefined, what: string) => ({
  fr: bounded(text?.fr, MAX_LABEL, what),
  en: bounded(text?.en, MAX_LABEL, what),
});

const cleanField = (field: FieldDraft): DetailTypeInput["fields"][number] => ({
  key: field.key,
  kind: field.kind,
  label: label(field.label, `the label of field "${field.key}"`),
  required: field.required ?? false,
  ...(field.min === undefined ? {} : { min: field.min }),
  ...(field.max === undefined ? {} : { max: field.max }),
  ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
  ...(field.values === undefined
    ? {}
    : {
        values: field.values.map((v) => ({
          value: v.value,
          label: label(v.label, `the label of value "${v.value}"`),
        })),
      }),
});

const cleanActions = (actions: readonly ValueDraft[] | undefined) =>
  actions?.map((a) => ({
    value: a.value,
    label: label(a.label, `the label of action "${a.value}"`),
  }));

/** A draft as the stored shape: texts trimmed and bounded (the compiler checks the rest). */
export function cleanDetailType(draft: DetailTypeDraft): DetailTypeInput {
  const name = {
    fr: bounded(draft.name.fr, MAX_LABEL, "a name"),
    en: bounded(draft.name.en, MAX_LABEL, "a name"),
  };
  if (name.fr === "" && name.en === "") {
    throw new CatalogError("BAD_USER_INPUT", "a detail type needs a name");
  }
  const actions = cleanActions(draft.actions);
  return {
    type: draft.type.trim(),
    name,
    description: {
      fr: bounded(draft.description?.fr, MAX_DESCRIPTION, "a description"),
      en: bounded(draft.description?.en, MAX_DESCRIPTION, "a description"),
    },
    fields: draft.fields.map(cleanField),
    ...(actions === undefined ? {} : { actions }),
  };
}

// The definition in one fixed key order, to tell a real change from a repeat.
const canon = (doc: DetailTypeInput) =>
  JSON.stringify({
    type: doc.type,
    name: [doc.name.fr, doc.name.en],
    description: [doc.description.fr, doc.description.en],
    fields: doc.fields.map((f) => [
      f.key,
      f.kind,
      f.label.fr,
      f.label.en,
      f.required,
      f.min ?? null,
      f.max ?? null,
      f.maxLength ?? null,
      (f.values ?? []).map((v) => [v.value, v.label.fr, v.label.en]),
    ]),
    actions: (doc.actions ?? []).map((a) => [a.value, a.label.fr, a.label.en]),
  });

export async function listDetailTypes(
  docs: TypedCollection<typeof detailTypes>,
  tenantId: ObjectId,
  resourceId?: ObjectId,
): Promise<StoredDetailTypeDoc[]> {
  const own = scopeToTenant(docs, tenantId);
  const found = await own.findMany(
    resourceId === undefined ? {} : { filter: { resourceId } },
  );
  return found.sort((a, b) => a.type.localeCompare(b.type));
}

export async function findDetailType(
  own: OwnTypes,
  id: string,
): Promise<StoredDetailTypeDoc | undefined> {
  if (!ObjectId.isValid(id)) return undefined;
  return own.findById(new ObjectId(id));
}

/** `resource` is the tenant's own resource (the caller looked it up through the tenant's scope). */
export async function createDetailType(
  docs: TypedCollection<typeof detailTypes>,
  tenantId: ObjectId,
  resource: ObjectId,
  draft: DetailTypeDraft,
): Promise<StoredDetailTypeDoc> {
  const input = cleanDetailType(draft);
  // A repeat of a call whose audit record failed: the stored type is returned
  // when it is this resource's, with the same definition (the caller records
  // the event the first run missed). Anything else stays a CONFLICT.
  const existing = await scopeToTenant(docs, tenantId).findFirst({
    type: input.type,
  });
  if (existing !== undefined) {
    if (
      existing.resourceId.equals(resource) &&
      canon(input) === canon(existing)
    ) {
      return existing;
    }
  }
  return saveDetailType(docs, tenantId, resource, input);
}

export async function updateDetailType(
  docs: TypedCollection<typeof detailTypes>,
  tenantId: ObjectId,
  id: string,
  patch: DetailTypePatch,
): Promise<StoredDetailTypeDoc> {
  const existing = await findDetailType(scopeToTenant(docs, tenantId), id);
  if (existing === undefined) {
    throw new CatalogError("NOT_FOUND", "No such detail type");
  }
  const next = cleanDetailType({
    type: existing.type,
    name: {
      fr: patch.name?.fr ?? existing.name.fr,
      en: patch.name?.en ?? existing.name.en,
    },
    description: {
      fr: patch.description?.fr ?? existing.description.fr,
      en: patch.description?.en ?? existing.description.en,
    },
    fields: patch.fields ?? existing.fields,
    actions: patch.actions ?? existing.actions,
  });
  // Nothing changed: nothing written, so no `updatedAt` and no issuer rebuild.
  if (canon(next) === canon(existing)) return existing;
  return saveDetailType(docs, tenantId, existing.resourceId, next, {
    replace: true,
  });
}

/** `false` when it was not there; refused (D6) while a client lists it. */
export async function deleteDetailType(
  own: OwnTypes,
  clients: DetailTypeClients,
  tenantId: ObjectId,
  id: string,
): Promise<boolean> {
  const existing = await findDetailType(own, id);
  if (existing === undefined) return false;
  const using = await clients.using(tenantId, [existing.type]);
  if (using.length > 0) {
    throw new CatalogError(
      "DETAIL_TYPE_IN_USE",
      `The detail type "${existing.type}" is listed by ${using.length} client(s): remove it from their lists first`,
    );
  }
  await own.hardDeleteMany({ _id: existing._id });
  return true;
}
