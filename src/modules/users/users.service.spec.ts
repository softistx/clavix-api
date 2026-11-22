import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import type { TenantInvitations } from "@/modules/invitations";
import { TenantUnavailableError } from "@/modules/invitations";
import { acmeJanus } from "~/acme-janus";
import { UsersService } from "./users.service";
import type { TenantJanus } from "./users.tenant-janus";

// A tenant suspended or deleted between the console's own check and the call
// is "not found", like any other call that names it, never a plain 500.
const away: TenantInvitations = {
  invite: async () => {
    throw new TenantUnavailableError();
  },
  pending: async () => {
    throw new TenantUnavailableError();
  },
  resend: async () => {
    throw new TenantUnavailableError();
  },
  revoke: async () => {
    throw new TenantUnavailableError();
  },
};
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
  type: "user" as const,
  email,
  name,
  emailVerified: true,
  active: true,
  hasPassword: false,
  hasSecondFactor: false,
  avatar: null,
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("lookup", () => {
  test("asks janus for the e-mail prefix, then the name prefix, each user once, capped", async () => {
    const calls: Record<string, unknown>[] = [];
    const byMail = poolUser("1", "ada@x.test", "Other");
    const both = poolUser("2", "ada.b@x.test", "Ada B");
    const byName = poolUser("3", "zz@x.test", "Ada Lovelace");
    const auth: TenantJanus = {
      ...acmeJanus(),
      list: async (filter: Record<string, unknown>) => {
        calls.push(filter);
        const items = "emailPrefix" in filter ? [byMail, both] : [both, byName];
        return { items, nextCursor: null };
      },
    };
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

describe("update and setPhoneVerified", () => {
  const withPhone = (verified: boolean) => ({
    ...poolUser("1", "ada@x.test", "Ada"),
    phone: { number: "+14165550123", verified },
  });
  const serviceOver = (
    user: ReturnType<typeof poolUser>,
    updates: { patch: unknown; options: unknown }[],
    failWith?: JanusError,
  ) => {
    const auth: TenantJanus = {
      ...acmeJanus(),
      findUser: async () => user,
      update: async (_user, patch, options) => {
        if (failWith !== undefined) throw failWith;
        updates.push({ patch, options });
        return { ...user, ...patch, version: user.version + 1 };
      },
    };
    return new UsersService({
      janusOf: async () => auth,
      grantsOf: async () => null,
      invitationsOf: () => {
        throw new Error("unused");
      },
    });
  };

  test("update writes the patch at the version it read", async () => {
    const updates: { patch: unknown; options: unknown }[] = [];
    const users = serviceOver(withPhone(true), updates);
    await users.update("t", "1", { givenName: "Ada", phone: "+14165550177" });
    expect(updates).toEqual([
      {
        patch: {
          givenName: "Ada",
          phone: { number: "+14165550177", verified: false },
        },
        options: { ifVersion: 1 },
      },
    ]);
  });

  test("update keeps the flag of an unchanged number and writes nothing for no change", async () => {
    const updates: { patch: unknown; options: unknown }[] = [];
    const users = serviceOver(withPhone(true), updates);
    await users.update("t", "1", { phone: "+14165550123" });
    expect(updates[0]?.patch).toEqual({
      phone: { number: "+14165550123", verified: true },
    });
    await users.update("t", "1", {});
    expect(updates).toHaveLength(1);
  });

  test("update maps a janus VERSION_CONFLICT to CONFLICT, an unknown user to null", async () => {
    const conflict = Object.assign(new JanusError("stale"), {
      code: "VERSION_CONFLICT",
    });
    await expect(
      serviceOver(withPhone(true), [], conflict).update("t", "1", {
        givenName: "x",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(
      await new UsersService({
        janusOf: async () => ({ ...acmeJanus(), findUser: async () => null }),
        grantsOf: async () => null,
        invitationsOf: () => {
          throw new Error("unused");
        },
      }).update("t", "9", { givenName: "x" }),
    ).toBeNull();
  });

  test("setPhoneVerified flips the flag, keeps the number, and writes nothing on a repeat", async () => {
    const updates: { patch: unknown; options: unknown }[] = [];
    await serviceOver(withPhone(false), updates).setPhoneVerified(
      "t",
      "1",
      true,
    );
    expect(updates).toEqual([
      {
        patch: { phone: { number: "+14165550123", verified: true } },
        options: { ifVersion: 1 },
      },
    ]);
    await serviceOver(withPhone(true), updates).setPhoneVerified(
      "t",
      "1",
      true,
    );
    expect(updates).toHaveLength(1);
  });

  test("setPhoneVerified on a user with no phone is PROFILE_FIELD_INVALID", async () => {
    await expect(
      serviceOver(poolUser("1", "a@x.test", "A"), []).setPhoneVerified(
        "t",
        "1",
        true,
      ),
    ).rejects.toMatchObject({
      extensions: { code: "PROFILE_FIELD_INVALID" },
    });
  });
});
