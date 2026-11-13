import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, forTenant } from "@/config/users";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { CONSOLE_PATH } from "../../identity";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  resolver: tenantResolver,
  db: oauthDb,
  signingKeysFor: (tenantId) => {
    let store = keys.get(tenantId);
    if (store === undefined) {
      store = createMemorySigningKeys();
      keys.set(tenantId, store);
    }
    return store;
  },
  authFor,
  claimsFor,
  resourcesFor,
});
// The bearer token is the user id: tokens are console.spec's business.
const deps = createConsoleDeps(issuers);
const app = createApp({
  oauth: issuers,
  console: {
    ...deps,
    authenticate: async (request) => {
      const userId = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      return userId === undefined
        ? null
        : { userId, clientId: "spec", grantId: "spec", scopes: ["console"] };
    },
  },
});
const memory = mailer as MemoryMailer;

interface Answer {
  // biome-ignore lint/suspicious/noExplicitAny: a spec reads the answer by path
  data: Record<string, any> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}
async function post(url: string, query: string, bearer?: string) {
  const response = await app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as Answer;
  return { ...body, data: body.data ?? null };
}
const asConsole = (bearer: string, query: string) =>
  post(`http://localhost${CONSOLE_PATH}`, query, bearer);
const code = (answer: Answer) => answer.errors?.[0]?.extensions?.code;

let ownA = "";
let admA = "";
let vwA = "";
let nobody = "";
let ownB = "";
let tenantA = "";
let tenantB = "";
let slugA = "";
let uA1 = "";
let uA2 = "";
let uB1 = "";
const SLUG = { a: "usr-a", b: "usr-b" } as const;

const poolOf = async (slug: string) => {
  const resolved = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (resolved === null) throw new Error(`no tenant ${slug}`);
  const auth = await forTenant(resolved);
  if (auth === null) throw new Error(`no janus ${slug}`);
  return { resolved, auth };
};
const storeOf = async (slug: string) =>
  createMongoOAuth(oauthDb, {
    partition: (await poolOf(slug)).resolved.partition,
  });
const seedGrant = async (slug: string, userId: string, id: string) => {
  const store = await storeOf(slug);
  const now = new Date();
  await store.upsertGrant({
    id,
    userId,
    clientId: "some-app",
    resource: "https://api.example/",
    scopes: ["read"],
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  });
};
const grantsOf = (who: string, tenant: string, user: string) =>
  asConsole(
    who,
    `{ userGrants(tenantId: "${tenant}", userId: "${user}") { id clientId clientName resource scopes } }`,
  );
const sessionsOf = async (slug: string, userId: string) => {
  const { auth } = await poolOf(slug);
  const user = await auth.findUser(userId);
  if (user === null) throw new Error("no user");
  return auth.signInProven(user);
};

