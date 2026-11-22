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

/** The janus patch of a checked change, over the user it applies to (the phone keeps its flag when its number is unchanged). */
export const patchOf = (
  changes: ProfileChanges,
  current: Pick<ProfileSource, "phone">,
) => {
  const { phone, ...rest } = changes;
  return {
    ...rest,
    ...(phone === undefined ? {} : { phone: nextPhone(current.phone, phone) }),
  };
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
