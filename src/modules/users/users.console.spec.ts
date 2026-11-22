import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { totpCode } from "@softistx/janus/testing";
import {
  createMemorySigningKeys,
  type SigningKeyStore,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { access } from "@/config/access";
import { attributesService, attributeValuesService } from "@/config/attributes";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { rolesService } from "@/config/roles";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { authFor, claimsFor, forTenant } from "@/config/users";
import { CONSOLE_PATH } from "@/console/identity";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTestApp } from "~/app";
import { at } from "~/body";
import { clientHeaders } from "~/client-header";
import { verifiedCallers } from "~/console";
import { type Answer, answerOf } from "~/gql-answer";
import { memoryMailerOf } from "~/memory-mailer-of";
import { defined } from "~/narrow";
import { quietOAuth } from "~/ports";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  ...quietOAuth,
  clock: { now: () => new Date() },
  dpopNonceSecret: "spec-dpop-nonce-secret",
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
const app = createTestApp({
  oauth: issuers,
  console: {
    ...verifiedCallers(deps),
    authenticate: async (request) => {
      const userId = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      return userId === undefined
        ? null
        : {
            userId,
            clientId: "spec",
            grantId: "spec",
            scopes: ["console"],
            clientName: null,
            bound: null,
            jkt: null,
            authorizationDetails: [],
          };
    },
  },
});
const memory = memoryMailerOf(mailer);

async function post(url: string, query: string, bearer?: string) {
  const response = await app.request(url, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ query }),
  });
  return answerOf(response);
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
const sessionsOf = async (
  slug: string,
  userId: string,
  deviceLabel?: string,
) => {
  const { auth } = await poolOf(slug);
  const user = await auth.findUser(userId);
  if (user === null) throw new Error("no user");
  return auth.signInProven(
    user,
    deviceLabel === undefined ? undefined : { deviceLabel },
  );
};

beforeAll(async () => {
  const clavix = await poolOf(PLATFORM_TENANT_SLUG);
  const operator = async (email: string) =>
    (await clavix.auth.create({ email, name: email })).id;
  [ownA, admA, vwA, nobody, ownB] = await Promise.all([
    operator("own-a@usr.test"),
    operator("adm-a@usr.test"),
    operator("vw-a@usr.test"),
    operator("nobody@usr.test"),
    operator("own-b@usr.test"),
  ]);
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
  await mongo.db.roles.raw.deleteMany({});
  await mongo.db.roleAssignments.raw.deleteMany({});
  await mongo.db.userAttributes.raw.deleteMany({});
  await mongo.db.attributeValues.raw.deleteMany({});
});

const MUTATIONS = (tenant: string, user: string) => [
  `inviteUser(tenantId: "${tenant}", email: "x@end.test") { id }`,
  `revokeInvitation(tenantId: "${tenant}", invitationId: "x")`,
  `disableUser(tenantId: "${tenant}", userId: "${user}") { id }`,
  `enableUser(tenantId: "${tenant}", userId: "${user}") { id }`,
  `deleteUser(tenantId: "${tenant}", userId: "${user}")`,
  `updateUser(tenantId: "${tenant}", userId: "${user}", input: { name: "Zed" }) { id }`,
  `revokeUserSessions(tenantId: "${tenant}", userId: "${user}")`,
  `revokeUserSession(tenantId: "${tenant}", userId: "${user}", sessionId: "s")`,
  `setUserEmailVerified(tenantId: "${tenant}", userId: "${user}", verified: true) { id }`,
  `setUserPhoneVerified(tenantId: "${tenant}", userId: "${user}", verified: true) { id }`,
  `revokeGrant(tenantId: "${tenant}", userId: "${user}", grantId: "g")`,
  `resetUserSecondFactor(tenantId: "${tenant}", userId: "${user}") { id }`,
];
const READS = (tenant: string, user: string) => [
  `users(tenantId: "${tenant}") { items { id } }`,
  `user(tenantId: "${tenant}", id: "${user}") { id }`,
  `userInvitations(tenantId: "${tenant}") { id }`,
  `userGrants(tenantId: "${tenant}", userId: "${user}") { id }`,
  `userSessions(tenantId: "${tenant}", userId: "${user}") { id }`,
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
    expect(at(first.data, "users.items")).toHaveLength(1);
    expect(
      at(first.data, "users.items", z.array(z.unknown()))[0],
    ).toMatchObject({
      id: uA1,
      email: "one@end.test",
      name: "One",
      active: true,
    });
    const cursor = at(first.data, "users.nextCursor", z.string());
    const second = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", first: 1, after: "${cursor}") { items { id } nextCursor } }`,
    );
    expect(
      at(
        second.data,
        "users.items",
        z.array(z.looseObject({ id: z.string() })),
      )[0]?.id,
    ).toBe(uA2);
    expect(at(second.data, "users.nextCursor")).toBeNull();
    const byEmail = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", email: " TWO@end.test ") { items { id } } }`,
    );
    expect(at(byEmail.data, "users.items")).toEqual([{ id: uA2 }]);
    const missing = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", email: "none@end.test") { items { id } } }`,
    );
    expect(at(missing.data, "users.items")).toEqual([]);
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

