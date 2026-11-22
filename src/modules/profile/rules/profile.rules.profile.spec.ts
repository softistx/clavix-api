import { describe, expect, test } from "bun:test";
import { extensionCodeOf } from "@/shared/errors";
import { propertyOf } from "@/shared/values";
import {
  checkUnlocked,
  cleanProfile,
  sortedLocks,
  touchedFields,
} from "./profile.rules";

const TODAY = new Date("2026-11-22T12:00:00Z");

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return {
      code: extensionCodeOf(error),
      field: propertyOf(propertyOf(error, "extensions"), "field"),
    };
  }
  return null;
};

describe("cleanProfile", () => {
  test("names only the keys it was given", () => {
    expect(cleanProfile({}, TODAY)).toEqual({});
    expect(cleanProfile({ nickname: " Ad " }, TODAY)).toEqual({
      nickname: "Ad",
    });
  });
  test("null and a blank text clear a field", () => {
    expect(
      cleanProfile(
        {
          givenName: null,
          familyName: "  ",
          phone: null,
          locale: "",
          zoneinfo: null,
          birthdate: " ",
          address: null,
        },
        TODAY,
      ),
    ).toEqual({
      givenName: null,
      familyName: null,
      phone: null,
      locale: null,
      zoneinfo: null,
      birthdate: null,
      address: null,
    });
  });
  test("normalises every field and an empty address clears it", () => {
    expect(
      cleanProfile(
        {
          givenName: "Ada",
          phone: "+1 416 555 0123",
          locale: "fr-ca",
          zoneinfo: "europe/paris",
          birthdate: "1990-12-10",
          address: { locality: "Paris", country: "fr" },
        },
        TODAY,
      ),
    ).toEqual({
      givenName: "Ada",
      phone: "+14165550123",
      locale: "fr-CA",
      zoneinfo: "Europe/Paris",
      birthdate: "1990-12-10",
      address: { locality: "Paris", country: "FR" },
    });
    expect(cleanProfile({ address: { locality: "" } }, TODAY)).toEqual({
      address: null,
    });
  });
  test("refuses the first bad field", () => {
    expect(refusal(() => cleanProfile({ phone: "12" }, TODAY))?.field).toBe(
      "phone",
    );
    expect(
      refusal(() => cleanProfile({ birthdate: "2999-01-01" }, TODAY))?.field,
    ).toBe("birthdate");
  });
});

describe("locks", () => {
  test("touchedFields maps the keys of a change to the lockable fields", () => {
    expect(
      touchedFields({
        name: "A",
        givenName: null,
        phone: "+14165550123",
        address: null,
      }),
    ).toEqual(["NAME", "GIVEN_NAME", "PHONE", "ADDRESS"]);
    expect(touchedFields({})).toEqual([]);
  });
  test("checkUnlocked passes an unlocked change and refuses a locked field with 403", () => {
    expect(() => checkUnlocked({ nickname: "x" }, ["PHONE"])).not.toThrow();
    expect(() => checkUnlocked({}, ["PHONE", "NAME"])).not.toThrow();
    expect(
      refusal(() => checkUnlocked({ nickname: "x", phone: null }, ["PHONE"])),
    ).toEqual({
      code: "PROFILE_FIELD_LOCKED",
      field: "PHONE",
    });
  });
  test("sortedLocks keeps each field once, in the order of the fields", () => {
    expect(sortedLocks(["PHONE", "NAME", "PHONE", "ADDRESS"])).toEqual([
      "NAME",
      "PHONE",
      "ADDRESS",
    ]);
    expect(sortedLocks([])).toEqual([]);
  });
});
