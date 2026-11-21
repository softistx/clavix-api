import { beforeAll, describe, expect, test } from "bun:test";
import { DEVICE_GRANT } from "@softistx/janus-oauth";
import { authEventsService } from "@/config/audit";
import { mongo } from "@/config/db";
import { eventBus } from "@/config/events";
import { oauthDb } from "@/config/oauth-db";
import { oauthListener } from "@/events/oauth-listener";
import { registerClient } from "@/modules/clients";
import { createFlow, REDIRECT } from "~/oauth-flow";

// D14: the OAuth events of a tenant's issuer reach that tenant's sign-in log
// through the real bus and recorder, and no other tenant's.
const flow = createFlow({
  eventsFor: (tenant) =>
    oauthListener(tenant.tenantId, tenant.issuer, eventBus),
});
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const ids: Record<string, string> = {};

const logOf = async (slug: string) =>
  (
    await authEventsService.page(
      ids[slug] as string,
      {},
      { after: null, limit: 100 },
    )
  ).items;

const serverOf = async (slug: string) => {
  const server = await flow.issuers.serverFor(new Request(flow.url(slug, "/")));
  if (server === null) throw new Error("no server");
  return server;
};

beforeAll(async () => {
  for (const slug of ["oev-a", "oev-b"]) {
    ids[slug] = (await flow.setUp(slug)).tenantId;
  }
  await registerClient(
    { now: () => new Date(), db: oauthDb, findTenant },
    {
      tenant: "oev-a",
      name: "TV",
      clientId: "tv",
      redirectUris: [],
      grants: [DEVICE_GRANT],
    },
  );
});

describe("OAuth events in the sign-in log", () => {
  test("a consent and its revocation are recorded with the client and the user", async () => {
    await flow.tokensOf("oev-a", "openid", { userId: "ada" });
    const server = await serverOf("oev-a");
    await server.grants.revokeAll({ id: "ada" });
    const log = await logOf("oev-a");
    const granted = log.find((e) => e.type === "consent.granted");
    expect(granted).toMatchObject({
      outcome: "success",
      userId: "ada",
      clientId: "backend",
      ip: null,
    });
    expect(log.find((e) => e.type === "grant.revoked")).toMatchObject({
      reason: "user.all",
      userId: "ada",
    });
  });

  test("device decisions are recorded, approved and denied", async () => {
    const server = await serverOf("oev-a");
    for (const decision of ["approve", "deny"] as const) {
      const response = await flow.post("oev-a", "/device_authorization", {
        client_id: "tv",
        scope: "openid",
      });
      const { user_code } = (await response.json()) as { user_code: string };
      if (decision === "approve") {
        await server.approveDevice({ id: "ada" }, user_code, {
          scopes: ["openid"],
          authTime: new Date(),
        });
      } else {
        await server.denyDevice(user_code);
      }
    }
    const log = await logOf("oev-a");
    expect(log.find((e) => e.type === "device.approved")).toMatchObject({
      outcome: "success",
      clientId: "tv",
      userId: "ada",
    });
    expect(log.find((e) => e.type === "device.denied")).toMatchObject({
      outcome: "failure",
      clientId: "tv",
    });
  });

  test("a client registration is recorded", async () => {
    const server = await serverOf("oev-a");
    await server.createClient({
      clientId: "late",
      name: "Late",
      redirectUris: [REDIRECT],
      type: "public",
    } as never);
    expect((await logOf("oev-a")).map((e) => e.type)).toContain(
      "client.registered",
    );
  });

  test("another tenant's issuer never writes into this tenant's log", async () => {
    expect(await logOf("oev-b")).toEqual([]);
    await flow.tokensOf("oev-b", "openid", { userId: "bob" });
    expect((await logOf("oev-a")).filter((e) => e.userId === "bob")).toEqual(
      [],
    );
    expect((await logOf("oev-b")).map((e) => e.type)).toContain(
      "consent.granted",
    );
  });
});
