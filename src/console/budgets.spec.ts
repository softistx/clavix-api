import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { defineRedis, openRedis } from "@softistx/redis";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { RedisClient } from "bun";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { forTenant } from "@/config/users";
import { webhookDelivery } from "@/config/webhooks";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { type ConsoleResult, consoleRequestAs } from "~/console";
import {
  type ConsoleLimitConfig,
  consoleLimits,
  createConsoleBudgets,
} from "./budgets";

// The attacker here is a tenant's own admin (or a stolen console token): each
// test fails without the budget, the calls then going through one after the other.

// A plan with room for the endpoints these specs create.
const PRO = "pro" as const;

let server: TestRedis;
let tenantA = "";
let tenantB = "";
const owners = { a: "", a2: "", b: "" };

const roomy = 1_000;
const base: ConsoleLimitConfig = {
  testEndpointLimit: roomy,
  testTenantLimit: roomy,
  testWindowSeconds: 60,
  inviteCallerLimit: roomy,
  inviteCallerWindowSeconds: 3600,
  inviteTenantLimit: roomy,
  inviteTenantWindowSeconds: 3600,
};

// The console as `userId`, over real limits on the test Redis.
async function consoleWith(
  userId: string,
  config: Partial<ConsoleLimitConfig>,
) {
  const redis = await openRedis(
    defineRedis({
      client: new RedisClient(server.uri),
      prefix: "clavix",
      limits: consoleLimits({ ...base, ...config }),
    }),
  );
  return consoleRequestAs(userId, {
    budgets: createConsoleBudgets(redis.limits, () => {}),
  });
}

const bodyOf = async (response: Response) =>
  (await response.json()) as ConsoleResult & {
    errors?: { extensions?: { code?: string; retryAfter?: number } }[];
  };

// Past a budget: the console's throttled error, with the wait in seconds.
async function expectRateLimited(response: Response) {
  expect(response.status).toBe(429);
  const wait = Number(response.headers.get("retry-after"));
  expect(wait).toBeGreaterThanOrEqual(1);
  const body = await bodyOf(response);
  expect(body.errors?.[0]?.extensions?.code).toBe("RATE_LIMITED");
  expect(body.errors?.[0]?.extensions?.retryAfter).toBe(wait);
  return body;
}

beforeAll(async () => {
  server = await startTestRedis();
  // The callers are real users of the platform pool: an invitation records who invited.
  const resolved = await tenantResolver.resolveHost(
    `${PLATFORM_TENANT_SLUG}.${env.CLAVIX_DOMAIN}`,
  );
  const platform = resolved === null ? null : await forTenant(resolved);
  if (platform === null) throw new Error("no platform pool");
  const operator = async (email: string) =>
    (await platform.create({ email, name: email })).id;
  owners.a = await operator("bud-a@bud.test");
  owners.a2 = await operator("bud-a2@bud.test");
  owners.b = await operator("bud-b@bud.test");
  tenantA = (
    await tenantsService.create({ slug: "bud-a", name: "A", plan: PRO })
  ).id;
  tenantB = (
    await tenantsService.create({ slug: "bud-b", name: "B", plan: PRO })
  ).id;
  await access.grantTenant(tenantA, owners.a, "owner");
  await access.grantTenant(tenantA, owners.a2, "owner");
  await access.grantTenant(tenantB, owners.b, "owner");
}, 300_000);

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.webhookEndpoints.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
  await server?.stop();
});

beforeEach(async () => {
  await server.reset();
  await mongo.db.webhookEndpoints.raw.deleteMany({});
});

