import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { UserEvent } from "@softistx/janus";
import {
  createMemoryWebhookQueue,
  mintWebhookSecret,
  verifyWebhook,
} from "@softistx/janus-webhooks";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { createSecretBox } from "@/modules/sign-in-methods";
import {
  createWebhookDelivery,
  type DisabledEndpoint,
} from "./webhooks.delivery";
import { userWebhookEvent } from "./webhooks.events";
import { WebhooksService } from "./webhooks.service";
import { guardedFetch, type UrlPolicy } from "./webhooks.url-policy";

// The "receiver" is a fetch that records each request and answers with the
// next status; the address policy is the real one with an injected resolver.
interface Received {
  url: string;
  headers: Headers;
  body: string;
}
let received: Received[] = [];
let statuses: number[] = [];
const receiver = (async (input: RequestInfo | URL, init?: RequestInit) => {
  received.push({
    url: String(input),
    headers: new Headers(init?.headers),
    body: String(init?.body),
  });
  return new Response("", { status: statuses.shift() ?? 200 });
}) as unknown as typeof fetch;

const policy: UrlPolicy = {
  allowPrivate: false,
  resolve: async () => ["93.184.216.34"],
};
let clock = new Date();
const endpoints = new WebhooksService(
  mongo.db.webhookEndpoints,
  mongo.db.webhookDeliveries,
  createSecretBox(
    crypto.getRandomValues(new Uint8Array(32)),
    "webhook-secrets",
  ),
  { policy, now: () => clock, mint: mintWebhookSecret, log: () => {} },
);
const A = new ObjectId().toHexString();
const B = new ObjectId().toHexString();
const disabled: DisabledEndpoint[] = [];
const deliveries: ReturnType<typeof createWebhookDelivery>[] = [];

const makeDelivery = (retries: readonly string[] = ["10ms"]) => {
  const delivery = createWebhookDelivery({
    webhooks: endpoints,
    fetch: guardedFetch(policy, receiver),
    queue: createMemoryWebhookQueue(),
    retries: retries as never,
    poll: "10ms" as never,
    onDisabled: async (endpoint) => {
      disabled.push(endpoint);
    },
    log: () => {},
  });
  deliveries.push(delivery);
  return delivery;
};

afterEach(async () => {
  for (const delivery of deliveries.splice(0)) await delivery.close();
  received = [];
  statuses = [];
  disabled.length = 0;
  clock = new Date();
  await mongo.db.webhookEndpoints.raw.deleteMany({});
  await mongo.db.webhookDeliveries.raw.deleteMany({});
});

const until = async (done: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await done()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
};

const created = (tenantId: string, id = crypto.randomUUID()) =>
  ({
    kind: "webhook",
    tenantId,
    event: userWebhookEvent(tenantId, {
      id,
      type: "user.created",
      userId: "u1",
      userType: "customer",
      occurredAt: new Date(),
    } as unknown as UserEvent),
  }) as const;

/** Standard Webhooks, by hand: base64(HMAC-SHA256(secret bytes, "id.timestamp.body")). */
const signedBy = (request: Received, secret: string) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = request.headers.get("webhook-id");
  const ts = request.headers.get("webhook-timestamp");
  const expected = createHmac("sha256", key)
    .update(`${id}.${ts}.${request.body}`)
    .digest("base64");
  const header = request.headers.get("webhook-signature") ?? "";
  return header.split(" ").includes(`v1,${expected}`);
};

describe("signed delivery", () => {
  test("a tenant receives user.created, signed, verified by verifyWebhook", async () => {
    const { secret } = await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const delivery = makeDelivery();
    const event = created(A);
    await delivery.relay(event);
    await until(() => received.length === 1);
    const [request] = received;
    expect(request?.url).toBe("https://hooks.example.com/in");
    expect(request && signedBy(request, secret)).toBe(true);
    const verified = verifyWebhook({
      secrets: [secret],
      headers: request?.headers as Headers,
      body: request?.body ?? "",
    });
    expect(verified?.type).toBe("user.created");
    const body = JSON.parse(request?.body ?? "{}");
    expect(body.type).toBe("user.created");
    expect(body.data).toEqual({
      tenantId: A,
      userId: "u1",
      userType: "customer",
    });
    expect(request?.headers.get("webhook-id")).toBe(event.event.id);
  });

  test("another tenant's events never reach the endpoint", async () => {
    await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const delivery = makeDelivery();
    await delivery.relay(created(B));
    await Bun.sleep(150);
    expect(received).toEqual([]);
  });

  test("an endpoint listing types gets only those", async () => {
    await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in", types: ["user.deleted"] },
      2,
    );
    const delivery = makeDelivery();
    await delivery.relay(created(A));
    await Bun.sleep(150);
    expect(received).toEqual([]);
  });

  test("a test event goes to its endpoint only, whatever its types", async () => {
    const one = await endpoints.createEndpoint(
      A,
      { url: "https://one.example.com/in", types: ["user.deleted"] },
      5,
    );
    await endpoints.createEndpoint(A, { url: "https://two.example.com/in" }, 5);
    const delivery = makeDelivery();
    await delivery.sendTest(A, one.endpoint._id.toHexString());
    await until(() => received.length === 1);
    await Bun.sleep(100);
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("https://one.example.com/in");
    expect(JSON.parse(received[0]?.body ?? "{}").type).toBe("webhook.test");
  });
});

