import { describe, expect, test } from "bun:test";
import { extensionCodeOf } from "@/shared/errors";
import { propertyOf } from "@/shared/values";
import {
  checkUnlocked,
  cleanAddress,
  cleanBirthdate,
  cleanCountry,
  cleanLocale,
  cleanName,
  cleanPhoneNumber,
  cleanProfile,
  cleanText,
  cleanZoneinfo,
  MAX_NAME,
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

describe("cleanText", () => {
  test("trims, and keeps 1 to max characters", () => {
    expect(cleanText("  Ada ", "givenName", 100)).toBe("Ada");
    expect(cleanText("x".repeat(100), "givenName", 100)).toHaveLength(100);
  });
  test("refuses a blank or an over-long text, naming the field", () => {
    expect(refusal(() => cleanText("   ", "nickname", 100))).toEqual({
      code: "PROFILE_FIELD_INVALID",
      field: "nickname",
    });
    expect(
      refusal(() => cleanText("x".repeat(101), "nickname", 100))?.code,
    ).toBe("PROFILE_FIELD_INVALID");
  });
  test("counts characters, not code units", () => {
    expect(cleanText("😀".repeat(100), "nickname", 100)).toHaveLength(200);
  });
});

describe("cleanName", () => {
  test("trims the name", () => {
    expect(cleanName("  Ada Lovelace ")).toBe("Ada Lovelace");
  });

  test("refuses a blank name and one past 200 characters", () => {
    expect(refusal(() => cleanName("   "))?.code).toBe("BAD_USER_INPUT");
    expect(cleanName("a".repeat(MAX_NAME))).toHaveLength(MAX_NAME);
    expect(refusal(() => cleanName("a".repeat(MAX_NAME + 1)))?.code).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("cleanPhoneNumber (E.164)", () => {
  test("accepts + and 7 to 15 digits, dropping spaces, dots, dashes and brackets", () => {
    expect(cleanPhoneNumber("+14165550123")).toBe("+14165550123");
    expect(cleanPhoneNumber(" +1 (416) 555-0123 ")).toBe("+14165550123");
    expect(cleanPhoneNumber("+33.6.12.34.56.78")).toBe("+33612345678");
    expect(cleanPhoneNumber("+1234567")).toBe("+1234567");
    expect(cleanPhoneNumber("+123456789012345")).toBe("+123456789012345");
  });
  test("refuses no plus, a leading 0, too short, too long and letters", () => {
    for (const bad of [
      "4165550123",
      "+0123456789",
      "+123456",
      "+1234567890123456",
      "+1416abc0123",
      "",
    ]) {
      expect(refusal(() => cleanPhoneNumber(bad))).toEqual({
        code: "PROFILE_FIELD_INVALID",
        field: "phone",
      });
    }
  });
});

describe("cleanLocale (BCP 47)", () => {
  test("returns the canonical spelling", () => {
    expect(cleanLocale("fr")).toBe("fr");
    expect(cleanLocale(" fr-ca ")).toBe("fr-CA");
    expect(cleanLocale("en-us")).toBe("en-US");
  });
  test("refuses a malformed tag and the wildcard", () => {
    for (const bad of ["", "not a tag", "en_US", "*", "x"]) {
      expect(refusal(() => cleanLocale(bad))).toEqual({
        code: "PROFILE_FIELD_INVALID",
        field: "locale",
      });
    }
  });
});

describe("cleanZoneinfo (IANA)", () => {
  test("returns the zone as the runtime spells it, whatever the case", () => {
    expect(cleanZoneinfo("Europe/Paris")).toBe("Europe/Paris");
    expect(cleanZoneinfo(" america/toronto ")).toBe("America/Toronto");
    expect(cleanZoneinfo("utc")).toBe("UTC");
  });
  test("refuses an unknown zone and an offset", () => {
    for (const bad of ["Mars/Olympus", "+05:00", "", "Paris"]) {
      expect(refusal(() => cleanZoneinfo(bad))).toEqual({
        code: "PROFILE_FIELD_INVALID",
        field: "zoneinfo",
      });
    }
  });
});

describe("cleanBirthdate", () => {
  test("accepts a real date from 1900 up to today", () => {
    expect(cleanBirthdate("1990-02-28", TODAY)).toBe("1990-02-28");
    expect(cleanBirthdate("2000-02-29", TODAY)).toBe("2000-02-29");
    expect(cleanBirthdate("1900-01-01", TODAY)).toBe("1900-01-01");
    expect(cleanBirthdate("2026-11-22", TODAY)).toBe("2026-11-22");
  });
  test("refuses an impossible date, another form, before 1900 and the future", () => {
    for (const bad of [
      "1999-02-29",
      "2026-13-01",
      "2026-00-10",
      "1990-1-1",
      "1990/01/01",
      "1899-12-31",
      "2026-11-23",
      "not a date",
    ]) {
      expect(refusal(() => cleanBirthdate(bad, TODAY))).toEqual({
        code: "PROFILE_FIELD_INVALID",
        field: "birthdate",
      });
    }
  });
});

describe("cleanCountry (ISO 3166-1 alpha-2)", () => {
  test("upper-cases a known code", () => {
    expect(cleanCountry("fr")).toBe("FR");
    expect(cleanCountry(" CA ")).toBe("CA");
  });
  test("refuses an unassigned code, an alpha-3 code and a name", () => {
    for (const bad of ["ZZ", "FRA", "France", ""]) {
      expect(refusal(() => cleanCountry(bad))).toEqual({
        code: "PROFILE_FIELD_INVALID",
        field: "address.country",
      });
    }
  });
});

describe("cleanAddress", () => {
  test("keeps the parts given, trimmed, and checks the country", () => {
    expect(
      cleanAddress({
        streetAddress: " 1 rue X ",
        locality: "Paris",
        postalCode: "75001",
        region: null,
        formatted: "  ",
        country: "fr",
      }),
    ).toEqual({
      streetAddress: "1 rue X",
      locality: "Paris",
      postalCode: "75001",
      country: "FR",
    });
  });
  test("an address with no part left is cleared (null)", () => {
    expect(cleanAddress({})).toBeNull();
    expect(cleanAddress({ locality: " ", country: "" })).toBeNull();
  });
  test("refuses an over-long part and a bad country, naming the part", () => {
    expect(refusal(() => cleanAddress({ locality: "x".repeat(201) }))).toEqual({
      code: "PROFILE_FIELD_INVALID",
      field: "address.locality",
    });
    expect(
      refusal(() => cleanAddress({ formatted: "x".repeat(501) }))?.field,
    ).toBe("address.formatted");
    expect(refusal(() => cleanAddress({ country: "ZZ" }))?.field).toBe(
      "address.country",
    );
  });
});

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
