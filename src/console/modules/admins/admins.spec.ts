import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { CONSOLE_PATH } from "../../identity";

// The bearer token is the user id: tokens are console.spec's business, this
// file is about who may change the admins of a tenant.
const deps = createConsoleDeps({ serverFor: async () => null });
const app = createApp({
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
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const hosted = `${issuerOf(PLATFORM_TENANT_SLUG, origin)}/graphql`;

interface Answer {
  // biome-ignore lint/suspicious/noExplicitAny: a spec reads the answer by path
  data: Record<string, any> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  cookies: string[];
}
async function post(
  url: string,
  query: string,
  bearer?: string,
): Promise<Answer> {
  const response = await app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as Answer;
  return {
    ...body,
    data: body.data ?? null,
    cookies: response.headers.getSetCookie(),
  };
}
const asConsole = (bearer: string, query: string) =>
  post(`http://localhost${CONSOLE_PATH}`, query, bearer);
const code = (answer: Answer) => answer.errors?.[0]?.extensions?.code;

let ownA = "";
let ownA2 = "";
let admA = "";
let vwA = "";
let ownB = "";
let tenantA = "";
let tenantB = "";

const roleIn = async (tenant: string, user: string) =>
  (
    await asConsole(
      ownA,
      `{ memberships(tenantId: "${tenant}") { user { id } role } }`,
    )
  ).data?.["memberships"]?.find(
    (m: { user: { id: string } }) => m.user.id === user,
  )?.role;

// The code of the invitation mailed to an address.
const codeMailedTo = (email: string) => {
  const mail = memory.sent
    .filter((m) => JSON.stringify(m.to).includes(email))
    .at(-1);
  return /invitation\?code=([^"&\s)<]+)/.exec(
    `${mail?.text ?? ""} ${mail?.html ?? ""}`,
  )?.[1];
};
const invite = (
  bearer: string,
  tenant: string,
  email: string,
  role = "ADMIN",
) =>
  asConsole(
    bearer,
    `mutation { inviteAdmin(tenantId: "${tenant}", email: "${email}", role: ${role}) { id email role } }`,
  );

beforeAll(async () => {
  const janus = await janusIssuers.forRequest(new Request(hosted));
  if (janus === null) throw new Error("no clavix janus");
  const user = async (email: string) =>
    (await janus.create({ email, name: email })).id;
  [ownA, ownA2, admA, vwA, ownB] = (await Promise.all(
    ["own-a", "own-a2", "adm-a", "vw-a", "own-b"].map((n) =>
      user(`${n}@adm.test`),
    ),
  )) as [string, string, string, string, string];
  tenantA = (await tenantsService.create({ slug: "adm-a", name: "Alpha" })).id;
  tenantB = (await tenantsService.create({ slug: "adm-b", name: "Beta" })).id;
  await access.grantTenant(tenantA, ownA, "owner");
  await access.grantTenant(tenantA, admA, "admin");
  await access.grantTenant(tenantA, vwA, "viewer");
  await access.grantTenant(tenantB, ownB, "owner");
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

describe("permission per role", () => {
  test("every role of the tenant reads the admins", async () => {
    for (const who of [ownA, admA, vwA]) {
      const result = await asConsole(
        who,
        `{ memberships(tenantId: "${tenantA}") { role } adminInvitations(tenantId: "${tenantA}") { id } }`,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.["memberships"]).toHaveLength(3);
    }
  });

  test("an admin or a viewer cannot invite, change or remove", async () => {
    for (const who of [admA, vwA]) {
      expect(code(await invite(who, tenantA, "x@adm.test"))).toBe("FORBIDDEN");
      expect(
        code(
          await asConsole(
            who,
            `mutation { changeMembership(tenantId: "${tenantA}", userId: "${vwA}", role: ADMIN) { role } }`,
          ),
        ),
      ).toBe("FORBIDDEN");
      expect(
        code(
          await asConsole(
            who,
            `mutation { removeMembership(tenantId: "${tenantA}", userId: "${vwA}") }`,
          ),
        ),
      ).toBe("FORBIDDEN");
      expect(
        code(
          await asConsole(
            who,
            `mutation { revokeAdminInvitation(tenantId: "${tenantA}", invitationId: "x") }`,
          ),
        ),
      ).toBe("FORBIDDEN");
    }
    expect(await roleIn(tenantA, vwA)).toBe("VIEWER");
  });
});

describe("tenant A / B isolation", () => {
  test("the owner of A reads and touches nothing of B", async () => {
    expect(
      code(
        await asConsole(
          ownA,
          `{ memberships(tenantId: "${tenantB}") { role } }`,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(
        await asConsole(
          ownA,
          `{ adminInvitations(tenantId: "${tenantB}") { id } }`,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(code(await invite(ownA, tenantB, "intruder@adm.test"))).toBe(
      "FORBIDDEN",
    );
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { removeMembership(tenantId: "${tenantB}", userId: "${ownB}") }`,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { changeMembership(tenantId: "${tenantB}", userId: "${ownB}", role: VIEWER) { role } }`,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  test("an invitation id of A does nothing on B, and B does not list A's", async () => {
    const issued = await invite(ownA, tenantA, "iso@adm.test", "VIEWER");
    const id = issued.data?.["inviteAdmin"].id as string;
    await asConsole(
      ownB,
      `mutation { revokeAdminInvitation(tenantId: "${tenantB}", invitationId: "${id}") }`,
    );
    const listedB = await asConsole(
      ownB,
      `{ adminInvitations(tenantId: "${tenantB}") { id } }`,
    );
    expect(listedB.data?.["adminInvitations"]).toEqual([]);
    const listedA = await asConsole(
      ownA,
      `{ adminInvitations(tenantId: "${tenantA}") { id email } }`,
    );
    expect(
      listedA.data?.["adminInvitations"].map((i: { id: string }) => i.id),
    ).toContain(id);
  });

  test("an id that names no tenant is refused", async () => {
    expect(code(await invite(ownA, "0".repeat(24), "x@adm.test"))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("inviting and accepting", () => {
  test("accepting grants the relation, exactly once", async () => {
    const email = "newadmin@adm.test";
    const issued = await invite(ownA, tenantA, email, "ADMIN");
    expect(issued.errors).toBeUndefined();
    expect(issued.data?.["inviteAdmin"]).toMatchObject({
      email,
      role: "ADMIN",
    });
    const secret = codeMailedTo(email);
    expect(secret).toBeDefined();

    const preview = await post(
      hosted,
      `{ invitationPreview(code: "${secret}") { email organization role } }`,
    );
    expect(preview.data?.["invitationPreview"]).toEqual({
      email,
      organization: "Alpha",
      role: "admin",
    });

    const accepted = await post(
      hosted,
      `mutation { acceptInvitation(code: "${secret}") { signedIn organization user { email } } }`,
    );
    expect(accepted.errors).toBeUndefined();
    expect(accepted.data?.["acceptInvitation"]).toMatchObject({
      signedIn: true,
      organization: "Alpha",
      user: { email },
    });
    expect(accepted.cookies.join(";")).toContain("__Host-clavix-session=");

    const members = (
      await asConsole(
        ownA,
        `{ memberships(tenantId: "${tenantA}") { user { email } role } }`,
      )
    ).data?.["memberships"];
    expect(
      members.filter(
        (m: { user: { email: string } }) => m.user.email === email,
      ),
    ).toEqual([{ user: { email }, role: "ADMIN" }]);

    // The code is spent: a second accept and a preview are refused, nothing changes.
    const again = await post(
      hosted,
      `mutation { acceptInvitation(code: "${secret}") { signedIn } }`,
    );
    expect(code(again)).toBe("INVITATION_INVALID");
    expect(
      code(
        await post(
          hosted,
          `{ invitationPreview(code: "${secret}") { email } }`,
        ),
      ),
    ).toBe("INVITATION_INVALID");
    const after = (
      await asConsole(
        ownA,
        `{ memberships(tenantId: "${tenantA}") { role } adminInvitations(tenantId: "${tenantA}") { email } }`,
      )
    ).data;
    expect(after?.["memberships"]).toHaveLength(members.length);
    expect(
      after?.["adminInvitations"].map((i: { email: string }) => i.email),
    ).not.toContain(email);
  });

  test("the new admin is the invitee's, not the platform's: no access to B", async () => {
    const user =
      (
        await (
          await janusIssuers.forRequest(new Request(hosted))
        )?.findByEmail("newadmin@adm.test")
      )?.id ?? "";
    expect(
      code(
        await asConsole(
          user,
          `{ memberships(tenantId: "${tenantB}") { role } }`,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  test("inviting again replaces the pending invitation (one pending per address)", async () => {
    const email = "twice@adm.test";
    await invite(ownA, tenantA, email, "VIEWER");
    const first = codeMailedTo(email);
    await invite(ownA, tenantA, email, "ADMIN");
    const listed = await asConsole(
      ownA,
      `{ adminInvitations(tenantId: "${tenantA}") { email role } }`,
    );
    expect(
      listed.data?.["adminInvitations"].filter(
        (i: { email: string }) => i.email === email,
      ),
    ).toEqual([{ email, role: "ADMIN" }]);
    expect(
      code(
        await post(
          hosted,
          `mutation { acceptInvitation(code: "${first}") { signedIn } }`,
        ),
      ),
    ).toBe("INVITATION_INVALID");
    expect(
      await post(
        hosted,
        `mutation { acceptInvitation(code: "${codeMailedTo(email)}") { signedIn } }`,
      ).then((r) => r.errors),
    ).toBeUndefined();
  });

  test("a member cannot be invited again; a revoked invitation cannot be accepted", async () => {
    expect(code(await invite(ownA, tenantA, "adm-a@adm.test"))).toBe(
      "ALREADY_MEMBER",
    );
    const email = "revoked@adm.test";
    const id = (await invite(ownA, tenantA, email)).data?.["inviteAdmin"]
      .id as string;
    const secret = codeMailedTo(email);
    const revoke = `mutation { revokeAdminInvitation(tenantId: "${tenantA}", invitationId: "${id}") }`;
    expect(
      (await asConsole(ownA, revoke)).data?.["revokeAdminInvitation"],
    ).toBe(true);
    expect((await asConsole(ownA, revoke)).errors).toBeUndefined(); // idempotent
    expect(
      code(
        await post(
          hosted,
          `mutation { acceptInvitation(code: "${secret}") { signedIn } }`,
        ),
      ),
    ).toBe("INVITATION_INVALID");
  });

  test("an unknown or garbled code is INVITATION_INVALID", async () => {
    expect(
      code(
        await post(
          hosted,
          `mutation { acceptInvitation(code: "nope") { signedIn } }`,
        ),
      ),
    ).toBe("INVITATION_INVALID");
  });
});

describe("changing and removing, the last owner protected", () => {
  test("changeMembership is idempotent and refuses a non-member", async () => {
    const change = `mutation { changeMembership(tenantId: "${tenantA}", userId: "${vwA}", role: ADMIN) { role } }`;
    expect((await asConsole(ownA, change)).data?.["changeMembership"]).toEqual({
      role: "ADMIN",
    });
    expect((await asConsole(ownA, change)).data?.["changeMembership"]).toEqual({
      role: "ADMIN",
    });
    expect(await roleIn(tenantA, vwA)).toBe("ADMIN");
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { changeMembership(tenantId: "${tenantA}", userId: "${ownB}", role: ADMIN) { role } }`,
        ),
      ),
    ).toBe("NOT_FOUND");
  });

  test("the last owner can be neither demoted nor removed", async () => {
    const demote = await asConsole(
      ownA,
      `mutation { changeMembership(tenantId: "${tenantA}", userId: "${ownA}", role: ADMIN) { role } }`,
    );
    expect(code(demote)).toBe("LAST_OWNER");
    const remove = await asConsole(
      ownA,
      `mutation { removeMembership(tenantId: "${tenantA}", userId: "${ownA}") }`,
    );
    expect(code(remove)).toBe("LAST_OWNER");
    expect(await roleIn(tenantA, ownA)).toBe("OWNER");
  });

  test("with a second owner the first can step down; the second is then last", async () => {
    await asConsole(
      ownA,
      `mutation { changeMembership(tenantId: "${tenantA}", userId: "${admA}", role: OWNER) { role } }`,
    );
    expect(
      (
        await asConsole(
          admA,
          `mutation { removeMembership(tenantId: "${tenantA}", userId: "${ownA}") }`,
        )
      ).data?.["removeMembership"],
    ).toBe(true);
    expect(await roleIn(tenantA, ownA)).toBeUndefined();
    // admA is the last owner now; ownA lost the right to ask.
    expect(
      code(
        await asConsole(
          ownA,
          `mutation { removeMembership(tenantId: "${tenantA}", userId: "${admA}") }`,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(
        await asConsole(
          admA,
          `mutation { removeMembership(tenantId: "${tenantA}", userId: "${admA}") }`,
        ),
      ),
    ).toBe("LAST_OWNER");
  });

  test("removing a non-member is true (idempotent)", async () => {
    expect(
      (
        await asConsole(
          admA,
          `mutation { removeMembership(tenantId: "${tenantA}", userId: "${ownA2}") }`,
        )
      ).data?.["removeMembership"],
    ).toBe(true);
  });

  test("two concurrent demotions of two owners leave one", async () => {
    await access.grantTenant(tenantB, ownA2, "owner");
    const demote = (user: string) =>
      asConsole(
        ownB,
        `mutation { removeMembership(tenantId: "${tenantB}", userId: "${user}") }`,
      );
    await Promise.all([demote(ownB), demote(ownA2)]);
    const owners = await access.holders(tenantB, "owner");
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });
});
