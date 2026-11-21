import { afterEach, describe, expect, test } from "bun:test";
import type { UserEvent } from "@softistx/janus";
import {
  createMemoryWebhookQueue,
  mintWebhookSecret,
} from "@softistx/janus-webhooks";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { createSecretBox } from "@/modules/sign-in-methods/secrets";
import {
  createWebhookDelivery,
  endpointIdOf,
  queueEndpointId,
  webhookGroupOf,
  webhookQueueLimits,
} from "./webhooks.delivery";
import { userWebhookEvent } from "./webhooks.events";
import { WebhooksService } from "./webhooks.service";
import { guardedFetch, type UrlPolicy } from "./webhooks.url-policy";

// Tenant FLOOD's receiver never answers until it is released: its requests stay
// in flight. Tenant CALM's receiver answers at once. The queue's caps are the
// real ones (`webhookQueueLimits`), with small numbers.
const FLOOD = new ObjectId().toHexString();
const CALM = new ObjectId().toHexString();
const policy: UrlPolicy = {
  allowPrivate: false,
  resolve: async () => ["93.184.216.34"],
};
const endpoints = new WebhooksService(
  mongo.db.webhookEndpoints,
  mongo.db.webhookDeliveries,
  createSecretBox(
    crypto.getRandomValues(new Uint8Array(32)),
    "webhook-secrets",
  ),
  { policy, now: () => new Date(), mint: mintWebhookSecret, log: () => {} },
);

let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let inFlight = 0;
let peak = 0;
let calmReceived = 0;
const receiver = (async (input: RequestInfo | URL) => {
  if (String(input).includes("flood")) {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await gate;
    inFlight--;
  } else calmReceived++;
  return new Response("", { status: 200 });
}) as unknown as typeof fetch;

const open: ReturnType<typeof createWebhookDelivery>[] = [];
const refused: string[] = [];
const makeDelivery = (caps: { maxInFlight: number; maxPending: number }) => {
  const delivery = createWebhookDelivery({
    webhooks: endpoints,
    fetch: guardedFetch(policy, receiver),
    queue: createMemoryWebhookQueue(
      webhookQueueLimits(caps, (line) => refused.push(line)),
    ),
    retries: [],
    poll: "10ms" as never,
    onDisabled: async () => {},
    log: () => {},
  });
  open.push(delivery);
  return delivery;
};

afterEach(async () => {
  release();
  for (const delivery of open.splice(0)) await delivery.close();
  refused.length = 0;
  inFlight = 0;
  peak = 0;
  calmReceived = 0;
  await mongo.db.webhookEndpoints.raw.deleteMany({});
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (done()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
};

const created = (tenantId: string) =>
  ({
    kind: "webhook",
    tenantId,
    event: userWebhookEvent(tenantId, {
      id: crypto.randomUUID(),
      type: "user.created",
      userId: "u1",
      userType: "customer",
      occurredAt: new Date(),
    } as unknown as UserEvent),
  }) as const;

const stall = () => {
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
};

describe("webhook queue caps (G2-03)", () => {
  test("one tenant flooding a stalled endpoint holds at most its cap and starves no other tenant", async () => {
    stall();
    await endpoints.createEndpoint(
      FLOOD,
      { url: "https://flood.example.com/in" },
      5,
    );
    await endpoints.createEndpoint(
      FLOOD,
      { url: "https://flood2.example.com/in" },
      5,
    );
    await endpoints.createEndpoint(
      CALM,
      { url: "https://calm.example.com/in" },
      5,
    );
    const delivery = makeDelivery({ maxInFlight: 2, maxPending: 1000 });
    for (let i = 0; i < 12; i++) await delivery.relay(created(FLOOD));
    await until(() => inFlight === 2);
    await delivery.relay(created(CALM));
    await until(() => calmReceived === 1);
    // The calm tenant was served while the flood still held its share, and
    // the flood never went past it, whatever its number of endpoints.
    expect(inFlight).toBe(2);
    expect(peak).toBe(2);
  });

  test("past maxPending the flooding tenant's deliveries are refused, the other tenant's are not", async () => {
    stall();
    await endpoints.createEndpoint(
      FLOOD,
      { url: "https://flood.example.com/in" },
      5,
    );
    await endpoints.createEndpoint(
      CALM,
      { url: "https://calm.example.com/in" },
      5,
    );
    const delivery = makeDelivery({ maxInFlight: 1, maxPending: 3 });
    for (let i = 0; i < 6; i++) await delivery.relay(created(FLOOD));
    await delivery.relay(created(CALM));
    await until(() => calmReceived === 1);
    expect(refused).toHaveLength(3);
    expect(refused.every((line) => line.includes(`tenant ${FLOOD}`))).toBe(
      true,
    );
    expect(refused.join("\n")).not.toContain(CALM);
  });
});

describe("the queue's endpoint name", () => {
  test("is <tenant>.<endpoint>: the group is the tenant and the endpoint id comes back out", () => {
    const endpoint = new ObjectId().toHexString();
    const name = queueEndpointId(FLOOD, endpoint);
    expect(webhookGroupOf(name)).toBe(FLOOD);
    expect(endpointIdOf(name)).toBe(endpoint);
    // A name queued before the prefix is its own group and its own id.
    expect(webhookGroupOf(endpoint)).toBe(endpoint);
    expect(endpointIdOf(endpoint)).toBe(endpoint);
  });
});
