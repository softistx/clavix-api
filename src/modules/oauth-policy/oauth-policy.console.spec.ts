import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OptimisticLockError } from "@softistx/mongo";
import type { GraphQLError } from "graphql";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { adminEventReader, adminEventRecorder } from "@/config/admin-events";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import type { ConsoleAdmins, ConsoleUsers } from "@/console/context";
import { createExclusive } from "@/console/exclusive";
import { CONSOLE_CLIENT_ID, CONSOLE_PATH } from "@/console/identity";
import { OAuthPolicyService } from "@/modules/oauth-policy/oauth-policy.service";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { clientHeaders } from "~/client-header";

interface Policy {
  tenantId: string;
  par: { required: boolean };
  dpop: { required: boolean };
  version: number;
}
interface Result {
  data?: Record<string, Policy> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  text: string;
}

const as = async (
  userId: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Result> => {
  const response = await createApp({
    console: {
      now: () => new Date(),
      reportError: () => {},
      authenticate: async () => ({
        userId,
        clientId: CONSOLE_CLIENT_ID,
        grantId: "g",
        scopes: ["console"],
        clientName: null,
        bound: null,
        jkt: null,
        authorizationDetails: [],
      }),
      access,
      adminEvents: adminEventRecorder,
      activity: { admin: adminEventReader, auth: authEventsService },
      admins: {} as ConsoleAdmins,
      users: {} as ConsoleUsers,
      exclusive: createExclusive(),
      directory: {
        findUser: async () => null,
        emailVerified: async () => true,
        findUserByEmail: async () => null,
        tenantsByIds: async () => [],
      },
    },
  }).request(`http://localhost${CONSOLE_PATH}`, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      authorization: "Bearer x",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  return { ...(JSON.parse(text) as Omit<Result, "text">), text };
};
const codeOf = (result: Result) => result.errors?.[0]?.extensions?.code;

const FIELDS = "tenantId version par { required } dpop { required }";
const POLICY = `query ($t: ID!) { oauthPolicy(tenantId: $t) { ${FIELDS} } }`;
const UPDATE = `mutation ($t: ID!, $i: OAuthPolicyInput!) {
  updateOAuthPolicy(tenantId: $t, input: $i) { ${FIELDS} }
}`;

const OWNER = "oap-owner";
const VIEWER = "oap-viewer";
const OTHER = "oap-other";
const PLATFORM_ADMIN = "oap-platform-admin";
let a = "";
let b = "";

const stored = async (id: string) => {
  const [tenant] = await tenantsService.activeByIds([id]);
  if (tenant === undefined) throw new Error("no tenant");
  return tenant;
};
const eventsOf = async (tenantId: string) =>
  (
    await mongo.db.adminEvents.raw
      .find({ action: "oauthPolicy.update", "target.id": tenantId })
      .sort({ _id: 1 })
      .toArray()
  ).map((event) => event["target"]);

beforeAll(async () => {
  a = (await tenantsService.create({ slug: "oap-a", name: "A" })).id;
  b = (await tenantsService.create({ slug: "oap-b", name: "B" })).id;
  await access.grantTenant(a, OWNER, "owner");
  await access.grantTenant(a, VIEWER, "viewer");
  await access.grantTenant(b, OTHER, "admin");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $nin: [PLATFORM_TENANT_SLUG] },
  });
  await oauthDb.collection("relations").deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("guards", () => {
  test("a viewer reads the policy and cannot change it", async () => {
    const read = await as(VIEWER, POLICY, { t: a });
    expect(read.data?.["oauthPolicy"]?.par.required).toBe(true);
    const before = (await stored(a)).version;
    const write = await as(VIEWER, UPDATE, {
      t: a,
      i: { par: { required: false } },
    });
    expect(codeOf(write)).toBe("FORBIDDEN");
    expect((await stored(a)).version).toBe(before);
  });

  test("another tenant's admin can neither read nor change it", async () => {
    expect(codeOf(await as(OTHER, POLICY, { t: a }))).toBe("FORBIDDEN");
    expect(
      codeOf(
        await as(OTHER, UPDATE, { t: a, i: { par: { required: false } } }),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("updateOAuthPolicy", () => {
  test("an owner turns PAR off and on: the version rises and each change is an admin event", async () => {
    const before = await stored(a);
    const off = await as(OWNER, UPDATE, {
      t: a,
      i: { par: { required: false } },
    });
    expect(off.data?.["updateOAuthPolicy"]).toMatchObject({
      par: { required: false },
      dpop: { required: false },
      version: before.version + 1,
    });
    const on = await as(OWNER, UPDATE, {
      t: a,
      i: { par: { required: true } },
    });
    expect(on.data?.["updateOAuthPolicy"]?.par.required).toBe(true);
    expect((await stored(a)).oauth.par.required).toBe(true);
    expect((await eventsOf(a)).length).toBe(2);
  });

  test("a call that changes nothing writes nothing but is still recorded", async () => {
    const before = await stored(a);
    const events = (await eventsOf(a)).length;
    const same = await as(OWNER, UPDATE, {
      t: a,
      i: { par: { required: true } },
    });
    expect(same.data?.["updateOAuthPolicy"]?.version).toBe(before.version);
    expect((await stored(a)).version).toBe(before.version);
    expect((await eventsOf(a)).length).toBe(events + 1);
  });

  test("a flag left out keeps its value", async () => {
    const result = await as(OWNER, UPDATE, {
      t: a,
      i: { dpop: { required: true } },
    });
    expect(result.data?.["updateOAuthPolicy"]).toMatchObject({
      par: { required: true },
      dpop: { required: true },
    });
    await as(OWNER, UPDATE, { t: a, i: { dpop: { required: false } } });
  });

  test("the platform tenant may require PAR and DPoP (the console pushes and proves), and relax them again", async () => {
    const platform = await mongo.db.tenants.raw.findOne({
      slug: PLATFORM_TENANT_SLUG,
    });
    if (platform === null) throw new Error("no platform tenant");
    const id = platform._id.toHexString();
    await access.grantTenant(id, PLATFORM_ADMIN, "admin");
    const before = await stored(id);
    const on = await as(PLATFORM_ADMIN, UPDATE, {
      t: id,
      i: { par: { required: true }, dpop: { required: true } },
    });
    expect(on.errors).toBeUndefined();
    expect((await stored(id)).oauth).toMatchObject({
      par: { required: true },
      dpop: { required: true },
    });
    // Restored: the other specs share this tenant.
    const off = await as(PLATFORM_ADMIN, UPDATE, {
      t: id,
      i: { par: { required: false }, dpop: { required: false } },
    });
    expect(off.errors).toBeUndefined();
    const after = await stored(id);
    expect(after.oauth).toEqual(before.oauth);
    expect(after.version).toBe(before.version + 2);
  });

  test("a tenant that does not exist is NOT_FOUND to the service, and a lost race is CONFLICT", async () => {
    const service = new OAuthPolicyService(tenantsService);
    const missing = await service
      .update("65f0000000000000000000aa", { par: { required: true } })
      .catch((error: unknown) => error);
    expect((missing as GraphQLError).extensions).toMatchObject({
      code: "NOT_FOUND",
    });
    const lost = new OAuthPolicyService({
      liveByIds: tenantsService.liveByIds.bind(tenantsService),
      updateOAuth: async () => {
        throw Object.create(OptimisticLockError.prototype);
      },
    } as unknown as typeof tenantsService);
    const refusal = await lost
      .update(b, { par: { required: false } })
      .catch((error: unknown) => error);
    expect((refusal as GraphQLError).extensions).toMatchObject({
      code: "CONFLICT",
      http: { status: 409 },
    });
  });
});

const AGENT_FIELDS = `tenantId version par { required } dpop { required }
  agents { dynamic redirectUris metadataDocuments allowHosts } agentsNeedPushOrProof`;
const AGENTS_POLICY = `query ($t: ID!) { oauthPolicy(tenantId: $t) { ${AGENT_FIELDS} } }`;
const AGENTS_UPDATE = `mutation ($t: ID!, $i: OAuthPolicyInput!) {
  updateOAuthPolicy(tenantId: $t, input: $i) { ${AGENT_FIELDS} }
}`;
interface AgentPolicy {
  version: number;
  agents: {
    dynamic: string;
    redirectUris: string[];
    metadataDocuments: boolean;
    allowHosts: string[];
  };
  agentsNeedPushOrProof: boolean;
}
const agentsOf = (result: Result) =>
  (result.data as unknown as Record<string, AgentPolicy>)[
    "updateOAuthPolicy"
  ] as AgentPolicy;

describe("agents policy", () => {
  test("a tenant starts with agents off and no warning", async () => {
    const read = await as(VIEWER, AGENTS_POLICY, { t: a });
    const policy = (read.data as unknown as Record<string, AgentPolicy>)[
      "oauthPolicy"
    ] as AgentPolicy;
    expect(policy.agents).toEqual({
      dynamic: "OFF",
      redirectUris: [],
      metadataDocuments: false,
      allowHosts: [],
    });
    expect(policy.agentsNeedPushOrProof).toBe(false);
  });

  test("turning agents on while PAR is required flags it, saving is allowed, each write is an event", async () => {
    const before = await stored(a);
    const events = (await eventsOf(a)).length;
    const result = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: {
        agents: {
          dynamic: "RESTRICTED",
          redirectUris: [
            "https://agent.example/cb",
            "https://agent.example/cb",
          ],
          metadataDocuments: true,
          allowHosts: ["Docs.Example.com", "docs.example.com"],
        },
      },
    });
    expect(result.errors).toBeUndefined();
    const policy = agentsOf(result);
    expect(policy.agents).toEqual({
      dynamic: "RESTRICTED",
      redirectUris: ["https://agent.example/cb"],
      metadataDocuments: true,
      allowHosts: ["docs.example.com"],
    });
    expect(policy.agentsNeedPushOrProof).toBe(true);
    expect(policy.version).toBe(before.version + 1);
    expect((await stored(a)).oauth.agents.dynamic).toBe("restricted");
    expect((await eventsOf(a)).length).toBe(events + 1);
  });

  test("the warning follows PAR and DPoP, and a repeat write stores nothing", async () => {
    const off = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: { par: { required: false } },
    });
    expect(agentsOf(off).agentsNeedPushOrProof).toBe(false);
    const dpop = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: { dpop: { required: true } },
    });
    expect(agentsOf(dpop).agentsNeedPushOrProof).toBe(true);
    const version = (await stored(a)).version;
    const same = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: { agents: { dynamic: "RESTRICTED", metadataDocuments: true } },
    });
    expect(agentsOf(same).version).toBe(version);
    expect((await stored(a)).version).toBe(version);
    await as(OWNER, AGENTS_UPDATE, { t: a, i: { dpop: { required: false } } });
  });

  test("a field left out keeps its value, and OFF with no metadata documents clears the warning", async () => {
    await as(OWNER, AGENTS_UPDATE, { t: a, i: { par: { required: true } } });
    const kept = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: { agents: { allowHosts: [] } },
    });
    expect(agentsOf(kept).agents.redirectUris).toEqual([
      "https://agent.example/cb",
    ]);
    expect(agentsOf(kept).agents.allowHosts).toEqual([]);
    const off = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: { agents: { dynamic: "OFF", metadataDocuments: false } },
    });
    expect(agentsOf(off).agentsNeedPushOrProof).toBe(false);
  });

  test("a wildcard host is accepted and lower-cased", async () => {
    const result = await as(OWNER, AGENTS_UPDATE, {
      t: a,
      i: { agents: { allowHosts: ["*.Example.com"] } },
    });
    expect(result.errors).toBeUndefined();
    expect(agentsOf(result).agents.allowHosts).toEqual(["*.example.com"]);
  });

  test("a bad redirect URI, host or a list over 50 is refused and stores nothing", async () => {
    const version = (await stored(a)).version;
    const events = (await eventsOf(a)).length;
    const bad = [
      { redirectUris: ["not a uri"] },
      { redirectUris: ["http://agent.example/cb"] },
      { allowHosts: ["https://docs.example.com/path"] },
      { allowHosts: ["bad host"] },
      { allowHosts: ["*"] },
      { allowHosts: ["foo.*.com"] },
      { allowHosts: Array.from({ length: 51 }, (_, i) => `h${i}.example.com`) },
    ];
    for (const agents of bad) {
      const result = await as(OWNER, AGENTS_UPDATE, { t: a, i: { agents } });
      expect(codeOf(result)).toBe("BAD_USER_INPUT");
    }
    expect((await stored(a)).version).toBe(version);
    expect((await eventsOf(a)).length).toBe(events);
  });

  test("a viewer cannot change the agents policy", async () => {
    const result = await as(VIEWER, AGENTS_UPDATE, {
      t: a,
      i: { agents: { dynamic: "OPEN" } },
    });
    expect(codeOf(result)).toBe("FORBIDDEN");
  });
});
