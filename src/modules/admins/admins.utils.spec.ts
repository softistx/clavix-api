import { describe, expect, it } from "bun:test";
import {
  GRAPHQL_ROLE,
  memberOf,
  membersKey,
  PLATFORM_OWNERS_KEY,
  ROLE_OF,
  resendKey,
  roleOf,
  shapeInvitation,
} from "./admins.utils";

describe("admins utils", () => {
  it("maps each role both ways", () => {
    expect(GRAPHQL_ROLE.owner).toBe("OWNER");
    expect(ROLE_OF.VIEWER).toBe("viewer");
  });

  it("builds the lock keys", () => {
    expect(membersKey("t1")).toBe("console:members:t1");
    expect(PLATFORM_OWNERS_KEY).toBe("console:platform-owners");
    expect(resendKey("t1", "i1")).toBe("console:resend:t1:i1");
  });

  it("shapes a member with a null name when absent", () => {
    expect(memberOf({ id: "u", email: "a@b.c" }, "admin")).toEqual({
      user: { id: "u", email: "a@b.c", name: null },
      role: "ADMIN",
    });
  });

  it("shapes an invitation with its inviter's name, or null", () => {
    const names = new Map([["u", "Ann"]]);
    const base = { id: "i", role: "owner" as const };
    expect(shapeInvitation({ ...base, invitedBy: "u" }, names)).toEqual({
      id: "i",
      role: "OWNER",
      invitedBy: { id: "u", name: "Ann" },
    });
    expect(
      shapeInvitation({ ...base, invitedBy: "x" }, names).invitedBy,
    ).toEqual({
      id: "x",
      name: null,
    });
    expect(
      shapeInvitation({ ...base, invitedBy: null }, names).invitedBy,
    ).toBeNull();
  });
});

describe("roleOf", () => {
  const access = (held: Record<string, string[]>) => ({
    holders: async (_tenant: string, role: string) => held[role] ?? [],
  });

  it("answers the strongest role held, or null", async () => {
    const held = access({ owner: ["a"], admin: ["a", "b"], viewer: ["c"] });
    expect(await roleOf(held, "t", "a")).toBe("owner");
    expect(await roleOf(held, "t", "b")).toBe("admin");
    expect(await roleOf(held, "t", "c")).toBe("viewer");
    expect(await roleOf(held, "t", "d")).toBeNull();
  });
});