beforeAll(async () => {
  const clavix = await poolOf(PLATFORM_TENANT_SLUG);
  const operator = async (email: string) =>
    (await clavix.auth.create({ email, name: email })).id;
  [ownA, admA, vwA, nobody, ownB] = (await Promise.all(
    ["own-a", "adm-a", "vw-a", "nobody", "own-b"].map((n) =>
      operator(`${n}@usr.test`),
    ),
  )) as [string, string, string, string, string];
  tenantA = (await tenantsService.create({ slug: SLUG.a, name: "Alpha" })).id;
  tenantB = (await tenantsService.create({ slug: SLUG.b, name: "Beta" })).id;
  slugA = SLUG.a;
  await access.grantTenant(tenantA, ownA, "owner");
  await access.grantTenant(tenantA, admA, "admin");
  await access.grantTenant(tenantA, vwA, "viewer");
  await access.grantTenant(tenantB, ownB, "owner");
  const a = await poolOf(SLUG.a);
  const b = await poolOf(SLUG.b);
  uA1 = (await a.auth.create({ email: "one@end.test", name: "One" })).id;
  uA2 = (await a.auth.create({ email: "two@end.test" })).id;
  uB1 = (await b.auth.create({ email: "one@end.test", name: "B One" })).id;
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
  await oauthDb.collection("grants").deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

const MUTATIONS = (tenant: string, user: string) => [
  `inviteUser(tenantId: "${tenant}", email: "x@end.test") { id }`,
  `revokeInvitation(tenantId: "${tenant}", invitationId: "x")`,
  `disableUser(tenantId: "${tenant}", userId: "${user}") { id }`,
  `enableUser(tenantId: "${tenant}", userId: "${user}") { id }`,
  `deleteUser(tenantId: "${tenant}", userId: "${user}")`,
  `revokeUserSessions(tenantId: "${tenant}", userId: "${user}")`,
  `revokeGrant(tenantId: "${tenant}", userId: "${user}", grantId: "g")`,
];
const READS = (tenant: string, user: string) => [
  `users(tenantId: "${tenant}") { items { id } }`,
  `user(tenantId: "${tenant}", id: "${user}") { id }`,
  `userInvitations(tenantId: "${tenant}") { id }`,
  `userGrants(tenantId: "${tenant}", userId: "${user}") { id }`,
];

describe("permission per role", () => {
  test("every role of the tenant reads the users; nobody else does", async () => {
    for (const who of [ownA, admA, vwA]) {
      for (const read of READS(tenantA, uA1)) {
        expect((await asConsole(who, `{ ${read} }`)).errors).toBeUndefined();
      }
    }
    for (const read of READS(tenantA, uA1)) {
      expect(code(await asConsole(nobody, `{ ${read} }`))).toBe("FORBIDDEN");
    }
  });

  test("a viewer or a stranger changes nothing; an admin may", async () => {
    for (const who of [vwA, nobody]) {
      for (const mutation of MUTATIONS(tenantA, uA1)) {
        expect(code(await asConsole(who, `mutation { ${mutation} }`))).toBe(
          "FORBIDDEN",
        );
      }
    }
    const done = await asConsole(
      admA,
      `mutation { disableUser(tenantId: "${tenantA}", userId: "${uA2}") { active } enableUser(tenantId: "${tenantA}", userId: "${uA2}") { active } }`,
    );
    expect(done.data).toEqual({
      disableUser: { active: false },
      enableUser: { active: true },
    });
  });
});

describe("listing", () => {
  test("pages oldest first, finds by e-mail, refuses a bad cursor", async () => {
    const first = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", first: 1) { items { id email name emailVerified active } nextCursor } }`,
    );
    expect(first.data?.["users"].items).toHaveLength(1);
    expect(first.data?.["users"].items[0]).toMatchObject({
      id: uA1,
      email: "one@end.test",
      name: "One",
      active: true,
    });
    const cursor = first.data?.["users"].nextCursor as string;
    const second = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", first: 1, after: "${cursor}") { items { id } nextCursor } }`,
    );
    expect(second.data?.["users"].items[0].id).toBe(uA2);
    expect(second.data?.["users"].nextCursor).toBeNull();
    const byEmail = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", email: " TWO@end.test ") { items { id } } }`,
    );
    expect(byEmail.data?.["users"].items).toEqual([{ id: uA2 }]);
    const missing = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", email: "none@end.test") { items { id } } }`,
    );
    expect(missing.data?.["users"].items).toEqual([]);
    expect(
      code(
        await asConsole(
          ownA,
          `{ users(tenantId: "${tenantA}", after: "garbage") { items { id } } }`,
        ),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("tenant A / B isolation", () => {
  test("the owner of A reads and touches nothing of B", async () => {
    for (const read of READS(tenantB, uB1)) {
      expect(code(await asConsole(ownA, `{ ${read} }`))).toBe("FORBIDDEN");
    }
    for (const mutation of MUTATIONS(tenantB, uB1)) {
      expect(code(await asConsole(ownA, `mutation { ${mutation} }`))).toBe(
        "FORBIDDEN",
      );
    }
    expect(
      code(
        await asConsole(
          ownA,
          `{ users(tenantId: "${"0".repeat(24)}") { items { id } } }`,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  test("a user id of B, named under A, is unknown and stays untouched", async () => {
    await seedGrant(SLUG.b, uB1, "grant-b1");
    const session = await sessionsOf(SLUG.b, uB1);
    expect(session.status).toBe("signedIn");
    // Same address in both pools, but two users.
    expect(uA1).not.toBe(uB1);
    expect(
      (
        await asConsole(
          ownA,
          `{ user(tenantId: "${tenantA}", id: "${uB1}") { id } }`,
        )
      ).data,
    ).toEqual({ user: null });
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { disableUser(tenantId: "${tenantA}", userId: "${uB1}") { id } }`,
        ),
      ),
    ).toBe("NOT_FOUND");
    const attempts = await asConsole(
      ownA,
      `mutation { sessions: revokeUserSessions(tenantId: "${tenantA}", userId: "${uB1}") grant: revokeGrant(tenantId: "${tenantA}", userId: "${uB1}", grantId: "grant-b1") deleted: deleteUser(tenantId: "${tenantA}", userId: "${uB1}") }`,
    );
    expect(attempts.data).toEqual({ sessions: 0, grant: false, deleted: true });
    expect((await grantsOf(ownA, tenantA, uB1)).data?.["userGrants"]).toEqual(
      [],
    );
    const b = await poolOf(SLUG.b);
    expect((await b.auth.findUser(uB1))?.active).toBe(true);
    expect(
      (await (await storeOf(SLUG.b)).findGrant("grant-b1"))?.revokedAt,
    ).toBeNull();
    expect(
      (await grantsOf(ownB, tenantB, uB1)).data?.["userGrants"],
    ).toHaveLength(1);
    expect(
      await asConsole(
        ownB,
        `mutation { revokeUserSessions(tenantId: "${tenantB}", userId: "${uB1}") }`,
      ),
    ).toMatchObject({
      data: { revokeUserSessions: 1 },
    });
  });

  test("an invitation of A is neither listed nor revoked by B", async () => {
    const issued = await asConsole(
      ownA,
      `mutation { inviteUser(tenantId: "${tenantA}", email: "iso@end.test") { id } }`,
    );
    const id = issued.data?.["inviteUser"].id as string;
    await asConsole(
      ownB,
      `mutation { revokeInvitation(tenantId: "${tenantB}", invitationId: "${id}") }`,
    );
    expect(
      (
        await asConsole(
          ownB,
          `{ userInvitations(tenantId: "${tenantB}") { id } }`,
        )
      ).data,
    ).toEqual({ userInvitations: [] });
    const listed = await asConsole(
      ownA,
      `{ userInvitations(tenantId: "${tenantA}") { id email } }`,
    );
    expect(
      listed.data?.["userInvitations"].map((i: { id: string }) => i.id),
    ).toContain(id);
  });
});

describe("invitations", () => {
  const codeMailedTo = (email: string) => {
    const mail = memory.sent
      .filter((m) => JSON.stringify(m.to).includes(email))
      .at(-1);
    return /invitation\?code=([^"&\s)<]+)/.exec(
      `${mail?.text ?? ""} ${mail?.html ?? ""}`,
    )?.[1];
  };
  const hosted = `${issuerOf(SLUG.a, origin)}/graphql`;

  test("inviting mails a link; accepting makes the user in A's pool only; a repeat is refused", async () => {
    const email = "fresh@end.test";
    const issued = await asConsole(
      ownA,
      `mutation { inviteUser(tenantId: "${tenantA}", email: "${email}") { id email } }`,
    );
    expect(issued.errors).toBeUndefined();
    const secret = codeMailedTo(email);
    expect(secret).toBeDefined();
    const accepted = await post(
      hosted,
      `mutation { acceptInvitation(code: "${secret}") { signedIn user { email } } }`,
    );
    expect(accepted.errors).toBeUndefined();
    expect(accepted.data?.["acceptInvitation"]).toMatchObject({
      signedIn: true,
      user: { email },
    });
    expect(await (await poolOf(SLUG.a)).auth.findByEmail(email)).not.toBeNull();
    expect(await (await poolOf(SLUG.b)).auth.findByEmail(email)).toBeNull();
    // An address with an account is refused; the accepted invitation is no longer pending.
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { inviteUser(tenantId: "${tenantA}", email: "${email}") { id } }`,
        ),
      ),
    ).toBe("USER_EXISTS");
    const pending = await asConsole(
      ownA,
      `{ userInvitations(tenantId: "${tenantA}") { email } }`,
    );
    expect(JSON.stringify(pending.data)).not.toContain(email);
  });

  test("inviting again replaces the pending invitation; revoking is idempotent and kills the code", async () => {
    const email = "twice@end.test";
    const invite = () =>
      asConsole(
        ownA,
        `mutation { inviteUser(tenantId: "${tenantA}", email: "${email}") { id } }`,
      );
    const first = (await invite()).data?.["inviteUser"].id as string;
    const oldCode = codeMailedTo(email);
    const second = (await invite()).data?.["inviteUser"].id as string;
    expect(second).not.toBe(first);
    const newCode = codeMailedTo(email);
    expect(newCode).not.toBe(oldCode);
    const listed = await asConsole(
      ownA,
      `{ userInvitations(tenantId: "${tenantA}") { id email } }`,
    );
    expect(
      listed.data?.["userInvitations"].filter(
        (i: { email: string }) => i.email === email,
      ),
    ).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await asConsole(
            ownA,
            `mutation { revokeInvitation(tenantId: "${tenantA}", invitationId: "${second}") }`,
          )
        ).data,
      ).toEqual({ revokeInvitation: true });
    }
    const gone = await post(
      hosted,
      `mutation { acceptInvitation(code: "${newCode}") { signedIn } }`,
    );
    expect(code(gone)).toBe("INVITATION_INVALID");
  });
});

describe("disabling, sessions, grants and deletion", () => {
  test("disableUser / enableUser are idempotent, and disabling ends the sessions", async () => {
    await sessionsOf(slugA, uA1);
    await sessionsOf(slugA, uA1);
    const disable = `mutation { disableUser(tenantId: "${tenantA}", userId: "${uA1}") { active } }`;
    expect((await asConsole(ownA, disable)).data).toEqual({
      disableUser: { active: false },
    });
    expect((await asConsole(ownA, disable)).data).toEqual({
      disableUser: { active: false },
    });
    expect(
      (
        await asConsole(
          ownA,
          `mutation { revokeUserSessions(tenantId: "${tenantA}", userId: "${uA1}") }`,
        )
      ).data,
    ).toEqual({ revokeUserSessions: 0 });
    const enable = `mutation { enableUser(tenantId: "${tenantA}", userId: "${uA1}") { active } }`;
    for (let i = 0; i < 2; i++) {
      expect((await asConsole(ownA, enable)).data).toEqual({
        enableUser: { active: true },
      });
    }
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { disableUser(tenantId: "${tenantA}", userId: "nobody") { id } }`,
        ),
      ),
    ).toBe("NOT_FOUND");
  });

  test("revokeUserSessions counts the sessions it ended, then 0", async () => {
    await sessionsOf(slugA, uA2);
    await sessionsOf(slugA, uA2);
    const run = () =>
      asConsole(
        ownA,
        `mutation { revokeUserSessions(tenantId: "${tenantA}", userId: "${uA2}") }`,
      );
    expect((await run()).data).toEqual({ revokeUserSessions: 2 });
    expect((await run()).data).toEqual({ revokeUserSessions: 0 });
  });

  test("userGrants lists the standing grants; revokeGrant takes one back, twice alike", async () => {
    await seedGrant(slugA, uA2, "grant-a2");
    const listed = await grantsOf(ownA, tenantA, uA2);
    expect(listed.data?.["userGrants"]).toEqual([
      {
        id: "grant-a2",
        clientId: "some-app",
        clientName: null,
        resource: "https://api.example/",
        scopes: ["read"],
      },
    ]);
    const revoke = (grant: string, user = uA2) =>
      asConsole(
        ownA,
        `mutation { revokeGrant(tenantId: "${tenantA}", userId: "${user}", grantId: "${grant}") }`,
      );
    expect((await revoke("grant-a2", uA1)).data).toEqual({
      revokeGrant: false,
    });
    expect((await revoke("grant-a2")).data).toEqual({ revokeGrant: true });
    expect((await revoke("grant-a2")).data).toEqual({ revokeGrant: true });
    expect((await revoke("nope")).data).toEqual({ revokeGrant: false });
    expect((await grantsOf(ownA, tenantA, uA2)).data?.["userGrants"]).toEqual(
      [],
    );
  });

  test("deleteUser removes the user, their sessions and grants; a repeat is true", async () => {
    const a = await poolOf(slugA);
    const gone = (await a.auth.create({ email: "gone@end.test" })).id;
    await seedGrant(slugA, gone, "grant-gone");
    await sessionsOf(slugA, gone);
    const del = () =>
      asConsole(
        ownA,
        `mutation { deleteUser(tenantId: "${tenantA}", userId: "${gone}") }`,
      );
    expect((await del()).data).toEqual({ deleteUser: true });
    expect((await del()).data).toEqual({ deleteUser: true });
    expect(await a.auth.findUser(gone)).toBeNull();
    expect(
      (await (await storeOf(slugA)).findGrant("grant-gone"))?.revokedAt,
    ).not.toBeNull();
    expect(
      (
        await asConsole(
          ownA,
          `{ user(tenantId: "${tenantA}", id: "${gone}") { id } }`,
        )
      ).data,
    ).toEqual({ user: null });
  });
});

describe("admin events", () => {
  test("each mutation stores its event by id, repeats included", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const t = tenantA;
    await asConsole(
      ownA,
      `mutation {
        a: disableUser(tenantId: "${t}", userId: "${uA2}") { id }
        b: enableUser(tenantId: "${t}", userId: "${uA2}") { id }
        c: revokeUserSessions(tenantId: "${t}", userId: "${uA2}")
        d: revokeGrant(tenantId: "${t}", userId: "${uA2}", grantId: "g1")
        e: deleteUser(tenantId: "${t}", userId: "ghost")
        f: revokeInvitation(tenantId: "${t}", invitationId: "inv1")
      }`,
    );
    const events = await mongo.db.adminEvents.raw
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(
      events.map((e) => [e.action, e.target.type, e.target.id, e.actor]),
    ).toEqual([
      ["user.disable", "user", uA2, ownA],
      ["user.enable", "user", uA2, ownA],
      ["user.revokeSessions", "user", uA2, ownA],
      ["user.revokeGrant", "grant", "g1", ownA],
      ["user.delete", "user", "ghost", ownA],
      ["user.revokeInvitation", "invitation", "inv1", ownA],
    ]);
  });
});
