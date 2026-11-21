import { describe, expect, test } from "bun:test";
import type { ConsoleContext } from "@/console/context";
import { createExclusive } from "@/console/exclusive";
import type { Role } from "@/console/model";
import { withMembers } from "~/members";
import { keepOwners, type OwnerChange } from "./users.owners";

const PLATFORM = { slug: "clavix" };

interface Setup {
  /** Tenant id -> owner ids. */
  owners?: Record<string, string[]>;
  /** The platform owners. */
  platform?: string[];
  disabled?: string[];
  gone?: string[];
  /** The users whose e-mail is not proved. */
  unverified?: string[];
  /** What the caller may do on the platform; everything by default. */
  manage?: boolean;
  /** Called on each read of the user's memberships: lets a spec grant meanwhile. */
  onMemberships?: (call: number) => void;
}

/** A console context in memory: only what `keepOwners` reads. */
function fake(setup: Setup = {}) {
  const owners = setup.owners ?? {};
  const platform = setup.platform ?? [];
  let reads = 0;
  const ctx = withMembers({
    exclusive: createExclusive(),
    canPlatform: async () => setup.manage ?? true,
    directory: {
      emailVerified: async (id: string) =>
        !(setup.unverified ?? []).includes(id),
      findUser: async (id: string) =>
        (setup.gone ?? []).includes(id)
          ? null
          : {
              id,
              email: `${id}@t.test`,
              active: !(setup.disabled ?? []).includes(id),
            },
    },
    access: {
      platformRole: async (id: string): Promise<Role | null> =>
        platform.includes(id) ? "owner" : null,
      platformOwners: async () => [...platform],
      owners: async (tenantId: string) => [...(owners[tenantId] ?? [])],
      memberships: async (id: string) => {
        setup.onMemberships?.(++reads);
        return Object.entries(owners)
          .filter(([, ids]) => ids.includes(id))
          .map(([tenantId]) => ({ tenantId, role: "owner" as const }));
      },
    },
  });
  return ctx;
}

const code = async (run: Promise<unknown>) =>
  run.then(
    () => "ok",
    (e: { extensions?: { code?: string } }) => e.extensions?.code,
  );
const disable = (ctx: ConsoleContext, id: string) =>
  keepOwners(ctx, PLATFORM, id, async () => "done", "disable", `u:${id}`);
const remove = (ctx: ConsoleContext, id: string) =>
  keepOwners(ctx, PLATFORM, id, async () => "done", "delete", `u:${id}`);

describe("the last live platform owner", () => {
  test("cannot be disabled or deleted", async () => {
    const ctx = fake({ platform: ["p1", "p2"], disabled: ["p2"] });
    expect(await code(disable(ctx, "p1"))).toBe("LAST_OWNER");
    expect(await code(remove(ctx, "p1"))).toBe("LAST_OWNER");
  });

  test("a second live platform owner lets the first go", async () => {
    const ctx = fake({ platform: ["p1", "p2"] });
    expect(await code(disable(ctx, "p1"))).toBe("ok");
    expect(await code(remove(ctx, "p1"))).toBe("ok");
  });

  test("two platform owners removed at the same moment: one stays", async () => {
    const platform = ["p1", "p2"];
    const ctx = fake({ platform });
    const drop = (id: string) =>
      keepOwners(
        ctx,
        PLATFORM,
        id,
        async () => {
          platform.splice(platform.indexOf(id), 1);
        },
        "delete",
        `u:${id}`,
      );
    const results = await Promise.all([drop("p1"), drop("p2")].map(code));
    expect(results.sort()).toEqual(["LAST_OWNER", "ok"]);
    expect(platform).toHaveLength(1);
  });
});