const expectPrefixScope = async () => {
  // The other tenant's pool is not searched.
  expect(
    at(
      (
        await asConsole(
          ownB,
          `{ users(tenantId: "${tenantB}", emailPrefix: "prefix.") { totalCount } }`,
        )
      ).data,
      "users.totalCount",
    ),
  ).toBe(0);
  expect(
    code(
      await asConsole(
        ownA,
        `{ users(tenantId: "${tenantA}", emailPrefix: "${"a".repeat(255)}") { totalCount } }`,
      ),
    ),
  ).toBe("BAD_USER_INPUT");
  // Both filters at once is ambiguous.
  expect(
    code(
      await asConsole(
        ownA,
        `{ users(tenantId: "${tenantA}", email: "a@b.test", emailPrefix: "a") { totalCount } }`,
      ),
    ),
  ).toBe("BAD_USER_INPUT");
};

describe("search by e-mail prefix", () => {
  test("matches any case, counts, pages, and keeps the exact e-mail working", async () => {
    const a = await poolOf(SLUG.a);
    const pre = (await a.auth.create({ email: "Prefix.One@find.test" })).id;
    await a.auth.create({ email: "prefix.two@find.test" });
    await a.auth.create({ email: "other@find.test" });
    const all = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", emailPrefix: "PREFIX.") { items { id email } nextCursor totalCount } }`,
    );
    expect(all.errors).toBeUndefined();
    expect(at(all.data, "users.totalCount")).toBe(2);
    expect(at(all.data, "users.items")).toHaveLength(2);
    expect(
      at(all.data, "users.items", z.array(z.looseObject({ id: z.string() })))[0]
        ?.id,
    ).toBe(pre);
    const paged = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", emailPrefix: "prefix.", first: 1) { items { id } nextCursor totalCount } }`,
    );
    expect(at(paged.data, "users.items")).toHaveLength(1);
    expect(at(paged.data, "users.totalCount")).toBe(2);
    expect(at(paged.data, "users.nextCursor")).not.toBeNull();
    // No prefix: every user of the tenant, and the total says so.
    const whole = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}") { items { id } totalCount } }`,
    );
    expect(at(whole.data, "users.totalCount")).toBeGreaterThanOrEqual(5);
    // A blank prefix is no filter; none found is an empty page.
    expect(
      at(
        (
          await asConsole(
            ownA,
            `{ users(tenantId: "${tenantA}", emailPrefix: "  ") { totalCount } }`,
          )
        ).data,
        "users.totalCount",
      ),
    ).toBe(at(whole.data, "users.totalCount"));
    expect(
      at(
        (
          await asConsole(
            ownA,
            `{ users(tenantId: "${tenantA}", emailPrefix: "zzz") { items { id } totalCount } }`,
          )
        ).data,
        "users",
      ),
    ).toEqual({ items: [], totalCount: 0 });
    // The exact match still answers, with its total.
    const exact = await asConsole(
      ownA,
      `{ users(tenantId: "${tenantA}", email: "prefix.two@find.test") { items { email } totalCount } }`,
    );
    expect(at(exact.data, "users")).toEqual({
      items: [{ email: "prefix.two@find.test" }],
      totalCount: 1,
    });
    await expectPrefixScope();
  });
});

