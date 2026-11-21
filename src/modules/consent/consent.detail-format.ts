import type { FieldKind } from "@/modules/resources";
import {
  acceptedLocales,
  pickTranslation,
  type Translation,
} from "@/shared/translations";

type Text = readonly Translation[];

/** What the formatting reads of a field. */
export interface FormattedField {
  kind: FieldKind;
  values?: readonly { value: string; label: Text }[] | undefined;
}

// The viewer's languages for a number; English when none is usable, never the host's.
const numberLocales = (acceptLanguage: string | null) => {
  const accepted = acceptedLocales(acceptLanguage);
  return accepted.length > 0 ? accepted : ["en"];
};

// The page's own words, with the first language the fallback of a viewer
// whose languages none of them covers.
export const COMMON: Record<
  "actions" | "identifier" | "datatypes" | "locations" | "yes" | "no",
  Text
> = {
  actions: [
    { locale: "en", text: "Actions" },
    { locale: "fr", text: "Actions" },
  ],
  locations: [
    { locale: "en", text: "Location" },
    { locale: "fr", text: "Emplacement" },
  ],
  identifier: [
    { locale: "en", text: "Identifier" },
    { locale: "fr", text: "Identifiant" },
  ],
  datatypes: [
    { locale: "en", text: "Data" },
    { locale: "fr", text: "Données" },
  ],
  yes: [
    { locale: "en", text: "Yes" },
    { locale: "fr", text: "Oui" },
  ],
  no: [
    { locale: "en", text: "No" },
    { locale: "fr", text: "Non" },
  ],
};

// The viewer's language (see `pickTranslation`), else `fallback`.
export const pick = (
  text: Text | undefined,
  acceptLanguage: string | null,
  fallback = "",
) => pickTranslation(text ?? [], acceptLanguage) ?? fallback;

function scalar(value: unknown, acceptLanguage: string | null): string {
  if (typeof value === "boolean") {
    return pick(value ? COMMON.yes : COMMON.no, acceptLanguage);
  }
  if (typeof value === "number") {
    return new Intl.NumberFormat(numberLocales(acceptLanguage)).format(value);
  }
  return typeof value === "string" ? value : "";
}

export function formatted(
  value: unknown,
  field: FormattedField,
  acceptLanguage: string | null,
): string {
  const labelOf = (raw: string) =>
    pick(
      field.values?.find((v) => v.value === raw)?.label,
      acceptLanguage,
      raw,
    );
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        field.kind === "enum"
          ? labelOf(String(item))
          : scalar(item, acceptLanguage),
      )
      .join(", ");
  }
  return field.kind === "enum" && typeof value === "string"
    ? labelOf(value)
    : scalar(value, acceptLanguage);
}
