import { describe, expect, test } from "bun:test";
import { createExclusive } from "@/console/exclusive";
import { withMembers } from "~/members";

const exclusive = createExclusive(null);

describe("withMembers", () => {
  test("answers the membership calls from the faked access and directory", async () => {
    const context = withMembers({
      exclusive,
      access: {
        holders: async (_tenant, role) =>
          role === "owner" ? ["u1", "gone"] : role === "viewer" ? ["u2"] : [],
      },
      directory: {
        findUser: async (id) =>
          id === "gone" ? null : { id, email: `${id}@x.test`, active: true },
      },
    });
    const members = await context.members.members("t1");
    expect(members.map((member) => [member.user.id, member.role])).toEqual([
      ["u1", "owner"],
      ["u2", "viewer"],
    ]);
  });

  test("grants everything unless the spec says", async () => {
    const context = withMembers({ exclusive });
    expect(await context.can("view", "t1")).toBeTrue();
    expect(await context.canPlatform("view")).toBeTrue();
  });

  test("lays the faked can and canPlatform over the defaults", async () => {
    const context = withMembers({
      exclusive,
      can: async () => false,
      canPlatform: async () => false,
    });
    expect(await context.can("view", "t1")).toBeFalse();
    expect(await context.canPlatform("view")).toBeFalse();
  });

  test("builds a context of the console, one per call", () => {
    const first = withMembers({ exclusive });
    const second = withMembers({ exclusive });
    expect(first.principal.scopes).toEqual(["console"]);
    expect(first.request.url).toBe("http://localhost/console/graphql");
    expect(first.exclusive).toBe(exclusive);
    expect(first.signal).not.toBe(second.signal);
  });
});