describe("user lookup for the role member picker", () => {
  const lookupOf = (who: string, tenant: string, query: string, first = "") =>
    asConsole(
      who,
      `{ userLookup(tenantId: "${tenant}", query: "${query}"${first}) { id email name } }`,
    );

  test("a role writer may call it; a viewer and a stranger are refused", async () => {
    for (const who of [ownA, admA]) {
      expect((await lookupOf(who, tenantA, "one")).errors).toBeUndefined();
    }
    for (const who of [vwA, nobody]) {
      expect(code(await lookupOf(who, tenantA, "one"))).toBe("FORBIDDEN");
    }
  });

  test("returns id, e-mail and name only", async () => {
    const wide = await asConsole(
      admA,
      `{ userLookup(tenantId: "${tenantA}", query: "one@") { emailVerified } }`,
    );
    expect(code(wide)).toBe("GRAPHQL_VALIDATION_FAILED");
    const ok = await lookupOf(admA, tenantA, "one@");
    expect(at(ok.data, "userLookup")).toEqual([
      { id: uA1, email: "one@end.test", name: "One" },
    ]);
  });

  test("finds by e-mail prefix and by name prefix, any case, e-mail matches first, each user once", async () => {
    const a = await poolOf(SLUG.a);
    const byName = (
      await a.auth.create({ email: "zz1@look.test", name: "Marta Lookup" })
    ).id;
    const byMail = (
      await a.auth.create({ email: "marta.mail@look.test", name: "Other" })
    ).id;
    const both = (
      await a.auth.create({ email: "marta.both@look.test", name: "Marta Both" })
    ).id;
    const found = await lookupOf(admA, tenantA, "MARTA");
    expect(found.errors).toBeUndefined();
    const rows = at(
      found.data,
      "userLookup",
      z.array(z.looseObject({ id: z.string() })),
    );
    const ids = rows.map((u) => u.id);
    expect(ids).toEqual([byMail, both, byName]);
    expect(
      at((await lookupOf(admA, tenantA, "zzz-none")).data, "userLookup"),
    ).toEqual([]);
    // A blank query is an empty list, not the whole pool.
    expect(
      at((await lookupOf(admA, tenantA, "  ")).data, "userLookup"),
    ).toEqual([]);
    // Plain text, never a pattern.
    expect(
      at((await lookupOf(admA, tenantA, ".*")).data, "userLookup"),
    ).toEqual([]);
  });

  test("caps the answer: first defaults to 10, at most 20", async () => {
    const a = await poolOf(SLUG.a);
    for (let n = 0; n < 25; n++) {
      await a.auth.create({
        email: `cap${String(n).padStart(2, "0")}@cap.test`,
      });
    }
    const count = async (first: string) => {
      const answer = await lookupOf(admA, tenantA, "cap", first);
      return at(answer.data, "userLookup", z.array(z.unknown())).length;
    };
    expect(await count("")).toBe(10);
    expect(await count(", first: 3")).toBe(3);
    expect(await count(", first: 500")).toBe(20);
    expect(await count(", first: 0")).toBe(1);
  });

  test("is scoped to the tenant: B's users are not found under A and A's not under B", async () => {
    const b = await poolOf(SLUG.b);
    await b.auth.create({ email: "only-b@look.test", name: "Bertha Only" });
    expect(
      at((await lookupOf(admA, tenantA, "only-b")).data, "userLookup"),
    ).toEqual([]);
    expect(
      at((await lookupOf(admA, tenantA, "Bertha")).data, "userLookup"),
    ).toEqual([]);
    expect(
      at((await lookupOf(ownB, tenantB, "Bertha")).data, "userLookup"),
    ).toHaveLength(1);
    // The owner of B has no say on A.
    expect(code(await lookupOf(ownB, tenantA, "one"))).toBe("FORBIDDEN");
    expect(
      at((await lookupOf(ownB, tenantB, "marta")).data, "userLookup"),
    ).toEqual([]);
  });

  test("refuses a query over 254 characters", async () => {
    expect(code(await lookupOf(admA, tenantA, "a".repeat(255)))).toBe(
      "BAD_USER_INPUT",
    );
  });
});

const revokeSession = (userId: string, sessionId: string) =>
  asConsole(
    admA,
    `mutation { revokeUserSession(tenantId: "${tenantA}", userId: "${userId}", sessionId: "${sessionId}") }`,
  );

