import { CatalogError } from "./resources.errors";
import { MAX_DESCRIPTION, MAX_LABEL } from "./resources.rules";
import type {
  DetailTypeDraft,
  DetailTypeInput,
  FieldDraft,
  TextDraft,
  ValueDraft,
} from "./resources.types";

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

/** The definition in one fixed key order, to tell a real change from a repeat. */
export const canon = (doc: DetailTypeInput): string =>
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
