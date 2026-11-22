import type { TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { ProfileField, StoredProfilePolicies } from "./profile.model";

/** A postal address as stored on the user (OpenID Connect Core 5.1.1, camel-cased). */
export interface Address {
  formatted?: string | undefined;
  streetAddress?: string | undefined;
  locality?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  /** ISO 3166-1 alpha-2, upper case. */
  country?: string | undefined;
}

/** A phone number as stored on the user: E.164, and whether an admin proved it. */
export interface Phone {
  number: string;
  verified: boolean;
}

/** The standard profile fields of a user, as the console shows them (`null`: not set). */
export interface ProfileView {
  givenName: string | null;
  familyName: string | null;
  nickname: string | null;
  phone: Phone | null;
  locale: string | null;
  zoneinfo: string | null;
  /** `YYYY-MM-DD`. */
  birthdate: string | null;
  address: Address | null;
  /** The key of the picture janus holds for the user (`avatar.id`), never a URL. */
  pictureKey: string | null;
  /** When the user record last changed. */
  updatedAt: Date;
}

/** What a caller asks to change, raw: a key left out is kept, `null` clears the field. */
export interface ProfileInput {
  name?: string | null | undefined;
  givenName?: string | null | undefined;
  familyName?: string | null | undefined;
  nickname?: string | null | undefined;
  phone?: string | null | undefined;
  locale?: string | null | undefined;
  zoneinfo?: string | null | undefined;
  birthdate?: string | null | undefined;
  address?: AddressInput | null | undefined;
}

/** A raw address: a blank part is left out, an address with no part left is cleared. */
export interface AddressInput {
  formatted?: string | null | undefined;
  streetAddress?: string | null | undefined;
  locality?: string | null | undefined;
  region?: string | null | undefined;
  postalCode?: string | null | undefined;
  country?: string | null | undefined;
}

/** The checked and normalised change: only the keys the caller named. */
export interface ProfileChanges {
  name?: string;
  givenName?: string | null;
  familyName?: string | null;
  nickname?: string | null;
  /** The new number (E.164), or `null` to clear it. */
  phone?: string | null;
  locale?: string | null;
  zoneinfo?: string | null;
  birthdate?: string | null;
  address?: Address | null;
}

/** What `ProfilePoliciesService` is built over. */
export interface ProfilePoliciesOptions {
  policies: TypedCollection<StoredProfilePolicies>;
}

/** A tenant's locks as the console reads them: `version` 0 while nothing is stored. */
export interface ProfilePolicyView {
  tenantId: ObjectId;
  locked: ProfileField[];
  version: number;
  updatedAt: Date | null;
}
