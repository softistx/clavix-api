import type { OidcClaims } from "@softistx/janus-oidc";
import type {
  Address,
  Phone,
  ProfileChanges,
  ProfilePolicyView,
  ProfileView,
} from "../profile.types";

/** The profile fields of a janus user: every one optional, `null` or absent when not set. */
export interface ProfileSource {
  readonly givenName?: string | null | undefined;
  readonly familyName?: string | null | undefined;
  readonly nickname?: string | null | undefined;
  readonly phone?: Phone | null | undefined;
  readonly locale?: string | null | undefined;
  readonly zoneinfo?: string | null | undefined;
  readonly birthdate?: string | null | undefined;
  readonly address?: Address | null | undefined;
  readonly avatar?: { readonly id: string } | null | undefined;
  readonly updatedAt: Date;
}

/** The profile of a janus user, every unset field `null`. */
export const profileOf = (user: ProfileSource): ProfileView => ({
  givenName: user.givenName ?? null,
  familyName: user.familyName ?? null,
  nickname: user.nickname ?? null,
  phone: user.phone ?? null,
  locale: user.locale ?? null,
  zoneinfo: user.zoneinfo ?? null,
  birthdate: user.birthdate ?? null,
  address: user.address ?? null,
  pictureKey: user.avatar?.id ?? null,
  updatedAt: user.updatedAt,
});

/** A profile with nothing set (a user who never filled one in). */
export const emptyProfile = (updatedAt: Date): ProfileView =>
  profileOf({ updatedAt });

/**
 * The phone a change leaves: a number that differs from the stored one starts
 * unverified (no SMS: only an admin marks it proved, `setUserPhoneVerified`),
 * the same number keeps its flag, `null` clears it.
 */
export const nextPhone = (
  current: Phone | null | undefined,
  number: string | null,
): Phone | null => {
  if (number === null) return null;
  return {
    number,
    verified: current?.number === number && current.verified,
  };
};

/** Two stored values are the same when both are unset or equal (objects field by field, an unset field being absent). */
const sameValue = (a: unknown, b: unknown): boolean => {
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return true;
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null
  ) {
    const left = Object.entries(a).filter(
      ([, v]) => v !== null && v !== undefined,
    );
    const right = Object.entries(b).filter(
      ([, v]) => v !== null && v !== undefined,
    );
    return (
      left.length === right.length &&
      left.every(([key, value]) =>
        sameValue(value, Object.fromEntries(right)[key]),
      )
    );
  }
  return a === b;
};

/**
 * The janus patch of a checked change, over the user it applies to: only the
 * fields that really differ (a repeat writes nothing, so `updatedAt` and the
 * version stay put), the phone keeping its flag when its number is unchanged.
 */
export const patchOf = (
  changes: ProfileChanges,
  current: Pick<ProfileSource, "phone"> & {
    readonly name?: string | undefined;
  } & Partial<ProfileSource>,
) => {
  const { phone, ...rest } = changes;
  const wanted = {
    ...rest,
    ...(phone === undefined ? {} : { phone: nextPhone(current.phone, phone) }),
  };
  return Object.fromEntries(
    Object.entries(wanted).filter(
      ([key, value]) => !sameValue(value, Reflect.get(current, key)),
    ),
  );
};

/**
 * The standard claims of a profile (OpenID Connect Core 5.1), `snake_case`; a
 * field that is not set gives no claim. janus-oidc releases them per scope
 * (`profile`, `phone`, `address`): this returns every one it knows.
 */
export function standardClaims(profile: ProfileView): OidcClaims {
  const { address, phone } = profile;
  return {
    ...(profile.givenName === null ? {} : { given_name: profile.givenName }),
    ...(profile.familyName === null ? {} : { family_name: profile.familyName }),
    ...(profile.nickname === null ? {} : { nickname: profile.nickname }),
    ...(profile.locale === null ? {} : { locale: profile.locale }),
    ...(profile.zoneinfo === null ? {} : { zoneinfo: profile.zoneinfo }),
    ...(profile.birthdate === null ? {} : { birthdate: profile.birthdate }),
    ...(phone === null
      ? {}
      : { phone_number: phone.number, phone_number_verified: phone.verified }),
    ...(address === null
      ? {}
      : {
          address: {
            ...(address.formatted === undefined
              ? {}
              : { formatted: address.formatted }),
            ...(address.streetAddress === undefined
              ? {}
              : { street_address: address.streetAddress }),
            ...(address.locality === undefined
              ? {}
              : { locality: address.locality }),
            ...(address.region === undefined ? {} : { region: address.region }),
            ...(address.postalCode === undefined
              ? {}
              : { postal_code: address.postalCode }),
            ...(address.country === undefined
              ? {}
              : { country: address.country }),
          },
        }),
    updated_at: Math.floor(profile.updatedAt.getTime() / 1000),
  };
}

/** A tenant's locks as the console schema shows them (the id as hex). */
export const policyShape = (policy: ProfilePolicyView) => ({
  tenantId: policy.tenantId.toHexString(),
  locked: policy.locked,
  version: policy.version,
  updatedAt: policy.updatedAt,
});

/**
 * The version a caller sees: one past the stored one, so that a stored document
 * is never at 0, the version of "nothing stored yet" (a stored `version` starts
 * at 0 too, and two first writes must not be mistaken for one write after the
 * other).
 */
export const versionOf = (stored: number): number => stored + 1;
