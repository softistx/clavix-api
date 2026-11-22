import { CatalogError } from "./resources.errors";
import { MAX_DESCRIPTION, MAX_LABEL } from "./resources.rules";
import {
  canonTranslations,
  cleanTranslations,
} from "./resources.translation-rules";
import type {
  DetailTypeDraft,
  DetailTypeInput,
  FieldDraft,
  Texts,
  ValueDraft,
} from "./resources.types";

const label = (text: Texts | undefined, what: string) =>
  cleanTranslations(text, MAX_LABEL, what);

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
  const name = cleanTranslations(draft.name, MAX_LABEL, "a name");
  if (name.length === 0) {
    throw new CatalogError("BAD_USER_INPUT", "a detail type needs a name");
  }
  const actions = cleanActions(draft.actions);
  return {
    type: draft.type.trim(),
    name,
    description: cleanTranslations(
      draft.description,
      MAX_DESCRIPTION,
      "a description",
    ),
    fields: draft.fields.map(cleanField),
    ...(actions === undefined ? {} : { actions }),
  };
}

/** The definition in one fixed key order, to tell a real change from a repeat. */
export const canon = (doc: DetailTypeInput): string =>
  JSON.stringify({
    type: doc.type,
    name: canonTranslations(doc.name),
    description: canonTranslations(doc.description),
    fields: doc.fields.map((f) => [
      f.key,
      f.kind,
      canonTranslations(f.label),
      f.required,
      f.min ?? null,
      f.max ?? null,
      f.maxLength ?? null,
      (f.values ?? []).map((v) => [v.value, canonTranslations(v.label)]),
    ]),
    actions: (doc.actions ?? []).map((a) => [
      a.value,
      canonTranslations(a.label),
    ]),
  });
