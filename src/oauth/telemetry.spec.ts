import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Exporter, Signal } from "@softistx/telemetry";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { buildTelemetry } from "@/telemetry/build";
import { jsonOf, tokenBody } from "~/json";
import { defined } from "~/narrow";
import { createFlow } from "~/oauth-flow";

// D24: every issuer's server is traced; the attributes never hold a token,
// a code, a secret or an address.
const flow = createFlow();
const signals: Signal[] = [];
const exporter: Exporter = {
  export: (_resource, batch) => void signals.push(...batch),
};
const telemetry = buildTelemetry({
  version: "test",
  production: false,
  exporters: [exporter],
});
let tenantId = "";

beforeAll(async () => {
  tenantId = (await flow.setUp("otel-a")).tenantId;
  telemetry.install();
});

afterAll(async () => {
  await telemetry.close();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of ["partitionedUsers", "partitionedTokens"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

test("a token request is a span with its client, grant and tenant, and no secret", async () => {
  const client = defined(flow.clients["otel-a"], "the otel-a client");
  const { body } = await flow.authorizeCode("otel-a", "openid");
  const response = await flow.post(
    "otel-a",
    "/token",
    body,
    flow.basic(client.id, client.secret),
  );
  expect(response.status).toBe(200);
  const tokens = await jsonOf(response, tokenBody);
  await telemetry.flush();

  const span = signals.find(
    (signal) => signal.type === "span" && signal.name === "oauth.token",
  );
  expect(span?.attributes).toMatchObject({
    "oauth.client.id": "backend",
    "oauth.grant_type": "authorization_code",
    "clavix.tenant.id": tenantId,
    "clavix.tenant.plan": "free",
  });
  const written = JSON.stringify(signals);
  for (const secret of [client.secret, body.code, tokens.access_token]) {
    expect(written).not.toContain(secret);
  }
});

test("a refused client authentication is a warning inside the token span", async () => {
  signals.length = 0;
  const response = await flow.post(
    "otel-a",
    "/token",
    { grant_type: "refresh_token", refresh_token: "rt-unused" },
    flow.basic("backend", "not-the-secret"),
  );
  expect(response.status).toBe(401);
  await telemetry.flush();
  const span = signals.find(
    (signal) => signal.type === "span" && signal.name === "oauth.token",
  );
  expect(span?.attributes["oauth.error"]).toBe("invalid_client");
  const warning = signals.find(
    (signal) => signal.type === "log" && signal.name === "oauth.client.refused",
  );
  expect(warning).toMatchObject({ type: "log", severity: "warn" });
  expect(JSON.stringify(signals)).not.toContain("not-the-secret");
});
