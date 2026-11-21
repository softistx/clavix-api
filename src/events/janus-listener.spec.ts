import { describe, expect, test } from "bun:test";
import { mintId, type UserEvent } from "@softistx/janus";
import type { EventBus } from "./bus";
import { janusListener } from "./janus-listener";
import type { ClavixEvent } from "./types";

const TENANT = "b".repeat(24);
const at = new Date("2026-11-01T10:00:00Z");
const USER = mintId(at.getTime());

/** The auth events of a janus event; every janus event also reaches the webhooks. */
async function run(type: UserEvent["type"]) {
  const all = await runAll(type);
  return all.filter((event) => event.kind === "auth");
}

async function runAll(type: UserEvent["type"]) {
  const emitted: ClavixEvent[] = [];
  const bus: Pick<EventBus, "emit"> = {
    emit: async (event) => {
      emitted.push(event);
    },
  };
  await janusListener(
    TENANT,
    bus,
  )({
    id: mintId(at.getTime()),
    type,
    userId: USER,
    userType: "user",
    occurredAt: at,
  });
  return emitted;
}

describe("janusListener", () => {
  test("a second-factor change becomes an auth event of the tenant", async () => {
    expect(await run("user.secondFactorEnabled")).toEqual([
      {
        kind: "auth",
        tenantId: TENANT,
        type: "secondFactor.enabled",
        outcome: "success",
        userId: USER,
        at,
      },
    ]);
  });

  test("a suspected passkey clone is a failure with its reason", async () => {
    const [event] = await run("user.passkeyCloneSuspected");
    expect(event).toMatchObject({
      type: "passkey.cloneSuspected",
      outcome: "failure",
      reason: "counterRegression",
    });
  });

  test("an event that is no access event is ignored", async () => {
    expect(await run("user.created")).toEqual([]);
  });

  test("every janus event is also emitted for the webhooks, with ids only", async () => {
    const all = await runAll("user.created");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "webhook",
      tenantId: TENANT,
      event: {
        type: "user.created",
        occurredAt: at,
        data: { tenantId: TENANT, userId: USER },
      },
    });
  });
});
