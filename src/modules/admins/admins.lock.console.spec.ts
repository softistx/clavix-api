import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import { RedisError } from "@softistx/redis";
import { GraphQLError } from "graphql";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { sharedLockOf } from "@/config/exclusive";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { createExclusive } from "@/console/exclusive";
import { userKey } from "@/console/modules/user-key";
import { adminScope, operatorScope } from "@/modules/invitations";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { instance } from "~/narrow";
import { quietJanus } from "~/ports";
import { adminInvitationHooks } from "./admins.hooks";
import { AdminsService } from "./admins.service";

// A Redis whose lock cannot be taken (held by another past `wait`) until `free`.
let held = true;
const redis = {
  lock: async <T>(_key: string, work: () => Promise<T>) => {
    if (held) throw new RedisError("LOCK_HELD", "k", "held");
    return work();
  },
};
const exclusive = createExclusive(sharedLockOf(redis));

let tenantId = "";
let member = "";
let owner = "";

beforeAll(async () => {
  tenantId = (await tenantsService.create({ slug: "lock-a", name: "Lock" })).id;
  member = "11111111-1111-4111-8111-111111111111";
  owner = "22222222-2222-4222-8222-222222222222";
  await access.grantTenant(tenantId, owner, "owner");
  await access.grantTenant(tenantId, member, "viewer");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $nin: [PLATFORM_TENANT_SLUG] },
  });
  for (const name of [
    "partitionedUsers",
    "partitionedSessions",
    "partitionedInvitations",
    "relations",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

const code503 = (error: unknown) => instance(error, GraphQLError).extensions;

describe("the tenant's membership lock cannot be taken", () => {
  test("a membership write is a retryable 503 and changes nothing", async () => {
    held = true;
    const service = new AdminsService({
      access,
      exclusive,
      directory: {
        findUser: async (id: string) => ({
          id,
          email: `${id}@t`,
          active: true,
        }),
      },
    });
    for (const write of [
      () => service.changeRole(tenantId, member, "admin"),
      () => service.removeMember(tenantId, member),
    ]) {
      const error = await write().catch((e: unknown) => e);
      expect(code503(error)).toEqual({
        code: "SERVICE_UNAVAILABLE",
        http: { status: 503 },
      });
    }
    expect(await access.holders(tenantId, "viewer")).toEqual([member]);
    // The lock frees: the same call goes through.
    held = false;
    await service.changeRole(tenantId, member, "admin");
    expect(await access.holders(tenantId, "admin")).toEqual([member]);
  });

  test("accepting an admin invitation stays retryable: the invitation is released and nothing granted", async () => {
    const clavix = await tenantResolver.resolveHost(
      `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
    );
    if (clavix === null) throw new Error("no clavix tenant");
    const auth = quietJanus(
      oauthDb,
      clavix,
      adminInvitationHooks({
        access,
        exclusive,
        userLock: (id) => userKey(clavix.tenantId, id),
        tenantActive: async () => true,
        findUser: async (id) => auth.findUser(id),
      }),
    );
    const { code } = await auth.invitations.issue({
      scope: adminScope(tenantId),
      email: "late@lock.test",
      name: "late",
      role: "admin",
      invitedBy: null,
    });
    held = true;
    const failed = await auth.invitations
      .accept({ code })
      .catch((e: unknown) => e);
    // janus lets the 503 through unchanged; the hosted resolver rethrows what
    // is not a janus refusal, so the invitee gets "try again later".
    expect(code503(failed)).toEqual({
      code: "SERVICE_UNAVAILABLE",
      http: { status: 503 },
    });
    const user = await auth.findByEmail("late@lock.test");
    const grantedWhileHeld =
      user === null
        ? false
        : (await access.holders(tenantId, "admin")).includes(user.id);
    expect(grantedWhileHeld).toBe(false);
    // The same code works once the lock is free, and grants the role once.
    held = false;
    const accepted = await auth.invitations.accept({ code });
    // The account was made by the first try; the retry finds it and grants.
    expect(accepted.status).toBe("signIn");
    const after = await auth.findByEmail("late@lock.test");
    expect(after).not.toBeNull();
    expect(await access.holders(tenantId, "admin")).toContain(after?.id ?? "");
  });
});

describe("the operator invitation (operators:grant --create)", () => {
  test("accepting it makes the account and grants the platform role once", async () => {
    const clavix = await tenantResolver.resolveHost(
      `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
    );
    if (clavix === null) throw new Error("no clavix tenant");
    held = false;
    const auth = quietJanus(
      oauthDb,
      clavix,
      adminInvitationHooks({
        access,
        exclusive,
        userLock: (id) => userKey(clavix.tenantId, id),
        tenantActive: async () => true,
        findUser: async (id) => auth.findUser(id),
      }),
    );
    const issue = (role: string) =>
      auth.invitations.issue({
        scope: operatorScope(),
        email: "first@operator.test",
        name: "first",
        role,
        invitedBy: null,
      });
    expect(await auth.findByEmail("first@operator.test")).toBeNull();
    const { code } = await issue("owner");
    const accepted = await auth.invitations.accept({ code });
    expect(accepted.status).not.toBe("failed");
    const user = await auth.findByEmail("first@operator.test");
    expect(user).not.toBeNull();
    expect(await access.platformRole(user?.id ?? "")).toBe("owner");
    // A later invitation with a weaker role does not downgrade the account.
    const again = await issue("viewer");
    await auth.invitations.accept({ code: again.code });
    expect(await access.platformRole(user?.id ?? "")).toBe("owner");
  });
});

describe("an owner invitation for an account that is gone", () => {
  test("is INVITATION_INVALID and grants nothing", async () => {
    const clavix = await tenantResolver.resolveHost(
      `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
    );
    if (clavix === null) throw new Error("no clavix tenant");
    held = false;
    const auth = quietJanus(
      oauthDb,
      clavix,
      adminInvitationHooks({
        access,
        exclusive,
        userLock: (id) => userKey(clavix.tenantId, id),
        tenantActive: async () => true,
        findUser: async () => null,
      }),
    );
    const { code } = await auth.invitations.issue({
      scope: operatorScope(),
      email: "ghost@owner.test",
      name: "ghost",
      role: "owner",
      invitedBy: null,
    });
    const failed = await auth.invitations
      .accept({ code })
      .catch((e: unknown) => e);
    expect(instance(failed, JanusError).code).toBe("INVITATION_INVALID");
    const user = await auth.findByEmail("ghost@owner.test");
    expect(
      user === null ? null : await access.platformRole(user.id),
    ).toBeNull();
  });
});
