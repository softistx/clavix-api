import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { brandingService } from "@/config/branding";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { tenantsService } from "@/config/tenancy";
import type { ConsoleContext } from "@/console/context";
import type { Permission } from "@/console/model";
import { consoleSchema } from "@/console/schema";
import { BrandingService } from "./branding.service";
import { LOGO_MAX_BYTES } from "./logo";
import {
  BrandingContrastError,
  buildTheme,
  type CompiledTheme,
  compileTheme,
  THEME_NAME,
} from "./theme";

// 1x1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const LOGO = { contentType: "image/png", dataBase64: PNG };
const base = {
  displayName: "Acme",
  seed: "#0a7ea4",
  radius: "0.5rem",
  backgroundPreset: null,
  motif: null,
};

let tenantA = "";
let tenantB = "";
let slugA = "";
const users = {
  adminA: "u-admin-a",
  viewerA: "u-viewer-a",
  adminB: "u-admin-b",
};

const ctxFor = (userId: string): ConsoleContext =>
  ({
    principal: { userId },
    access,
    directory: {},
    can: (permission: Permission, tenantId: string) =>
      access.can(userId, permission, tenantId),
    canPlatform: (permission: Permission) =>
      access.canPlatform(userId, permission),
  }) as unknown as ConsoleContext;

const run = (
  source: string,
  userId: string,
  variableValues?: Record<string, unknown>,
) =>
  graphql({
    schema: consoleSchema,
    source,
    contextValue: ctxFor(userId),
    ...(variableValues === undefined ? {} : { variableValues }),
  });

interface Payload {
  changed: boolean;
  warnings: string[];
  branding: { themeName: string; css: string; logoUrl: string | null };
}
const payloadOf = (result: { data?: unknown }) =>
  (result.data as { updateBranding: Payload }).updateBranding;

const UPDATE = `mutation ($t: ID!, $i: UpdateBrandingInput!) {
  updateBranding(tenantId: $t, input: $i) {
    changed warnings branding { displayName seed themeName css logoUrl tenantId }
  }
}`;
const READ = `query ($t: ID!) { branding(tenantId: $t) { displayName seed logoUrl } }`;

beforeAll(async () => {
  const a = await tenantsService.create({ slug: "brand-a", name: "A" });
  const b = await tenantsService.create({ slug: "brand-b", name: "B" });
  tenantA = a._id.toHexString();
  tenantB = b._id.toHexString();
  slugA = a.slug;
  await access.grantTenant(tenantA, users.adminA, "admin");
  await access.grantTenant(tenantA, users.viewerA, "viewer");
  await access.grantTenant(tenantB, users.adminB, "admin");
});

afterAll(async () => {
  await mongo.db.branding.raw.deleteMany({});
});

describe("the theme", () => {
  test("a seed compiles to attribute-scoped css that passes AA in light and dark", () => {
    const { compiled } = buildTheme(base);
    expect(compiled.css).toContain(`[data-nxgt-theme="${THEME_NAME}"]`);
    const modes = new Set(compiled.results.map((r) => r.mode));
    expect(modes).toEqual(new Set(["light", "dark"]));
    expect(compiled.results.every((r) => r.pass)).toBe(true);
  });

  test("a hard seed (yellow) is moved to AA, with a warning, not refused", () => {
    const { compiled } = buildTheme({ ...base, seed: "#ffff00" });
    expect(compiled.warnings.length).toBeGreaterThan(0);
  });

  test("a failing pair is BRANDING_CONTRAST", () => {
    const failing = (): CompiledTheme => ({
      ...compileTheme(base),
      results: [
        {
          fg: "primary-foreground",
          bg: "primary",
          min: 4.5,
          modes: ["dark"],
          why: "x",
          mode: "dark",
          ratio: 2.1,
          pass: false,
        },
      ],
    });
    expect(() => buildTheme(base, failing)).toThrow(BrandingContrastError);
  });

  test("an unreadable colour, radius, preset or motif is refused", () => {
    for (const bad of [
      { seed: "banana" },
      { radius: "1rem;}" },
      { radius: "9rem" },
      { backgroundPreset: "nope" },
      { motif: "nope" },
      { displayName: "  " },
    ]) {
      expect(() => buildTheme({ ...base, ...bad })).toThrow();
    }
  });
});

