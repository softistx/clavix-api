import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mintToken } from "@/modules/domains";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { mongo } from "./db";
import { serveWebauthnOrigins, tlsAskOver } from "./domains-routes";
import { env } from "./env";
import { tenantsService } from "./tenancy";

const SECRET = "r".repeat(40);
const ask = tlsAskOver(SECRET);
const D = env.CLAVIX_DOMAIN;

const askFor = async (domain: string, extra: Record<string, string> = {}) =>
  (
    await ask(
      new Request(
        `http://127.0.0.1/internal/tls/ask?token=${SECRET}&domain=${domain}`,
        { headers: extra },
      ),
    )
  ).status;

const wellKnown = (host: string, method = "GET") =>
  serveWebauthnOrigins(
    new Request(`http://${host}/.well-known/webauthn`, { method }),
  );

let live: ObjectId;
let suspended: ObjectId;

const claim = (
  tenantId: ObjectId,
  host: string,
  status: "pending" | "verified" | "unverified",
) =>
  mongo.db.domains.create({
    tenantId,
    host,
    status,
    txtToken: mintToken(),
    primary: false,
  });

beforeAll(async () => {
  live = new ObjectId(
    (await tenantsService.create({ slug: "rt-live", name: "L" })).id,
  );
  suspended = new ObjectId(
    (await tenantsService.create({ slug: "rt-susp", name: "S" })).id,
  );
  await mongo.db.tenants.raw.updateOne(
    { _id: suspended },
    { $set: { status: "suspended" } },
  );
  await claim(live, "ok.live-example.com", "verified");
  await claim(live, "second.live-example.com", "verified");
  await claim(live, "pending.live-example.com", "pending");
  await claim(live, "lapsed.live-example.com", "unverified");
  await claim(suspended, "ok.susp-example.com", "verified");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.domains.raw.deleteMany({});
});

describe("serveTlsAsk over the real stores", () => {
  test("200 only for a verified domain of a live tenant", async () => {
    expect(await askFor("ok.live-example.com")).toBe(200);
    expect(await askFor("pending.live-example.com")).toBe(404);
    expect(await askFor("lapsed.live-example.com")).toBe(404);
    expect(await askFor("ok.susp-example.com")).toBe(404);
    expect(await askFor("nobody.example.com")).toBe(404);
  });

  test("the platform hosts: apex, console, a live tenant's slug host", async () => {
    expect(await askFor(D)).toBe(200);
    expect(await askFor(`console.${D}`)).toBe(200);
    expect(await askFor(`rt-live.${D}`)).toBe(200);
    expect(await askFor(`rt-susp.${D}`)).toBe(404);
    expect(await askFor(`ghost.${D}`)).toBe(404);
  });

  test("a proxied request is refused, whatever the header", async () => {
    for (const header of [
      "x-forwarded-for",
      "x-real-ip",
      "x-forwarded-proto",
    ]) {
      expect(await askFor("ok.live-example.com", { [header]: "1.2.3.4" })).toBe(
        404,
      );
    }
  });

  test("no secret configured: 404 for everyone", async () => {
    const closed = tlsAskOver(undefined);
    const res = await closed(
      new Request(
        `http://127.0.0.1/internal/tls/ask?token=${SECRET}&domain=ok.live-example.com`,
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe("serveWebauthnOrigins", () => {
  const scheme = env.CLAVIX_PUBLIC_SCHEME;
  const port =
    env.CLAVIX_PUBLIC_PORT === undefined ? "" : `:${env.CLAVIX_PUBLIC_PORT}`;

  test("a live tenant's slug host lists its verified domains only", async () => {
    const res = await wellKnown(`rt-live.${D}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { origins: string[] };
    expect(body.origins.sort()).toEqual(
      [
        `${scheme}://ok.live-example.com${port}`,
        `${scheme}://second.live-example.com${port}`,
      ].sort(),
    );
  });

  test("404 on a custom host, a suspended tenant, an unknown host or a POST", async () => {
    expect((await wellKnown("ok.live-example.com")).status).toBe(404);
    expect((await wellKnown(`rt-susp.${D}`)).status).toBe(404);
    expect((await wellKnown(`ghost.${D}`)).status).toBe(404);
    expect((await wellKnown(`rt-live.${D}`, "POST")).status).toBe(404);
  });
});
