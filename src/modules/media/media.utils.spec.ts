import { describe, expect, test } from "bun:test";
import {
  avatarObjectKey,
  pictureUrl,
  tenantFolder,
  tenantListPrefix,
} from "./media.utils";

const KEY = "0b6f3d1e-6b1f-4c3a-9a53-8f6d0e3d2a11";

describe("media utils", () => {
  test("the picture claim is the issuer's media route, never a bucket URL", () => {
    expect(pictureUrl("https://acme.clavix.io", KEY)).toBe(
      `https://acme.clavix.io/media/avatar/${KEY}`,
    );
    expect(pictureUrl("https://acme.clavix.io/", KEY)).toBe(
      `https://acme.clavix.io/media/avatar/${KEY}`,
    );
  });

  test("an object lives under its tenant's folder, as the routes lay it out", () => {
    expect(tenantFolder("t1")).toBe("t1");
    expect(avatarObjectKey("t1", KEY)).toBe(`t1/avatar/${KEY}`);
  });

  test("a tenant's listing prefix ends in a slash, so no other id matches", () => {
    expect(tenantListPrefix("t1")).toBe("t1/");
    expect(avatarObjectKey("t10", KEY).startsWith(tenantListPrefix("t1"))).toBe(
      false,
    );
  });
});
