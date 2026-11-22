import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import { adminQueryOf, crossSite } from "./media.access";

const ID = "64b7f0f2a1c2d3e4f5a6b7c8";

describe("adminQueryOf", () => {
  test("no query is the signed-in user's own picture", () => {
    expect(adminQueryOf(new URL("https://x.test/media/avatar"))).toBeNull();
  });

  test("both ids name a user", () => {
    const url = new URL(`https://x.test/media/avatar?tenantId=${ID}&userId=u1`);
    expect(adminQueryOf(url)).toEqual({ tenantId: ID, userId: "u1" });
  });

  test("one id alone, or a tenant id that is no id, is a not_found", () => {
    for (const query of [
      `tenantId=${ID}`,
      "userId=u1",
      "tenantId=x&userId=u1",
    ]) {
      expect(() => adminQueryOf(new URL(`https://x.test/m?${query}`))).toThrow(
        MediaRefusal,
      );
    }
  });
});

describe("crossSite", () => {
  const withSite = (site?: string) =>
    new Request("https://x.test/media/avatar", {
      method: "PUT",
      headers: site === undefined ? {} : { "sec-fetch-site": site },
    });

  test("a browser's same-origin or direct request is not cross-site", () => {
    expect(crossSite(withSite("same-origin"))).toBe(false);
    expect(crossSite(withSite("none"))).toBe(false);
    expect(crossSite(withSite())).toBe(false);
  });

  test("another site or a sibling subdomain is", () => {
    expect(crossSite(withSite("cross-site"))).toBe(true);
    expect(crossSite(withSite("same-site"))).toBe(true);
  });
});
