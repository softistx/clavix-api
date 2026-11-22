import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import type { MediaStore } from "../media.bucket";
import { AvatarObjectsService } from "./objects.service";

/** A store of keys: only what the service asks of it (`delete`, `list`). */
function storeOf(initial: string[], failing = false) {
  const keys = new Set(initial);
  const store: MediaStore = {
    open: async () => {
      throw new MediaRefusal("unavailable");
    },
    put: async () => {
      throw new MediaRefusal("unavailable");
    },
    delete: async ({ key }) => {
      if (failing) throw new Error("storage down");
      keys.delete(key);
    },
    list: async ({ prefix = "", limit = 1000, cursor = null } = {}) => {
      const all = [...keys].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor === null ? 0 : all.indexOf(cursor) + 1;
      const page = all.slice(from, from + limit);
      const last = page.at(-1);
      return {
        items: page.map((key) => ({
          key,
          size: 1,
          eTag: "etag",
          lastModified: new Date(0),
        })),
        nextCursor:
          from + limit < all.length && last !== undefined ? last : null,
      };
    },
  };
  return { keys, store };
}

describe("AvatarObjectsService", () => {
  test("remove deletes the tenant's object of a key", async () => {
    const { keys, store } = storeOf(["t1/avatar/k1", "t1/avatar/k2"]);
    await new AvatarObjectsService(store, () => {}).remove("t1", "k1");
    expect([...keys]).toEqual(["t1/avatar/k2"]);
  });

  test("remove on a failing store is a logged 503", async () => {
    const logs: string[] = [];
    const { store } = storeOf([], true);
    const error = await new AvatarObjectsService(store, (m) => logs.push(m))
      .remove("t1", "k1")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      extensions: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(logs).toHaveLength(1);
  });

  test("removeFormer does nothing for a first picture", async () => {
    const { keys, store } = storeOf(["t1/avatar/k1"]);
    await new AvatarObjectsService(store, () => {}).removeFormer("t1", null);
    expect(keys.size).toBe(1);
  });

  test("removeFormer deletes the replaced object and never throws", async () => {
    const { keys, store } = storeOf(["t1/avatar/old"]);
    await new AvatarObjectsService(store, () => {}).removeFormer("t1", "old");
    expect(keys.size).toBe(0);
    const logs: string[] = [];
    const failing = storeOf([], true).store;
    await new AvatarObjectsService(failing, (m) => logs.push(m)).removeFormer(
      "t1",
      "old",
    );
    expect(logs).toHaveLength(1);
  });

  test("purgeTenant removes every page of the tenant's folder and no other tenant's", async () => {
    const mine = Array.from({ length: 1200 }, (_, i) => `t1/avatar/${i}`);
    const { keys, store } = storeOf([...mine, "t10/avatar/x", "t2/avatar/y"]);
    const removed = await new AvatarObjectsService(store, () => {}).purgeTenant(
      "t1",
    );
    expect(removed).toBe(1200);
    expect([...keys].sort()).toEqual(["t10/avatar/x", "t2/avatar/y"]);
  });
});
