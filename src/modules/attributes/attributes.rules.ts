import { RESERVED_ACCESS_TOKEN_CLAIMS } from "@softistx/janus-oauth";
import { cleanTranslations, mergeTranslations } from "@/modules/resources";
import type { Translation } from "@/shared/translations";
import { unique } from "@/shared/values";
import type { AttributeOption, AttributeType } from "./attributes.model";
import { refuse, refuseCommon } from "./attributes.refusals";
import type { AttributeDoc, OptionDraft, Texts } from "./attributes.types";

export const MAX_ATTRIBUTES = 100;
export const MAX_OPTIONS = 100;
export const MAX_LABEL = 100;
export const MAX_DESCRIPTION = 300;
export const MAX_UNIT = 20;

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const OPTION_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The types that hold one of the attribute's options. */
export const CHOICE_TYPES: readonly AttributeType[] = [
  "SELECT",
  "MULTI_SELECT",
];

/** The types whose values can be required unique (their canonical key is a string or a decimal). */
export const UNIQUE_TYPES: readonly AttributeType[] = ["STRING", "NUMBER"];

export const isChoice = (type: AttributeType): boolean =>
  CHOICE_TYPES.includes(type);

/**
 * The claim names an attribute key may never take: what janus's access tokens
 * reserve, the OpenID Connect standard claims and the ID token's own, and the
 * names Clavix's tokens already carry (plan "Reserved keys").
 */
export const RESERVED_CLAIMS: readonly string[] = unique([
  ...RESERVED_ACCESS_TOKEN_CLAIMS,
  // OpenID Connect Core 1.0 §5.1 standard claims.
  "sub",
  "name",
  "given_name",
  "family_name",
  "middle_name",
  "nickname",
  "preferred_username",
  "profile",
  "picture",
  "website",
  "email",
  "email_verified",
  "gender",
  "birthdate",
  "zoneinfo",
  "locale",
  "phone_number",
  "phone_number_verified",
  "address",
  "updated_at",
  // ID token claims (§2).
  "iss",
  "aud",
  "exp",
  "iat",
  "auth_time",
  "nonce",
  "acr",
  "amr",
  "azp",
  "at_hash",
  "c_hash",
  "sid",
  // What Clavix's tokens carry.
  "typ",
  "ver",
  "roles",
  "permissions",
  "tenant",
  "org_id",
]);

/** The trimmed key; `ATTRIBUTE_KEY_INVALID` when it is not a claim-safe name, `ATTRIBUTE_KEY_RESERVED` when a token claim owns it. */
export function cleanKey(key: string): string {
  const clean = key.trim();
  if (!KEY.test(clean)) {
    refuse(
      "ATTRIBUTE_KEY_INVALID",
      "a key is 2 to 64 characters: a lower-case letter, then lower-case letters, digits and '_'",
      "key",
    );
  }
  if (RESERVED_CLAIMS.includes(clean)) {
    refuse(
      "ATTRIBUTE_KEY_RESERVED",
      `"${clean}" is a reserved claim name`,
      "key",
    );
  }
  return clean;
}

function needLanguage(texts: readonly Translation[], what: string): void {
  if (texts.length === 0) {
    refuseCommon("BAD_USER_INPUT", `${what} needs at least one language`);
  }
}

/** A label as stored: each locale once, trimmed, at least one. */
export function cleanLabel(input: Texts): Translation[] {
  const label = cleanTranslations(input, MAX_LABEL, "a label");
  needLanguage(label, "a label");
  return label;
}

/** A label over the stored one: the locales given are set or replaced (a blank one removes it), at least one stays. */
export function mergedLabel(
  existing: readonly Translation[],
  input: Texts | undefined,
): Translation[] {
  const label = mergeTranslations(existing, input, MAX_LABEL, "a label");
  needLanguage(label, "a label");
  return label;
}

/** The trimmed unit, `null` for none or blank; refused past `MAX_UNIT` characters. */
export function cleanUnit(unit: string | null | undefined): string | null {
  const clean = (unit ?? "").trim();
  if (clean.length > MAX_UNIT) {
    refuseCommon(
      "BAD_USER_INPUT",
      `a unit has at most ${MAX_UNIT} characters`,
      "unit",
    );
  }
  return clean === "" ? null : clean;
}

/** The options as stored: bounded, each key valid and once, each label in at least one language. */
export function cleanOptions(
  drafts: readonly OptionDraft[] | undefined,
): AttributeOption[] {
  const given = drafts ?? [];
  if (given.length > MAX_OPTIONS) {
    refuseCommon(
      "BAD_USER_INPUT",
      `an attribute has at most ${MAX_OPTIONS} options`,
      "options",
    );
  }
  const keys = new Set<string>();
  return given.map((draft) => {
    const key = draft.key.trim();
    if (!OPTION_KEY.test(key)) {
      refuseCommon(
        "BAD_USER_INPUT",
        "an option key is 1 to 63 characters: lower-case letters, digits, '_' and '-'",
        "options",
      );
    }
    if (keys.has(key)) {
      refuseCommon(
        "BAD_USER_INPUT",
        `the option "${key}" is given twice`,
        "options",
      );
    }
    keys.add(key);
    const label = cleanTranslations(draft.label, MAX_LABEL, "an option label");
    needLanguage(label, "an option label");
    return { key, label };
  });
}

/** The option keys of `before` that `after` no longer holds. */
export function removedOptionKeys(
  before: readonly AttributeOption[],
  after: readonly AttributeOption[],
): string[] {
  const kept = new Set(after.map((option) => option.key));
  return before.filter((option) => !kept.has(option.key)).map((o) => o.key);
}

type Behaviour = Pick<
  AttributeDoc,
  "family" | "type" | "unique" | "required" | "userEditable" | "emission"
> & { options: readonly AttributeOption[] };

/**
 * The rules among an attribute's own settings, on the state it would have:
 * only STRING and NUMBER can be unique, only the user family is `required`
 * (a role attribute's is per link), only a choice has options, and an emitted
 * attribute is never editable by the user (the user could forge a claim).
 */
export function checkBehaviour(state: Behaviour): void {
  if (state.unique && !UNIQUE_TYPES.includes(state.type)) {
    refuse(
      "ATTRIBUTE_UNIQUE_UNSUPPORTED",
      "only a STRING or a NUMBER attribute can be unique",
      "unique",
    );
  }
  if (state.family === "ROLE" && state.required) {
    refuseCommon(
      "BAD_USER_INPUT",
      "a role attribute is required per role link, not on the attribute",
      "required",
    );
  }
  if (!isChoice(state.type) && state.options.length > 0) {
    refuseCommon(
      "BAD_USER_INPUT",
      "only a SELECT or a MULTI_SELECT attribute has options",
      "options",
    );
  }
  if (state.emission !== null && state.userEditable) {
    refuse(
      "ATTRIBUTE_EDITABLE_EMITTED",
      "an attribute the user can edit cannot be emitted as a claim",
      "emissionScope",
    );
  }
}