describe("the user lock", () => {
  test("is held when the memberships are read the last time", async () => {
    const key = "u:o1";
    const held: string[] = [];
    let readsUnder: boolean[] = [];
    const base = fake({
      owners: { t1: ["o1", "o2"] },
      onMemberships: () => {
        readsUnder.push(held.includes(key));
      },
    });
    const inner = base.exclusive;
    (base as { exclusive: unknown }).exclusive = ((
      k: string,
      work: () => Promise<unknown>,
    ) =>
      inner(k, () => {
        held.push(k);
        return work().finally(() => held.pop());
      })) as typeof base.exclusive;
    readsUnder = [];
    await keepOwners(base, PLATFORM, "o1", async () => "done", "delete", key);
    // The first reads (the guard, the tenants to lock) are before any lock; the
    // one that decides runs under the user lock.
    expect(readsUnder.at(-1)).toBe(true);
  });
});

describe("disabling twice", () => {
  test("a disabled sole owner is disabled again, not refused", async () => {
    const ctx = fake({
      owners: { t1: ["sole"] },
      platform: ["sole", "other"],
      disabled: ["sole"],
    });
    expect(await code(disable(ctx, "sole"))).toBe("ok");
  });

  test("a live sole owner is still refused", async () => {
    const ctx = fake({ owners: { t1: ["sole"] } });
    expect(await code(disable(ctx, "sole"))).toBe("LAST_OWNER");
  });
});

describe("the memberships keep changing", () => {
  test("three reads that each find a new tenant answer CONFLICT (409)", async () => {
    const owners: Record<string, string[]> = { t1: ["u", "v"] };
    const ctx = fake({
      owners,
      // A new tenant is granted at each read inside the lock.
      onMemberships: (call) => {
        if (call >= 2) owners[`n${call}`] = ["u", "v"];
      },
    });
    const error = await disable(ctx, "u").catch((e: unknown) => e);
    const { extensions } = error as {
      extensions: { code: string; http: { status: number } };
    };
    expect(extensions).toEqual({ code: "CONFLICT", http: { status: 409 } });
  });
});

const change = (ctx: ConsoleContext, id: string, kind: OwnerChange) =>
  keepOwners(ctx, PLATFORM, id, async () => "done", kind, `u:${id}`);

describe("un-verifying an owner", () => {
  test("the last live platform owner keeps a proved e-mail", async () => {
    const ctx = fake({ platform: ["a", "b"], disabled: ["b"] });
    expect(await code(change(ctx, "a", "unverify"))).toBe("LAST_OWNER");
  });

  test("the only owner of a tenant too", async () => {
    const ctx = fake({ owners: { t1: ["a"] } });
    expect(await code(change(ctx, "a", "unverify"))).toBe("LAST_OWNER");
  });

  test("with another live owner it goes through", async () => {
    const ctx = fake({ platform: ["a", "b"] });
    expect(await code(change(ctx, "a", "unverify"))).toBe("ok");
  });

  test("twice changes nothing, so it is not refused", async () => {
    const ctx = fake({ platform: ["a"], unverified: ["a"] });
    expect(await code(change(ctx, "a", "unverify"))).toBe("ok");
  });
});

describe("a change that keeps the owners (enable, sign out, reset the second factor)", () => {
  test("needs platform manage on an owner, whatever the kind", async () => {
    const ctx = fake({ platform: ["a", "b"], manage: false });
    for (const kind of ["touch", "unverify", "disable", "delete"] as const) {
      expect([kind, await code(change(ctx, "a", kind))]).toEqual([
        kind,
        "FORBIDDEN",
      ]);
    }
  });

  test("is never LAST_OWNER", async () => {
    const ctx = fake({ platform: ["a"], owners: { t1: ["a"] } });
    expect(await code(change(ctx, "a", "touch"))).toBe("ok");
  });

  test("a user with no role is anyone's with edit", async () => {
    const ctx = fake({ manage: false });
    expect(await code(change(ctx, "nobody", "touch"))).toBe("ok");
    expect(await code(change(ctx, "nobody", "unverify"))).toBe("ok");
  });
});
