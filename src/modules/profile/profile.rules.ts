import { canonicalLocale } from "@/shared/translations";
import { PROFILE_FIELDS, type ProfileField } from "./profile.model";
import { refuse } from "./profile.refusals";
import type {
  Address,
  AddressInput,
  ProfileChanges,
  ProfileInput,
} from "./profile.types";
import { isCountryCode } from "./utils";

export const MAX_NAME_PART = 100;
export const MAX_ADDRESS_PART = 200;
export const MAX_FORMATTED = 500;

const E164 = /^\+[1-9]\d{6,14}$/;
const BIRTHDATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST_YEAR = 1900;

const length = (text: string) => [...text].length;

/** The zones the runtime knows, by lower-case name (a request may spell the case freely). */
const zones = new Map(
  [...Intl.supportedValuesOf("timeZone"), "UTC"].map((zone) => [
    zone.toLowerCase(),
    zone,
  ]),
);

/** A text of 1 to `max` characters once trimmed. */
export function cleanText(raw: string, field: string, max: number): string {
  const text = raw.trim();
  if (text === "" || length(text) > max) {
    refuse(
      "PROFILE_FIELD_INVALID",
      `${field} must be 1 to ${max} characters once trimmed`,
      field,
    );
  }
  return text;
}

/** An E.164 number (`+` and 7 to 15 digits); spaces, dots, dashes and brackets are dropped first. */
export function cleanPhoneNumber(raw: string): string {
  const number = raw.replace(/[\s().-]/g, "");
  if (!E164.test(number)) {
    refuse(
      "PROFILE_FIELD_INVALID",
      "phone must be an international number in E.164 form (+ and 7 to 15 digits)",
      "phone",
    );
  }
  return number;
}

/** A BCP 47 tag, in its canonical spelling (`fr-fr` becomes `fr-FR`). */
export function cleanLocale(raw: string): string {
  const tag = raw.trim();
  const canonical = tag === "*" ? undefined : canonicalLocale(tag);
  if (canonical === undefined) {
    refuse(
      "PROFILE_FIELD_INVALID",
      "locale must be a BCP 47 language tag such as fr or en-CA",
      "locale",
    );
  }
  return canonical;
}

/** An IANA time zone name, spelled as the runtime knows it (`europe/paris` becomes `Europe/Paris`). */
export function cleanZoneinfo(raw: string): string {
  const zone = zones.get(raw.trim().toLowerCase());
  if (zone === undefined) {
    refuse(
      "PROFILE_FIELD_INVALID",
      "zoneinfo must be an IANA time zone such as Europe/Paris",
      "zoneinfo",
    );
  }
  return zone;
}

/** A calendar date as `YYYY-MM-DD`, from 1900 up to `today`. */
export function cleanBirthdate(raw: string, today: Date): string {
  const text = raw.trim();
  const parts = BIRTHDATE.exec(text);
  const [year, month, day] = [1, 2, 3].map((i) => Number(parts?.[i]));
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
  const real =
    parts !== null &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 0) - 1 &&
    date.getUTCDate() === day;
  if (
    !real ||
    (year ?? 0) < EARLIEST_YEAR ||
    text > today.toISOString().slice(0, 10)
  ) {
    refuse(
      "PROFILE_FIELD_INVALID",
      `birthdate must be a real date from ${EARLIEST_YEAR} to today, as YYYY-MM-DD`,
      "birthdate",
    );
  }
  return text;
}

/** An ISO 3166-1 alpha-2 code, in upper case. */
export function cleanCountry(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!isCountryCode(code)) {
    refuse(
      "PROFILE_FIELD_INVALID",
      "address.country must be an ISO 3166-1 alpha-2 code such as FR",
      "address.country",
    );
  }
  return code;
}

const ADDRESS_PARTS = [
  ["formatted", MAX_FORMATTED],
  ["streetAddress", MAX_ADDRESS_PART],
  ["locality", MAX_ADDRESS_PART],
  ["region", MAX_ADDRESS_PART],
  ["postalCode", MAX_ADDRESS_PART],
] as const;

/** An address: a blank or null part is left out; `null` when no part is left (the address is cleared). */
export function cleanAddress(input: AddressInput): Address | null {
  const address: Address = {};
  for (const [part, max] of ADDRESS_PARTS) {
    const raw = input[part];
    if (raw === undefined || raw === null || raw.trim() === "") continue;
    address[part] = cleanText(raw, `address.${part}`, max);
  }
  const country = input.country;
  if (country !== undefined && country !== null && country.trim() !== "") {
    address.country = cleanCountry(country);
  }
  return Object.keys(address).length === 0 ? null : address;
}

/** A text field: `null` or blank clears it, else it is checked. */
const textOrNull = (
  raw: string | null,
  check: (text: string) => string,
): string | null => (raw === null || raw.trim() === "" ? null : check(raw));

/**
 * The checked change of a profile input: only the keys the caller named,
 * each normalised; `null` (or a blank text) clears an optional field. `name`
 * is checked by its own rule (1 to 200, it cannot be cleared).
 * `today` bounds the birthdate.
 */
export function cleanProfile(input: ProfileInput, today: Date): ProfileChanges {
  const changes: ProfileChanges = {};
  for (const field of ["givenName", "familyName", "nickname"] as const) {
    const raw = input[field];
    if (raw !== undefined) {
      changes[field] = textOrNull(raw, (t) =>
        cleanText(t, field, MAX_NAME_PART),
      );
    }
  }
  if (input.phone !== undefined) {
    changes.phone = textOrNull(input.phone, cleanPhoneNumber);
  }
  if (input.locale !== undefined) {
    changes.locale = textOrNull(input.locale, cleanLocale);
  }
  if (input.zoneinfo !== undefined) {
    changes.zoneinfo = textOrNull(input.zoneinfo, cleanZoneinfo);
  }
  if (input.birthdate !== undefined) {
    changes.birthdate = textOrNull(input.birthdate, (t) =>
      cleanBirthdate(t, today),
    );
  }
  if (input.address !== undefined) {
    changes.address =
      input.address === null ? null : cleanAddress(input.address);
  }
  return changes;
}

const FIELD_OF = {
  name: "NAME",
  givenName: "GIVEN_NAME",
  familyName: "FAMILY_NAME",
  nickname: "NICKNAME",
  phone: "PHONE",
  locale: "LOCALE",
  zoneinfo: "ZONEINFO",
  birthdate: "BIRTHDATE",
  address: "ADDRESS",
} as const satisfies Record<keyof ProfileChanges, ProfileField>;

/** The profile fields a change touches. */
export const touchedFields = (changes: ProfileChanges): ProfileField[] =>
  Object.entries(FIELD_OF).flatMap(([key, field]) =>
    key in changes ? [field] : [],
  );

/**
 * Refuses a change that touches a locked field (`PROFILE_FIELD_LOCKED`,
 * `field` naming the first one). The console's `updateUser` does not call it:
 * an admin is not blocked by a lock, the hosted self-service is (slice A7).
 */
export function checkUnlocked(
  changes: ProfileChanges,
  locked: readonly ProfileField[],
): void {
  const hit = touchedFields(changes).find((field) => locked.includes(field));
  if (hit !== undefined) {
    refuse(
      "PROFILE_FIELD_LOCKED",
      `${hit} is locked by the tenant: only an administrator changes it`,
      hit,
    );
  }
}

/** A lock list: each field once, in the order of `PROFILE_FIELDS`. */
export const sortedLocks = (wanted: readonly ProfileField[]): ProfileField[] =>
  PROFILE_FIELDS.filter((field) => wanted.includes(field));
