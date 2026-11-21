import { describe, expect, test } from "bun:test";
import { TenantUnavailableError } from "@/modules/invitations/invitations.errors";
import type { TenantInvitations } from "@/modules/invitations/invitations.types";
import type { TenantJanus } from "./tenant-janus";
import { UsersService } from "./users.service";

// A tenant suspended or deleted between the console's own check and the call
// is "not found", like any other call that names it, never a plain 500.
const away: TenantInvitations = {
  invite: async () => {
    throw new TenantUnavailableError();
  },
  pending: async () => {
    throw new TenantUnavailableError();
  },
  revoke: async () => {
    throw new TenantUnavailableError();
  },
} as unknown as TenantInvitations;
const users = new UsersService({
  janusOf: async () => null,
  grantsOf: async () => null,
  invitationsOf: () => away,
});
const notFound = { extensions: { code: "NOT_FOUND" } };

describe("a tenant that went away mid-request", () => {
  test("its invitations answer NOT_FOUND", async () => {
    await expect(
      users.invite({
        tenantId: "t",
        tenantName: "T",
        email: "a@b.test",
        invitedBy: { id: "u" },
      }),
    ).rejects.toMatchObject(notFound);
    await expect(users.invitations("t")).rejects.toMatchObject(notFound);
    await expect(users.revokeInvitation("t", "i")).rejects.toMatchObject(
      notFound,
    );
  });

  test("its pool and grants answer NOT_FOUND", async () => {
    await expect(users.find("t", "u")).rejects.toMatchObject(notFound);
    await expect(users.delete("t", "u")).rejects.toMatchObject(notFound);
    await expect(users.grants("t", "u")).rejects.toMatchObject(notFound);
  });
});

const poolUser = (id: string, email: string, name: string) => ({
  id,
  logins: { email },
  name,
  active: true,
  fields: { email, name },
});

describe("lookup", () => {
  test("asks janus for the e-mail prefix, then the name prefix, each user once, capped", async () => {
    const calls: Record<string, unknown>[] = [];
    const byMail = poolUser("1", "ada@x.test", "Other");
    const both = poolUser("2", "ada.b@x.test", "Ada B");
    const byName = poolUser("3", "zz@x.test", "Ada Lovelace");
    const auth = {
      list: async (filter: Record<string, unknown>) => {
        calls.push(filter);
        const items = "emailPrefix" in filter ? [byMail, both] : [both, byName];
        return { items, nextCursor: null };
      },
    } as unknown as TenantJanus;
    const users = new UsersService({
      janusOf: async () => auth,
      grantsOf: async () => null,
      invitationsOf: () => {
        throw new Error("unused");
      },
    });
    const found = await users.lookup("t", "ada", 3);
    expect(found.map((u) => u.id)).toEqual(["1", "2", "3"]);
    expect(calls).toEqual([
      { limit: 3, emailPrefix: "ada" },
      { limit: 5, namePrefix: "ada" },
    ]);
    expect((await users.lookup("t", "ada", 2)).map((u) => u.id)).toEqual([
      "1",
      "2",
    ]);
    expect(calls).toHaveLength(3);
  });
});