const expectSessionsLeft = async (id: string, other: string) => {
  const after = await asConsole(
    ownA,
    `{ userSessions(tenantId: "${tenantA}", userId: "${id}") { device } }`,
  );
  expect(at(after.data, "userSessions")).toHaveLength(2);
  expect(
    at(
      (
        await asConsole(
          ownA,
          `{ userSessions(tenantId: "${tenantA}", userId: "${other}") { device } }`,
        )
      ).data,
      "userSessions",
    ),
  ).toEqual([{ device: "Not yours" }]);
  // An unknown user has none.
  expect(
    (
      await asConsole(
        ownA,
        `{ userSessions(tenantId: "${tenantA}", userId: "ghost") { id } }`,
      )
    ).data,
  ).toEqual({ userSessions: [] });
};

describe("user sessions", () => {
  test("lists a user's sessions with their device, newest first; revokes one", async () => {
    const a = await poolOf(SLUG.a);
    const id = (await a.auth.create({ email: "devices@end.test" })).id;
    const other = (await a.auth.create({ email: "devices2@end.test" })).id;
    await sessionsOf(SLUG.a, id, "Firefox on Linux");
    await sessionsOf(SLUG.a, id, "Safari on iPhone");
    await sessionsOf(SLUG.a, id);
    await sessionsOf(SLUG.a, other, "Not yours");
    const listed = await asConsole(
      vwA,
      `{ userSessions(tenantId: "${tenantA}", userId: "${id}") { id device createdAt lastUsedAt expiresAt authenticatedAt } }`,
    );
    expect(listed.errors).toBeUndefined();
    const rows = at(
      listed.data,
      "userSessions",
      z.array(
        z.looseObject({
          id: z.string(),
          device: z.string().or(z.null()),
          createdAt: z.string(),
          expiresAt: z.string(),
        }),
      ),
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.device)).toEqual([
      null,
      "Safari on iPhone",
      "Firefox on Linux",
    ]);
    for (const row of rows) {
      expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
    const target = defined(rows[1], "the second session").id;
    // Another user's session id, named under this user, revokes nothing.
    const foreignRows = at(
      (
        await asConsole(
          ownA,
          `{ userSessions(tenantId: "${tenantA}", userId: "${other}") { id } }`,
        )
      ).data,
      "userSessions",
      z.array(z.looseObject({ id: z.string() })),
    );
    const foreign = defined(foreignRows[0], "a foreign session").id;
    expect((await revokeSession(id, foreign)).data).toEqual({
      revokeUserSession: false,
    });
    expect((await revokeSession(id, target)).data).toEqual({
      revokeUserSession: true,
    });
    // Revoked once: a repeat is false.
    expect((await revokeSession(id, target)).data).toEqual({
      revokeUserSession: false,
    });
    await expectSessionsLeft(id, other);
  });

  test("a user of B has no sessions listed or revoked under A", async () => {
    const uB2 = (
      await (await poolOf(SLUG.b)).auth.create({ email: "devs@end.test" })
    ).id;
    const session = await sessionsOf(SLUG.b, uB2, "B device");
    expect(session.status).toBe("signedIn");
    expect(
      (
        await asConsole(
          ownA,
          `{ userSessions(tenantId: "${tenantA}", userId: "${uB2}") { id } }`,
        )
      ).data,
    ).toEqual({ userSessions: [] });
    const ownRows = at(
      (
        await asConsole(
          ownB,
          `{ userSessions(tenantId: "${tenantB}", userId: "${uB2}") { id device } }`,
        )
      ).data,
      "userSessions",
      z.array(z.looseObject({ id: z.string(), device: z.string() })),
    );
    const own = ownRows.find((s) => s.device === "B device");
    expect(own).toBeDefined();
    expect(
      (
        await asConsole(
          ownA,
          `mutation { revokeUserSession(tenantId: "${tenantA}", userId: "${uB2}", sessionId: "${own?.id}") }`,
        )
      ).data,
    ).toEqual({ revokeUserSession: false });
    expect(
      at(
        (
          await asConsole(
            ownB,
            `{ userSessions(tenantId: "${tenantB}", userId: "${uB2}") { id } }`,
          )
        ).data,
        "userSessions.length",
      ),
    ).toBeGreaterThan(0);
  });
});