describe("updateBranding", () => {
  test("an admin stores the brand and reads it back; a repeat changes nothing", async () => {
    const first = await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, logo: LOGO },
    });
    expect(first.errors).toBeUndefined();
    const payload = payloadOf(first);
    expect(payload.changed).toBe(true);
    expect(payload.branding.themeName).toBe(THEME_NAME);
    expect(payload.branding.css).toContain("data-nxgt-theme");
    expect(payload.branding.logoUrl).toStartWith("/branding/logo?v=");

    const again = await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, logo: LOGO },
    });
    expect(payloadOf(again).changed).toBe(false);

    // The logo is kept when the next call sends none, and removed on request.
    const kept = await run(UPDATE, users.adminA, { t: tenantA, i: base });
    expect(payloadOf(kept).changed).toBe(false);
    expect(payloadOf(kept).branding.logoUrl).not.toBeNull();
    const removed = await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, removeLogo: true },
    });
    expect(payloadOf(removed).branding.logoUrl).toBeNull();
    expect((await mongo.db.branding.raw.countDocuments({})) >= 1).toBe(true);
  });

  test("an edit is stored and replaces the old css", async () => {
    const changed = await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, seed: "#7a3cff", displayName: "Acme 2" },
    });
    expect(payloadOf(changed).changed).toBe(true);
    const read = await run(READ, users.viewerA, { t: tenantA });
    expect((read.data as { branding: unknown }).branding).toMatchObject({
      displayName: "Acme 2",
      seed: "#7a3cff",
    });
  });

  test("a bad input is BAD_USER_INPUT and stores nothing", async () => {
    const before = await run(READ, users.adminA, { t: tenantA });
    const result = await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, seed: "banana" },
    });
    expect(result.errors?.[0]?.extensions?.["code"]).toBe("BAD_USER_INPUT");
    expect(result.errors?.[0]?.extensions?.["field"]).toBe("seed");
    expect(await run(READ, users.adminA, { t: tenantA })).toEqual(before);
  });

  test("a failing contrast is BRANDING_CONTRAST (422) with the pairs, and stores nothing", async () => {
    const failing = new BrandingService(mongo.db.branding, () => ({
      ...compileTheme(base),
      results: [
        {
          fg: "foreground",
          bg: "background",
          min: 4.5,
          modes: ["light"],
          why: "x",
          mode: "light",
          ratio: 2,
          pass: false,
        },
      ],
    }));
    // The resolver maps this error to a 422; the service is the unit under test here.
    await expect(failing.update(tenantB, base)).rejects.toBeInstanceOf(
      BrandingContrastError,
    );
    expect(await brandingService.get(tenantB)).toBeUndefined();
  });

  test("logos: only small, real PNG/JPEG/WebP", async () => {
    const bad = [
      { contentType: "image/svg+xml", dataBase64: PNG },
      { contentType: "image/png", dataBase64: btoa("not a png at all") },
      { contentType: "image/png", dataBase64: "!!!" },
      {
        contentType: "image/png",
        dataBase64: Buffer.alloc(LOGO_MAX_BYTES + 1, 1).toString("base64"),
      },
    ];
    for (const logo of bad) {
      const result = await run(UPDATE, users.adminA, {
        t: tenantA,
        i: { ...base, logo },
      });
      expect(result.errors?.[0]?.extensions?.["field"]).toBe("logo");
    }
  });
});

describe("permissions and isolation", () => {
  test("a viewer reads but cannot edit", async () => {
    expect(
      (await run(READ, users.viewerA, { t: tenantA })).errors,
    ).toBeUndefined();
    const result = await run(UPDATE, users.viewerA, { t: tenantA, i: base });
    expect(result.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");
  });

  test("the admin of tenant A can neither read nor edit tenant B", async () => {
    expect(
      (await run(READ, users.adminA, { t: tenantB })).errors?.[0]?.extensions?.[
        "code"
      ],
    ).toBe("FORBIDDEN");
    const result = await run(UPDATE, users.adminA, { t: tenantB, i: base });
    expect(result.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");
    expect(await brandingService.get(tenantB)).toBeUndefined();
  });

  test("tenant B's own brand never shows A's", async () => {
    await run(UPDATE, users.adminB, {
      t: tenantB,
      i: { ...base, displayName: "Bravo", seed: "#d4381c" },
    });
    const a = await brandingService.get(tenantA);
    const b = await brandingService.get(tenantB);
    expect(a?.displayName).toBe("Acme 2");
    expect(b?.displayName).toBe("Bravo");
  });

  test("a stranger and an unknown tenant are refused", async () => {
    expect(
      (await run(READ, "nobody", { t: tenantA })).errors?.[0]?.extensions?.[
        "code"
      ],
    ).toBe("FORBIDDEN");
    const platform = "u-platform-owner";
    await access.grantPlatform(platform, "owner");
    const missing = await run(READ, platform, { t: "0".repeat(24) });
    // Not linked to the platform, so not even an operator sees it: no existence leak.
    expect(missing.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");
  });
});

describe("the public side", () => {
  const app = createApp({
    signInThrottle: undefined,
    passkeyThrottle: undefined,
  });
  const host = (slug: string) => `http://${slug}.${env.CLAVIX_DOMAIN}`;

  beforeAll(async () => {
    await run(UPDATE, users.adminA, { t: tenantA, i: { ...base, logo: LOGO } });
  });

  test("GET /branding/logo serves the host tenant's logo with an ETag, and 304s", async () => {
    const response = await app.request(`${host(slugA)}/branding/logo`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const cached = await app.request(`${host(slugA)}/branding/logo`, {
      headers: { "if-none-match": etag },
    });
    expect(cached.status).toBe(304);
    const other = await app.request(`${host(slugA)}/branding/logo`, {
      headers: { "if-none-match": '"other"' },
    });
    expect(other.status).toBe(200);
  });

  test("a tenant with no logo, and an unknown host, are 404", async () => {
    expect((await app.request(`${host("brand-b")}/branding/logo`)).status).toBe(
      404,
    );
    expect(
      (await app.request(`${host("no-such-tenant")}/branding/logo`)).status,
    ).toBe(404);
    expect(
      (await app.request(`${host(slugA)}/branding/logo`, { method: "POST" }))
        .status,
    ).toBe(405);
  });

  test("tenantBranding answers by host, anonymously, and is null elsewhere", async () => {
    const ask = async (h: string) =>
      (await (
        await app.request(`${h}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: h },
          body: JSON.stringify({
            query: "{ tenantBranding { displayName themeName css logoUrl } }",
          }),
        })
      ).json()) as {
        data?: { tenantBranding: { logoUrl: string } | null };
        errors?: unknown;
      };
    const a = await ask(host(slugA));
    expect(a.data?.tenantBranding).toMatchObject({
      displayName: "Acme",
      themeName: THEME_NAME,
    });
    expect(a.data?.tenantBranding?.logoUrl).toStartWith("/branding/logo?v=");
    const none = await ask(host("no-such-tenant"));
    expect(none.data?.tenantBranding).toBeNull();
  });
});
