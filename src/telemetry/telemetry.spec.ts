import { afterAll, beforeAll, expect, test } from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import type { Exporter, Signal } from "@softistx/telemetry";
import { createApp } from "@/app";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { settled } from "@/modules/auth";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { buildTelemetry } from "./build";
import { parseOtlpHeaders } from "./otlp-headers";

const EMAIL = "grace@example.test";
const memory = mailer as MemoryMailer;
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const service = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});

const collector = () => {
  const signals: Signal[] = [];
  const exporter: Exporter = {
    export: (_resource, batch) => void signals.push(...batch),
  };
  return { signals, exporter };
};

let tenantId = "";

beforeAll(async () => {
  await service.create({ slug: "tele", name: "Tele", signUp: true });
  tenantId =
    (await tenantResolver.resolveHost(`tele.${env.CLAVIX_DOMAIN}`))?.tenantId ??
    "";
});

afterAll(async () => {
  await settled();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  for (const name of ["partitionedUsers", "partitionedTokens"]) {
    await oauthDb.collection(name).deleteMany({});
  }
});

test("a sign-in request is traced with its tenant and no e-mail or address", async () => {
  const { signals, exporter } = collector();
  const telemetry = buildTelemetry({
    version: "test",
    production: false,
    exporters: [exporter],
  });
  const app = createApp({ telemetry });
  const response = await app.request(`${issuerOf("tele", origin)}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
    },
    body: JSON.stringify({
      query: `mutation ($email: EmailAddress!) { requestSignInCode(email: $email) { challenge } }`,
      variables: { email: EMAIL },
    }),
  });
  expect(response.status).toBe(200);
  // The server span ends once the body has been read.
  await response.text();
  await settled();
  await telemetry.close();

  const spans = signals.filter((signal) => signal.type === "span");
  const server = spans.find((span) => span.kind === "server");
  expect(server?.attributes["clavix.tenant.id"]).toBe(tenantId);
  expect(server?.attributes["clavix.tenant.plan"]).toBe("free");
  const janusSpan = spans.find((span) => span.name.startsWith("janus."));
  expect(janusSpan?.attributes["clavix.tenant.id"]).toBe(tenantId);
  // The mail went out, and neither the address nor the caller's IP is in any signal.
  expect(memory.sent.some((m) => JSON.stringify(m.to).includes(EMAIL))).toBe(
    true,
  );
  const written = JSON.stringify(signals);
  expect(written).not.toContain(EMAIL);
  expect(written).not.toContain("203.0.113.9");
  // No span or log carries the attribute at all (`clientAddress: false`, D24).
  expect(signals.some((signal) => "client.address" in signal.attributes)).toBe(
    false,
  );
});

test("probes are not traced and read no tenant", async () => {
  const { signals, exporter } = collector();
  const telemetry = buildTelemetry({
    version: "test",
    production: false,
    exporters: [exporter],
  });
  const app = createApp({ telemetry });
  expect((await app.request("/healthz")).status).toBe(200);
  await telemetry.close();
  expect(signals).toEqual([]);
});

test("with no endpoint set there is no exporter, and requests still answer", async () => {
  const telemetry = buildTelemetry({ version: "test", production: false });
  const app = createApp({ telemetry });
  const response = await app.request(`${issuerOf("tele", origin)}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ health { status } }" }),
  });
  expect(response.status).toBe(200);
  await telemetry.close();
});

test("OTLP headers are key=value pairs, a value may hold =", () => {
  expect(parseOtlpHeaders("x-api-key=abc==, team = core ,bad,=no")).toEqual({
    "x-api-key": "abc==",
    team: "core",
  });
  expect(parseOtlpHeaders(undefined)).toEqual({});
});
