import { describe, expect, test } from "bun:test";
import type {
  ConsoleContext,
  TenantUserView,
  UserSecondFactorView,
} from "@/console/context";
import { createExclusive } from "@/console/exclusive";
import { emptyProfile } from "@/modules/profile";
import { withMembers } from "~/members";
import { secondFactorLoader, userLoader } from "./users.data-loader";

const NO_FACTOR: UserSecondFactorView = {
  enabled: false,
  recoveryCodesLeft: null,
};
const user = (id: string): TenantUserView => ({
  id,
  email: `${id}@x.test`,
  emailVerified: true,
  active: true,
  createdAt: new Date(0),
  profile: emptyProfile(new Date(0)),
});

const requestWith = (users: Partial<ConsoleContext["users"]>) =>
  withMembers({ exclusive: createExclusive(null), users });

describe("userLoader", () => {
  test("loads of one tick are ONE findMany, in key order, null for a missing id", async () => {
    const calls: (readonly string[])[] = [];
    const ctx = requestWith({
      findMany: async (_tenant, ids) => {
        calls.push(ids);
        return ids.map((id) => (id === "gone" ? null : user(id)));
      },
    });
    const loader = userLoader(ctx, "t1");
    const out = await Promise.all(
      ["b", "gone", "a"].map((id) => loader.load(id)),
    );
    expect(calls).toEqual([["b", "gone", "a"]]);
    expect(out.map((row) => row?.id ?? null)).toEqual(["b", null, "a"]);
  });

  test("one loader per request and tenant, nothing shared between requests", async () => {
    const reads: string[] = [];
    const users = {
      findMany: async (tenant: string, ids: readonly string[]) => {
        reads.push(tenant);
        return ids.map(user);
      },
    };
    const one = requestWith(users);
    expect(userLoader(one, "t1")).toBe(userLoader(one, "t1"));
    expect(userLoader(one, "t1")).not.toBe(userLoader(one, "t2"));
    expect(userLoader(requestWith(users), "t1")).not.toBe(
      userLoader(one, "t1"),
    );
    await userLoader(one, "t1").load("a");
    await userLoader(one, "t2").load("a");
    expect(reads).toEqual(["t1", "t2"]);
  });
});

describe("secondFactorLoader", () => {
  test("loads of one tick are ONE secondFactors call, in key order", async () => {
    let calls = 0;
    const ctx = requestWith({
      secondFactors: async (_tenant, ids) => {
        calls += 1;
        return ids.map((id) =>
          id === "on" ? { enabled: true, recoveryCodesLeft: 10 } : NO_FACTOR,
        );
      },
    });
    const loader = secondFactorLoader(ctx, "t1");
    const out = await Promise.all(["off", "on"].map((id) => loader.load(id)));
    expect(calls).toBe(1);
    expect(out.map((row) => row.enabled)).toEqual([false, true]);
  });
});