describe("secret roll", () => {
  test("both signatures verify during a roll, only the new one after 24 h", async () => {
    const first = await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const id = first.endpoint._id.toHexString();
    const rolled = await endpoints.rollSecret(A, id, true);
    const delivery = makeDelivery();
    await delivery.relay(created(A));
    await until(() => received.length === 1);
    expect(signedBy(received[0] as Received, rolled.secret)).toBe(true);
    expect(signedBy(received[0] as Received, first.secret)).toBe(true);

    clock = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await delivery.relay(created(A));
    await until(() => received.length === 2);
    expect(signedBy(received[1] as Received, rolled.secret)).toBe(true);
    expect(signedBy(received[1] as Received, first.secret)).toBe(false);
  });
});

describe("failures", () => {
  test("a 500 is retried, then given up; five in a row disable the endpoint", async () => {
    const { endpoint } = await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const id = endpoint._id.toHexString();
    statuses = Array(50).fill(500);
    const delivery = makeDelivery(["10ms"]);
    for (let i = 0; i < 5; i++) await delivery.relay(created(A));
    await until(
      async () => (await endpoints.findEndpoint(A, id))?.enabled === false,
    );
    expect(received.length).toBeGreaterThanOrEqual(10);
    const stored = await endpoints.findEndpoint(A, id);
    expect(stored?.disabledReason).toBe("givenUp");
    await until(() => disabled.length === 1);
    expect(disabled).toEqual([{ tenantId: A, endpointId: id }]);
    // Once disabled, nothing more is sent.
    const sent = received.length;
    await delivery.relay(created(A));
    await Bun.sleep(150);
    expect(received.length).toBe(sent);
  });

  test("each attempt is logged: a 500 then a 200, with its status, rank and no body", async () => {
    const { endpoint } = await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const id = endpoint._id.toHexString();
    statuses = [500, 200];
    const delivery = makeDelivery(["10ms"]);
    const event = created(A);
    await delivery.relay(event);
    await until(async () => (await endpoints.listAttempts(A, id)).length === 2);
    const [second, first] = await endpoints.listAttempts(A, id);
    expect(first).toMatchObject({
      attempt: 1,
      status: 500,
      delivered: false,
      willRetry: true,
      eventId: event.event.id,
      type: "user.created",
    });
    expect(second).toMatchObject({
      attempt: 2,
      status: 200,
      delivered: true,
      willRetry: false,
    });
    expect(second?.durationMs).toBeGreaterThanOrEqual(0);
    const stored = JSON.stringify(
      await mongo.db.webhookDeliveries.raw.find({}).toArray(),
    );
    expect(stored).not.toContain("hooks.example.com");
    expect(await endpoints.listAttempts(B, id)).toEqual([]);
  });

  test("a failed log write never stops the delivery", async () => {
    await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const broken = Object.create(endpoints) as WebhooksService;
    broken.recordAttempt = async () => {
      throw new Error("down");
    };
    const delivery = createWebhookDelivery({
      webhooks: broken,
      fetch: guardedFetch(policy, receiver),
      queue: createMemoryWebhookQueue(),
      retries: [],
      poll: "10ms" as never,
      onDisabled: async () => {},
      log: () => {},
    });
    deliveries.push(delivery);
    await delivery.relay(created(A));
    await until(() => received.length === 1);
  });

  test("a delivered attempt ends the run of given-up deliveries", async () => {
    const { endpoint } = await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const id = endpoint._id.toHexString();
    const delivery = makeDelivery([]);
    statuses = [500, 500];
    await delivery.relay(created(A));
    await delivery.relay(created(A));
    await until(
      async () =>
        (await endpoints.findEndpoint(A, id))?.consecutiveGiveUps === 2,
    );
    await delivery.relay(created(A));
    await until(
      async () =>
        (await endpoints.findEndpoint(A, id))?.consecutiveGiveUps === 0,
    );
    expect((await endpoints.findEndpoint(A, id))?.enabled).toBe(true);
  });

  test("a private address is refused at send time (DNS rebinding)", async () => {
    const rebinding: UrlPolicy = {
      allowPrivate: false,
      resolve: async () => ["10.0.0.7"],
    };
    await endpoints.createEndpoint(
      A,
      { url: "https://hooks.example.com/in" },
      2,
    );
    const delivery = createWebhookDelivery({
      webhooks: endpoints,
      fetch: guardedFetch(rebinding, receiver),
      queue: createMemoryWebhookQueue(),
      retries: [],
      poll: "10ms" as never,
      onDisabled: async () => {},
      log: () => {},
    });
    deliveries.push(delivery);
    await delivery.relay(created(A));
    await Bun.sleep(200);
    expect(received).toEqual([]);
  });
});