describe("e-mail verified flag", () => {
  test("sets and clears it without touching anything else; an unknown user is NOT_FOUND", async () => {
    const a = await poolOf(SLUG.a);
    const id = (await a.auth.create({ email: "verify@end.test", name: "V" }))
      .id;
    await sessionsOf(SLUG.a, id, "kept");
    const set = (verified: boolean, user = id) =>
      asConsole(
        ownA,
        `mutation { setUserEmailVerified(tenantId: "${tenantA}", userId: "${user}", verified: ${verified}) { id emailVerified name active } }`,
      );
    expect(at((await set(true)).data, "setUserEmailVerified")).toEqual({
      id,
      emailVerified: true,
      name: "V",
      active: true,
    });
    expect(
      at((await set(true)).data, "setUserEmailVerified.emailVerified"),
    ).toBe(true);
    expect(at((await set(false)).data, "setUserEmailVerified")).toMatchObject({
      emailVerified: false,
      name: "V",
    });
    expect(code(await set(true, "ghost"))).toBe("NOT_FOUND");
    expect(code(await set(true, uB1))).toBe("NOT_FOUND");
    // No session was revoked by it.
    expect(
      at(
        (
          await asConsole(
            ownA,
            `{ userSessions(tenantId: "${tenantA}", userId: "${id}") { device } }`,
          )
        ).data,
        "userSessions",
      ),
    ).toEqual([{ device: "kept" }]);
  });
});

describe("second factor", () => {
  const read = (user: string) =>
    asConsole(
      ownA,
      `{ user(tenantId: "${tenantA}", id: "${user}") { secondFactor { enabled recoveryCodesLeft } } }`,
    );
  const reset = (who: string, tenant: string, user: string) =>
    asConsole(
      who,
      `mutation { resetUserSecondFactor(tenantId: "${tenant}", userId: "${user}") { id secondFactor { enabled } } }`,
    );

  test("a user with no factor reads disabled; reset is idempotent; an unknown user is NOT_FOUND", async () => {
    expect(at((await read(uA1)).data, "user")).toEqual({
      secondFactor: { enabled: false, recoveryCodesLeft: null },
    });
    expect(
      at((await reset(admA, tenantA, uA1)).data, "resetUserSecondFactor"),
    ).toEqual({
      id: uA1,
      secondFactor: { enabled: false },
    });
    expect(code(await reset(ownA, tenantA, "ghost"))).toBe("NOT_FOUND");
  });

  test("a viewer is refused, and B's user is unknown under A", async () => {
    expect(code(await reset(vwA, tenantA, uA1))).toBe("FORBIDDEN");
    expect(code(await reset(ownA, tenantA, uB1))).toBe("NOT_FOUND");
  });
});

describe("second factor of a page of users", () => {
  test("reads every row in one batch, the codes of the holders only", async () => {
    const tenant = (
      await tenantsService.create({ slug: "usr-mfa", name: "Mfa" })
    ).id;
    await access.grantTenant(tenant, ownA, "owner");
    const { auth } = await poolOf("usr-mfa");
    const holder = async (email: string) => {
      const user = await auth.setEmailVerified(
        await auth.create({ email }),
        true,
      );
      const { secret } = await auth.secondFactor.enroll(user);
      await auth.secondFactor.activate(user, totpCode(secret));
      return user.id;
    };
    const on = await holder("on@mfa.test");
    const off = (await auth.create({ email: "off@mfa.test" })).id;
    const also = await holder("also@mfa.test");
    const batched = spyOn(deps.users, "secondFactors");
    const single = spyOn(deps.users, "secondFactor");
    const counted = spyOn(auth.secondFactor, "recoveryCodesLeft");
    try {
      const page = await asConsole(
        ownA,
        `{ users(tenantId: "${tenant}") { items { id secondFactor { enabled recoveryCodesLeft } } } }`,
      );
      expect(page.errors).toBeUndefined();
      const factor = (id: string) =>
        at(
          page.data,
          "users.items",
          z.array(z.looseObject({ id: z.string(), secondFactor: z.unknown() })),
        ).find((row) => row.id === id)?.secondFactor;
      expect(factor(on)).toEqual({ enabled: true, recoveryCodesLeft: 10 });
      expect(factor(off)).toEqual({ enabled: false, recoveryCodesLeft: null });
      expect(factor(also)).toEqual({ enabled: true, recoveryCodesLeft: 10 });
      expect(batched).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
      expect(counted).toHaveBeenCalledTimes(2);
      // A reset in the same request reads the factor after its write.
      const reset = await asConsole(
        ownA,
        `mutation { resetUserSecondFactor(tenantId: "${tenant}", userId: "${on}") { secondFactor { enabled recoveryCodesLeft } } }`,
      );
      expect(at(reset.data, "resetUserSecondFactor.secondFactor")).toEqual({
        enabled: false,
        recoveryCodesLeft: null,
      });
    } finally {
      batched.mockRestore();
      single.mockRestore();
      counted.mockRestore();
    }
  });
});

