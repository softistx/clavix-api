import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  emptyProfile,
  nextPhone,
  patchOf,
  policyShape,
  profileOf,
  standardClaims,
} from "./profile.utils";

const at = new Date("2026-01-01T00:00:00Z");

describe("profileOf", () => {
  test("turns every unset field into null and reads the picture key from the avatar", () => {
    expect(profileOf({ updatedAt: at })).toEqual({
      givenName: null,
      familyName: null,
      nickname: null,
      phone: null,
      locale: null,
      zoneinfo: null,
      birthdate: null,
      address: null,
      pictureKey: null,
      updatedAt: at,
    });
    expect(
      profileOf({ updatedAt: at, avatar: { id: "k1" }, nickname: "Ad" }),
    ).toMatchObject({ pictureKey: "k1", nickname: "Ad" });
    expect(emptyProfile(at)).toEqual(profileOf({ updatedAt: at }));
  });
});

describe("nextPhone", () => {
  const stored = { number: "+14165550123", verified: true };
  test("a new number starts unverified", () => {
    expect(nextPhone(stored, "+14165550199")).toEqual({
      number: "+14165550199",
      verified: false,
    });
    expect(nextPhone(null, "+14165550199")).toEqual({
      number: "+14165550199",
      verified: false,
    });
  });
  test("the same number keeps its flag; null clears it", () => {
    expect(nextPhone(stored, "+14165550123")).toEqual(stored);
    expect(nextPhone(stored, null)).toBeNull();
  });
});

describe("patchOf", () => {
  test("passes the fields on and resolves the phone against the stored one", () => {
    const current = { phone: { number: "+14165550123", verified: true } };
    expect(patchOf({ nickname: "Ad", phone: "+14165550123" }, current)).toEqual(
      {
        nickname: "Ad",
        phone: { number: "+14165550123", verified: true },
      },
    );
    expect(patchOf({ phone: "+14165550199" }, current)).toEqual({
      phone: { number: "+14165550199", verified: false },
    });
    expect(patchOf({ phone: null }, current)).toEqual({ phone: null });
  });
  test("a change without a phone leaves it out", () => {
    expect(patchOf({ locale: "fr" }, { phone: null })).toEqual({
      locale: "fr",
    });
    expect(patchOf({}, { phone: null })).toEqual({});
  });
});

describe("standardClaims", () => {
  test("an empty profile releases updated_at only (in seconds)", () => {
    expect(standardClaims(emptyProfile(at))).toEqual({
      updated_at: at.getTime() / 1000,
    });
  });
  test("a full profile gives every standard claim, snake_case", () => {
    expect(
      standardClaims({
        givenName: "Ada",
        familyName: "Lovelace",
        nickname: "Ad",
        phone: { number: "+14165550123", verified: true },
        locale: "en-GB",
        zoneinfo: "Europe/London",
        birthdate: "1815-12-10",
        address: {
          formatted: "1 St James",
          streetAddress: "1 St James",
          locality: "London",
          region: "LDN",
          postalCode: "SW1",
          country: "GB",
        },
        pictureKey: null,
        updatedAt: at,
      }),
    ).toEqual({
      given_name: "Ada",
      family_name: "Lovelace",
      nickname: "Ad",
      phone_number: "+14165550123",
      phone_number_verified: true,
      locale: "en-GB",
      zoneinfo: "Europe/London",
      birthdate: "1815-12-10",
      address: {
        formatted: "1 St James",
        street_address: "1 St James",
        locality: "London",
        region: "LDN",
        postal_code: "SW1",
        country: "GB",
      },
      updated_at: at.getTime() / 1000,
    });
  });
  test("an address keeps only its parts, and an unverified phone says so", () => {
    const claims = standardClaims({
      ...emptyProfile(at),
      phone: { number: "+14165550123", verified: false },
      address: { country: "FR" },
    });
    expect(claims).toMatchObject({
      phone_number_verified: false,
      address: { country: "FR" },
    });
    expect(claims["address"]).toEqual({ country: "FR" });
  });
});

describe("policyShape", () => {
  test("shows the tenant id as hex", () => {
    const tenantId = new ObjectId();
    expect(
      policyShape({ tenantId, locked: ["PHONE"], version: 2, updatedAt: at }),
    ).toEqual({
      tenantId: tenantId.toHexString(),
      locked: ["PHONE"],
      version: 2,
      updatedAt: at,
    });
  });
});
