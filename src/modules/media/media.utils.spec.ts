import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import type { AvatarTarget } from "./media.types";
import {
  adminQueryOf,
  avatarObjectKey,
  crossSite,
  pictureUrl,
  removePicture,
  tenantFolder,
  tenantListPrefix,
} from "./media.utils";

const ID = "64b7f0f2a1c2d3e4f5a6b7c8";
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

describe("removePicture", () => {
  const calls: unknown[] = [];
  const over = (avatar: { updatedAt: Date } | null | "gone"): AvatarTarget => {
    calls.length = 0;
    return {
      tenantId: "t",
      userId: "u",
      auth: {
        findUser: async () =>
          avatar === "gone" ? null : { id: "u", version: 7, avatar },
        avatar: {
          remove: async (_id: unknown, options?: unknown) => {
            calls.push(options);
          },
        },
      } as unknown as AvatarTarget["auth"],
    };
  };
  const picture = { updatedAt: new Date(1000) };

  test("with neither option it removes unconditionally", async () => {
    expect(await removePicture(over(picture))).toBe(true);
    expect(calls).toEqual([undefined]);
  });

  test("ifVersion makes the removal conditional on the version read", async () => {
    expect(await removePicture(over(picture), { ifVersion: true })).toBe(true);
    expect(calls).toEqual([{ ifVersion: 7 }]);
  });

  test("setUntil keeps a picture set after it, and removes an older one", async () => {
    expect(
      await removePicture(over(picture), { setUntil: new Date(500) }),
    ).toBe(false);
    expect(calls).toEqual([]);
    expect(
      await removePicture(over(picture), { setUntil: new Date(2000) }),
    ).toBe(true);
    expect(calls).toEqual([undefined]);
  });

  test("none is false and an unknown user is null", async () => {
    expect(await removePicture(over(null))).toBe(false);
    expect(await removePicture(over("gone"))).toBeNull();
    expect(calls).toEqual([]);
  });
});