describe("resetting an operator's second factor (clavix-api#290)", () => {
  test("a platform admin may not reset a tenant owner's factor; a platform owner may", async () => {
    const clavix = await poolOf(PLATFORM_TENANT_SLUG);
    const platformAdmin = (
      await clavix.auth.create({ email: "plat-adm@usr.test" })
    ).id;
    const platformOwner = (
      await clavix.auth.create({ email: "plat-own@usr.test" })
    ).id;
    await access.grantPlatform(platformAdmin, "admin");
    await access.grantPlatform(platformOwner, "owner");
    const platform = clavix.resolved.tenantId;
    const reset = (who: string, target: string) =>
      asConsole(
        who,
        `mutation { resetUserSecondFactor(tenantId: "${platform}", userId: "${target}") { id } }`,
      );
    // ownA owns tenant A: only a platform owner may touch their factor.
    expect(code(await reset(platformAdmin, ownA))).toBe("FORBIDDEN");
    expect(code(await reset(platformAdmin, platformOwner))).toBe("FORBIDDEN");
    expect(
      at((await reset(platformOwner, ownA)).data, "resetUserSecondFactor"),
    ).toEqual({ id: ownA });
    // An operator with no role and no tenant stays an admin's to reset.
    expect(
      at((await reset(platformAdmin, nobody)).data, "resetUserSecondFactor"),
    ).toEqual({ id: nobody });
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
    expect(at((await grantsOf(ownA, tenantA, uB1)).data, "userGrants")).toEqual(
      [],
    );
    const b = await poolOf(SLUG.b);
    expect((await b.auth.findUser(uB1))?.active).toBe(true);
    expect(
      (await (await storeOf(SLUG.b)).findGrant("grant-b1"))?.revokedAt,
    ).toBeNull();
    expect(
      at((await grantsOf(ownB, tenantB, uB1)).data, "userGrants"),
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
    const id = at(issued.data, "inviteUser.id", z.string());
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
      at(
        listed.data,
        "userInvitations",
        z.array(z.looseObject({ id: z.string() })),
      ).map((i) => i.id),
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

  test("accepting records the new user as active, once", async () => {
    const email = "active@end.test";
    await asConsole(
      ownA,
      `mutation { inviteUser(tenantId: "${tenantA}", email: "${email}") { id } }`,
    );
    const secret = codeMailedTo(email);
    const spy = spyOn(usageService, "recordActive");
    try {
      const accepted = await post(
        hosted,
        `mutation { acceptInvitation(code: "${secret}") { signedIn user { id } } }`,
      );
      expect(accepted.errors).toBeUndefined();
      const id = at(accepted.data, "acceptInvitation.user.id", z.string());
      expect(spy.mock.calls).toEqual([[tenantA, id]]);
    } finally {
      spy.mockRestore();
    }
  });

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
    expect(at(accepted.data, "acceptInvitation")).toMatchObject({
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
    const first = at((await invite()).data, "inviteUser.id", z.string());
    const oldCode = codeMailedTo(email);
    // Inside the cooldown a second invite is refused and mails nothing.
    const early = await invite();
    expect(early.errors?.[0]?.extensions?.["code"]).toBe("INVITE_TOO_SOON");
    expect(codeMailedTo(email)).toBe(oldCode);
    await oauthDb
      .collection("partitionedInvitations")
      .updateMany(
        { email },
        { $set: { updatedAt: new Date(Date.now() - 120_000) } },
      );
    const second = at((await invite()).data, "inviteUser.id", z.string());
    expect(second).not.toBe(first);
    const newCode = codeMailedTo(email);
    expect(newCode).not.toBe(oldCode);
    const listed = await asConsole(
      ownA,
      `{ userInvitations(tenantId: "${tenantA}") { id email } }`,
    );
    expect(
      at(
        listed.data,
        "userInvitations",
        z.array(z.looseObject({ email: z.string() })),
      ).filter((i) => i.email === email),
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

  test("updateUser renames the user and keeps the address and the flag", async () => {
    const a = await poolOf(slugA);
    const before = await a.auth.findUser(uA2);
    const done = await asConsole(
      admA,
      `mutation { updateUser(tenantId: "${tenantA}", userId: "${uA2}", input: { name: "  Renamed  " }) { id name email emailVerified active } }`,
    );
    expect(done.errors).toBeUndefined();
    expect(at(done.data, "updateUser")).toEqual({
      id: uA2,
      name: "Renamed",
      email: before?.email,
      emailVerified: before?.emailVerified,
      active: true,
    });
    expect((await a.auth.findUser(uA2))?.name).toBe("Renamed");
    const renamed = await a.auth.findUser(uA2);
    if (renamed !== null) await a.auth.update(renamed, { name: "Two" });
  });

  test("updateUser refuses an empty or too long name, and an unknown user", async () => {
    for (const name of ['"   "', `"${"x".repeat(201)}"`]) {
      expect(
        code(
          await asConsole(
            ownA,
            `mutation { updateUser(tenantId: "${tenantA}", userId: "${uA1}", input: { name: ${name} }) { id } }`,
          ),
        ),
      ).toBe("BAD_USER_INPUT");
    }
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { updateUser(tenantId: "${tenantA}", userId: "ghost", input: { name: "G" }) { id } }`,
        ),
      ),
    ).toBe("NOT_FOUND");
  });

  test("updateUser cannot reach a user of another tenant", async () => {
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { updateUser(tenantId: "${tenantA}", userId: "${uB1}", input: { name: "Hacked" }) { id } }`,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect((await (await poolOf(SLUG.b)).auth.findUser(uB1))?.name).not.toBe(
      "Hacked",
    );
    expect(
      code(
        await asConsole(
          ownB,
          `mutation { updateUser(tenantId: "${tenantA}", userId: "${uA1}", input: { name: "Hacked" }) { id } }`,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  test("userGrants lists the standing grants; revokeGrant takes one back, twice alike", async () => {
    await seedGrant(slugA, uA2, "grant-a2");
    const listed = await grantsOf(ownA, tenantA, uA2);
    expect(at(listed.data, "userGrants")).toEqual([
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
    expect(at((await grantsOf(ownA, tenantA, uA2)).data, "userGrants")).toEqual(
      [],
    );
  });

  test("assignRole racing deleteUser leaves no assignment of the deleted user", async () => {
    const a = await poolOf(slugA);
    const tenant = new ObjectId(tenantA);
    const role = await rolesService.create(tenant, { name: "racing" });
    for (let i = 0; i < 5; i++) {
      const user = (await a.auth.create({ email: `race${i}@end.test` })).id;
      await Promise.all([
        asConsole(
          ownA,
          `mutation { assignRole(tenantId: "${tenantA}", roleId: "${role._id.toHexString()}", userId: "${user}") }`,
        ),
        asConsole(
          ownA,
          `mutation { deleteUser(tenantId: "${tenantA}", userId: "${user}") }`,
        ),
      ]);
      expect(await rolesService.rolesOfUser(tenant, user)).toEqual([]);
      expect(await rolesService.memberCount(tenant, role)).toBe(0);
    }
  });

  test("deleteUser removes the user's role assignments too, on a repeat as well", async () => {
    const a = await poolOf(slugA);
    const holder = (await a.auth.create({ email: "holder@end.test" })).id;
    const tenant = new ObjectId(tenantA);
    const role = await rolesService.create(tenant, { name: "held" });
    await rolesService.assign(tenant, role._id.toHexString(), holder);
    const del = () =>
      asConsole(
        ownA,
        `mutation { deleteUser(tenantId: "${tenantA}", userId: "${holder}") }`,
      );
    expect((await del()).data).toEqual({ deleteUser: true });
    expect(await rolesService.rolesOfUser(tenant, holder)).toEqual([]);
    expect(await rolesService.memberCount(tenant, role)).toBe(0);
    // An assignment that outlived a failed first run is removed by the retry.
    await rolesService.assign(tenant, role._id.toHexString(), holder);
    expect((await del()).data).toEqual({ deleteUser: true });
    expect(await rolesService.rolesOfUser(tenant, holder)).toEqual([]);
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
        u: updateUser(tenantId: "${t}", userId: "${uA2}", input: { name: "Two" }) { id }
        d: revokeGrant(tenantId: "${t}", userId: "${uA2}", grantId: "g1")
        e: deleteUser(tenantId: "${t}", userId: "ghost")
        f: revokeInvitation(tenantId: "${t}", invitationId: "inv1")
        g: revokeUserSession(tenantId: "${t}", userId: "${uA2}", sessionId: "s1")
        h: setUserEmailVerified(tenantId: "${t}", userId: "${uA2}", verified: true) { id }
        i: resetUserSecondFactor(tenantId: "${t}", userId: "${uA2}") { id }
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
      ["user.update", "user", uA2, ownA],
      ["user.revokeGrant", "grant", "g1", ownA],
      ["user.delete", "user", "ghost", ownA],
      ["user.revokeInvitation", "invitation", "inv1", ownA],
      ["user.revokeSession", "session", "s1", ownA],
      ["user.setEmailVerified", "user", uA2, ownA],
      ["user.resetSecondFactor", "user", uA2, ownA],
    ]);
  });
});

describe("a user's attribute values: export and erase", () => {
  const tenant = () => new ObjectId(tenantA);
  const giveValue = async (userId: string, key: string, text: string) => {
    const attribute = await attributesService.create(tenant(), {
      key,
      family: "USER",
      type: "STRING",
      label: [{ locale: "en", text: key }],
    });
    await attributeValuesService.save(
      tenant(),
      userId,
      [{ attributeId: attribute._id.toHexString(), value: { text } }],
      { kind: "admin", id: ownA },
      false,
    );
    return attribute;
  };

  test("userDataExport gathers the profile, values (an archived one flagged hidden), roles, grants and sessions, and is recorded", async () => {
    const a = await poolOf(slugA);
    const subject = (await a.auth.create({ email: "export@end.test" })).id;
    const live = await giveValue(subject, "exp_live", "kept");
    const old = await giveValue(subject, "exp_old", "archived-secret");
    await attributesService.archive(tenant(), old._id.toHexString());
    const role = await rolesService.create(tenant(), { name: "exp-role" });
    await rolesService.assign(tenant(), role._id.toHexString(), subject);
    await seedGrant(slugA, subject, "grant-export");
    await sessionsOf(slugA, subject);
    await asConsole(
      ownA,
      `mutation { updateUser(tenantId: "${tenantA}", userId: "${subject}", input: { givenName: "Exported", phone: "+14165550123" }) { id } }`,
    );
    await mongo.db.adminEvents.raw.deleteMany({});
    const answer = await asConsole(
      ownA,
      `{ userDataExport(tenantId: "${tenantA}", userId: "${subject}") { profile { id email profile { givenName phone { number verified } } } attributes { key hidden text } roles { role } grants { id } sessions { id } } }`,
    );
    expect(answer.errors).toBeUndefined();
    expect(answer.data).toMatchObject({
      userDataExport: {
        profile: {
          id: subject,
          email: "export@end.test",
          profile: {
            givenName: "Exported",
            phone: { number: "+14165550123", verified: false },
          },
        },
        attributes: [
          { key: "exp_live", hidden: false, text: "kept" },
          { key: "exp_old", hidden: true, text: "archived-secret" },
        ],
        roles: [{ role: "exp-role" }],
        grants: [{ id: "grant-export" }],
      },
    });
    expect(live.key).toBe("exp_live");
    const recorded = await mongo.db.adminEvents.raw.find({}).toArray();
    expect(recorded.map((e) => [e.action, e.target.id])).toEqual([
      ["user.export", subject],
    ]);
    expect(JSON.stringify(recorded)).not.toContain("archived-secret");
  });

  test("userDataExport needs edit; an unknown user is NOT_FOUND", async () => {
    const query = (user: string) =>
      `{ userDataExport(tenantId: "${tenantA}", userId: "${user}") { exportedAt } }`;
    expect(code(await asConsole(vwA, query(uA1)))).toBe("FORBIDDEN");
    expect(code(await asConsole(ownA, query("ghost")))).toBe("NOT_FOUND");
  });

  test("deleteUser erases the user's attribute values, and a repeat is true", async () => {
    const a = await poolOf(slugA);
    const holder = (await a.auth.create({ email: "erase@end.test" })).id;
    await giveValue(holder, "erase_me", "personal");
    const held = () =>
      mongo.db.attributeValues.raw.countDocuments({ userId: holder });
    expect(await held()).toBe(1);
    const del = () =>
      asConsole(
        ownA,
        `mutation { deleteUser(tenantId: "${tenantA}", userId: "${holder}") }`,
      );
    expect((await del()).data).toEqual({ deleteUser: true });
    expect(await held()).toBe(0);
    expect((await del()).data).toEqual({ deleteUser: true });
  });
});
