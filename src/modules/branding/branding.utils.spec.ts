import { describe, expect, test } from "bun:test";
import { ConflictError, OptimisticLockError } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { branding } from "./branding.model";
import type { BrandFields, StoredBrandingDoc } from "./branding.types";
import { lostRace, sameBrand } from "./branding.utils";

const fields: BrandFields = {
  displayName: "Acme",
  seed: "#336699",
  radius: "md",
  backgroundPreset: null,
  motif: null,
  css: ":root{}",
  logo: { contentType: "image/png", data: "AA==", hash: "h1", size: 1 },
};
const stored = (over: Partial<BrandFields> = {}): StoredBrandingDoc => {
  const _id = new ObjectId();
  const at = new Date(0);
  return {
    ...branding.schema.parse({
      _id,
      tenantId: new ObjectId(),
      ...fields,
      ...over,
      createdAt: at,
      updatedAt: at,
      version: 0,
    }),
    id: _id.toHexString(),
  };
};

describe("sameBrand", () => {
  test("is true for the same fields", () => {
    expect(sameBrand(stored(), fields)).toBe(true);
  });
  test("is false when any field differs", () => {
    for (const over of [
      { displayName: "B" },
      { seed: "#000000" },
      { radius: "lg" },
      { backgroundPreset: "dots" },
      { motif: "star" },
      { css: "x" },
      { logo: null },
    ]) {
      expect(sameBrand(stored(over), fields)).toBe(false);
    }
  });
});

describe("lostRace", () => {
  test("is true for a version or unique-index loss only", () => {
    expect(lostRace(new OptimisticLockError("x"))).toBe(true);
    expect(lostRace(new ConflictError("x"))).toBe(true);
    expect(lostRace(new Error("boom"))).toBe(false);
  });
});