describe("sendTestWebhook", () => {
  // An IP literal: the address policy needs no DNS lookup, and it is public.
  const CREATE = `mutation($tenantId: ID!) {
    createWebhookEndpoint(tenantId: $tenantId, input: { url: "https://93.184.216.34/hook" }) { endpoint { id } }
  }`;
  const TEST = `mutation($tenantId: ID!, $id: ID!) { sendTestWebhook(tenantId: $tenantId, id: $id) }`;
  // No request leaves the spec: what counts is how many test events were queued.
  const queued = spyOn(webhookDelivery, "sendTest");
  beforeEach(() => {
    queued.mockReset();
    queued.mockImplementation(async () => crypto.randomUUID());
  });
  afterAll(() => queued.mockRestore());

  async function endpointOf(
    call: Awaited<ReturnType<typeof consoleWith>>,
    tenantId: string,
  ) {
    const body = await bodyOf(await call(CREATE, { tenantId }));
    expect(body.errors).toBeUndefined();
    const created = body.data?.["createWebhookEndpoint"] as
      | { endpoint: { id: string } }
      | undefined;
    return (created as { endpoint: { id: string } }).endpoint.id;
  }

  test("a loop on one endpoint stops at the endpoint's budget, and queues nothing past it", async () => {
    const call = await consoleWith(owners.a, {
      testEndpointLimit: 3,
    });
    const id = await endpointOf(call, tenantA);
    const other = await endpointOf(call, tenantA);
    for (let sent = 0; sent < 3; sent++) {
      const body = await bodyOf(await call(TEST, { tenantId: tenantA, id }));
      expect(body.errors).toBeUndefined();
    }
    for (let refused = 0; refused < 5; refused++) {
      await expectRateLimited(await call(TEST, { tenantId: tenantA, id }));
    }
    expect(queued).toHaveBeenCalledTimes(3);
    // Another endpoint of the tenant has its own budget.
    const fine = await bodyOf(
      await call(TEST, { tenantId: tenantA, id: other }),
    );
    expect(fine.errors).toBeUndefined();
  });

  test("spreading the loop over the tenant's endpoints stops at the tenant's budget; another tenant is untouched", async () => {
    const call = await consoleWith(owners.a, {
      testTenantLimit: 4,
    });
    const ids = [
      await endpointOf(call, tenantA),
      await endpointOf(call, tenantA),
      await endpointOf(call, tenantA),
    ];
    const answers: number[] = [];
    for (let sent = 0; sent < 9; sent++) {
      const response = await call(TEST, {
        tenantId: tenantA,
        id: ids[sent % ids.length],
      });
      answers.push(response.status);
    }
    expect(answers).toEqual([200, 200, 200, 200, 429, 429, 429, 429, 429]);
    expect(queued).toHaveBeenCalledTimes(4);

    const neighbour = await consoleWith(owners.b, {
      testTenantLimit: 4,
    });
    const theirs = await endpointOf(neighbour, tenantB);
    const fine = await bodyOf(
      await neighbour(TEST, { tenantId: tenantB, id: theirs }),
    );
    expect(fine.errors).toBeUndefined();
  });

  test("a refused call (unknown endpoint) spends nothing", async () => {
    const call = await consoleWith(owners.a, {
      testTenantLimit: 1,
    });
    const id = await endpointOf(call, tenantA);
    for (let asked = 0; asked < 3; asked++) {
      const body = await bodyOf(
        await call(TEST, { tenantId: tenantA, id: "0".repeat(24) }),
      );
      expect(body.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }
    const fine = await bodyOf(await call(TEST, { tenantId: tenantA, id }));
    expect(fine.errors).toBeUndefined();
  });
});

describe("inviteUser and inviteAdmin", () => {
  // One admin event per invitation issued (and so per mail sent).
  const pending = (tenantId: string) =>
    mongo.db.adminEvents.raw.countDocuments({
      tenantId: new ObjectId(tenantId),
      action: { $in: ["user.invite", "membership.invite"] },
    });
  const aliased = (count: number, tag: string, tenantId = tenantA) =>
    `mutation { ${Array.from(
      { length: count },
      (_, i) =>
        `m${i}: inviteUser(tenantId: "${tenantId}", email: "${tag}-${i}@bud.test") { id }`,
    ).join(" ")} }`;

  test("one POST of aliased invitations counts each one: past the caller's budget none runs", async () => {
    const call = await consoleWith(owners.a, {
      inviteCallerLimit: 5,
    });
    const before = await pending(tenantA);
    // Six aliases in one request: over the budget of five, so no mail at all.
    await expectRateLimited(await call(aliased(6, "burst")));
    expect((await pending(tenantA)) - before).toBe(0);
    // Five fit; the sixth invitation, alone, is then refused.
    const fits = await bodyOf(await call(aliased(5, "fits")));
    expect(fits.errors).toBeUndefined();
    expect((await pending(tenantA)) - before).toBe(5);
    await expectRateLimited(await call(aliased(1, "sixth")));
    expect((await pending(tenantA)) - before).toBe(5);
  });

  test("the caller's budget is per caller and per mutation", async () => {
    const call = await consoleWith(owners.a, {
      inviteCallerLimit: 2,
    });
    expect(
      (await bodyOf(await call(aliased(2, "own")))).errors,
    ).toBeUndefined();
    await expectRateLimited(await call(aliased(1, "own-more")));
    // inviteAdmin has its own bucket for the same caller.
    const admin = await bodyOf(
      await call(
        `mutation { inviteAdmin(tenantId: "${tenantA}", email: "adm@bud.test", role: VIEWER) { id } }`,
      ),
    );
    expect(admin.errors).toBeUndefined();
    // Another admin of the same tenant is not held by the first one's spending.
    const colleague = await consoleWith(owners.a2, {
      inviteCallerLimit: 2,
    });
    expect(
      (await bodyOf(await colleague(aliased(1, "colleague")))).errors,
    ).toBeUndefined();
  });

  test("several callers together stop at the tenant's budget, users and admins counted together", async () => {
    const config = { inviteTenantLimit: 3 };
    const first = await consoleWith(owners.a, config);
    const second = await consoleWith(owners.a2, config);
    const before = await pending(tenantA);
    expect(
      (await bodyOf(await first(aliased(2, "t-first")))).errors,
    ).toBeUndefined();
    const admin = await bodyOf(
      await second(
        `mutation { inviteAdmin(tenantId: "${tenantA}", email: "t-adm@bud.test", role: VIEWER) { id } }`,
      ),
    );
    expect(admin.errors).toBeUndefined();
    // The tenant's three are spent: a fourth is refused, whoever asks and whichever mutation.
    const user = await bodyOf(await second(aliased(1, "t-fourth")));
    expect(user.errors?.[0]?.extensions?.code).toBe("RATE_LIMITED");
    expect(user.errors?.[0]?.extensions?.retryAfter).toBeGreaterThanOrEqual(1);
    const again = await bodyOf(
      await first(
        `mutation { inviteAdmin(tenantId: "${tenantA}", email: "t-adm2@bud.test", role: VIEWER) { id } }`,
      ),
    );
    expect(again.errors?.[0]?.extensions?.code).toBe("RATE_LIMITED");
    expect((await pending(tenantA)) - before).toBe(3);
    // Another tenant's invitations are untouched.
    const neighbour = await consoleWith(owners.b, config);
    expect(
      (await bodyOf(await neighbour(aliased(1, "t-b", tenantB)))).errors,
    ).toBeUndefined();
  });
});

describe("Redis down", () => {
  test("the budgets let the call through, logged", async () => {
    const lines: string[] = [];
    const down = {
      consume: async () => {
        throw new Error("connection closed");
      },
    };
    const budgets = createConsoleBudgets(
      {
        webhookTestEndpoint: down,
        webhookTestTenant: down,
        inviteCaller: down,
        inviteTenant: down,
      },
      (line) => lines.push(line),
    );
    await budgets.testWebhook({ tenantId: "t", endpointId: "e" });
    await budgets.invitation({ tenantId: "t" });
    expect(await budgets.inviteCaller.consume("inviteUser:u", 3)).toEqual({
      allowed: true,
      retryAfter: 0,
    });
    // The webhook test spends two limits.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("console budgets skipped");
  });
});
