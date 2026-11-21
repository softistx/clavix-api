import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineTheme } from "@softistx/material-core/theme";
import {
  type ExecutionResult,
  experimentalExecuteIncrementally,
  parse,
} from "graphql";
import { ObjectId } from "mongodb";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { adminEventRecorder } from "@/config/admin-events";
import { brandingService } from "@/config/branding";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { tenantsService } from "@/config/tenancy";
import type { AuditAction, AuditTarget } from "@/console/audit";
import type { ConsoleContext } from "@/console/context";
import type { Permission } from "@/console/model";
import { consoleSchema } from "@/console/schema";
import { clientHeaders } from "~/client-header";
import { BrandingConflictError } from "./branding.errors";
import { LOGO_MAX_BYTES } from "./branding.logo";
import { BrandingService } from "./branding.service";
import {
  assertSafeCss,
  BrandingContrastError,
  buildTheme,
  type CompileTheme,
  compileTheme,
  failuresOf,
  measureTheme,
  THEME_NAME,
  validateThemeInput,
} from "./branding.theme";

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

// A real theme the library cannot bring to AA: the label of the primary fill
// is overridden to the fill's own colour (the `tokens` escape hatch, which a
// brand's input never reaches).
const failingCompile: CompileTheme = (input) =>
  measureTheme(
    defineTheme({
      name: THEME_NAME,
      colors: { primary: input.seed },
      tokens: { light: { "primary-foreground": input.seed } },
    }),
  );

let tenantA = "";
let tenantB = "";
let tenantC = "";
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
    // Every id is an ordinary tenant (not `clavix`): the tenant-level guard decides.
    directory: {
      emailVerified: async () => true,
      tenantsByIds: async (ids: readonly string[]) =>
        ids.map((id) => ({ id, slug: `t-${id}`, name: id })),
    },
    can: (permission: Permission, tenantId: string) =>
      access.can(userId, permission, tenantId),
    canPlatform: (permission: Permission) =>
      access.canPlatform(userId, permission),
    audit: (action: AuditAction, target: AuditTarget) =>
      adminEventRecorder.record({
        actor: userId,
        action,
        tenantId: target.tenantId,
        target: { type: target.type, id: target.id },
        requestId: "branding-spec",
      }),
  }) as unknown as ConsoleContext;

const eventsOf = (tenantId: string) =>
  mongo.db.adminEvents.raw
    .find({ tenantId: new ObjectId(tenantId) })
    .sort({ _id: 1 })
    .toArray();

// graxia's schema declares @defer and @stream, which graphql's plain `execute`
// refuses: run it incrementally (a query without them answers one result).
const run = async (
  source: string,
  userId: string,
  variableValues?: Record<string, unknown>,
) =>
  (await experimentalExecuteIncrementally({
    schema: consoleSchema,
    document: parse(source),
    contextValue: ctxFor(userId),
    ...(variableValues === undefined ? {} : { variableValues }),
  })) as ExecutionResult;

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
  const c = await tenantsService.create({ slug: "brand-c", name: "C" });
  tenantC = c._id.toHexString();
  slugA = a.slug;
  await access.grantTenant(tenantA, users.adminA, "admin");
  await access.grantTenant(tenantA, users.viewerA, "viewer");
  await access.grantTenant(tenantB, users.adminB, "admin");
});

afterAll(async () => {
  await mongo.db.branding.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
});

describe("the unsafe-CSS guard", () => {
  test("refuses <, @import, url(, image-set(, src( and a backslash, any case, after comments are stripped", () => {
    for (const css of [
      "a{b:c}</style>",
      "@import 'x.css';",
      "@IMPORT url(x)",
      "a{background:url(x)}",
      "a{background:URL(x)}",
      "a{background:image-set(x 1x)}",
      "a{background:SRC(x)}",
      "a{content:'\\41'}",
      "/* ok */ a{b:c} @import x",
    ]) {
      expect(() => assertSafeCss(css)).toThrow(
        expect.objectContaining({ code: "BAD_USER_INPUT", field: "css" }),
      );
    }
  });

  test("refuses < and a backslash even inside a comment", () => {
    for (const css of ["a{} /* </style><script> */", "a{} /* \\ */"]) {
      expect(() => assertSafeCss(css)).toThrow(
        expect.objectContaining({ code: "BAD_USER_INPUT", field: "css" }),
      );
    }
  });

  test("accepts the generated stylesheet and a comment that only holds the other tokens", () => {
    expect(() => assertSafeCss(buildTheme(base).compiled.css)).not.toThrow();
    expect(() => assertSafeCss("a{b:c} /* url( @import */")).not.toThrow();
  });

  test("a compiler that returns unsafe css is refused before anything is stored", () => {
    const unsafe: CompileTheme = (input) => ({
      ...compileTheme(input),
      css: "a{background:url(x)}",
    });
    expect(() => buildTheme(base, unsafe)).toThrow(
      expect.objectContaining({ code: "BAD_USER_INPUT", field: "css" }),
    );
  });
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

  test("a theme the library cannot bring to AA is BRANDING_CONTRAST, with the measured pair once", () => {
    const compiled = failingCompile(validateThemeInput(base));
    expect(compiled.unsolved.map((w) => w.code)).toEqual([
      "override-breaks-pair",
    ]);
    // The pair is measured and warned about: one failure, with its real ratio.
    const failures = failuresOf(compiled);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      foreground: "primary-foreground",
      background: "primary",
      mode: "light",
      minimum: 4.5,
    });
    expect(failures[0]?.ratio).toBeGreaterThan(0);
    expect(failures[0]?.ratio).toBeLessThan(4.5);
    expect(() => buildTheme(base, failingCompile)).toThrow(
      BrandingContrastError,
    );
  });

  test("a pair the generator gave up on fails even when no measure names it", () => {
    const unsolved: CompileTheme = (input) => ({
      ...compileTheme(input),
      unsolved: [
        { code: "unsolvable", token: "ring", mode: "dark", message: "x" },
        { code: "unsolvable", message: "y" },
      ],
    });
    const failures = failuresOf(unsolved(validateThemeInput(base)));
    expect(failures).toEqual([
      {
        foreground: "ring",
        background: "",
        mode: "dark",
        ratio: 0,
        minimum: 4.5,
      },
      {
        foreground: "unknown",
        background: "",
        mode: "light",
        ratio: 0,
        minimum: 4.5,
      },
    ]);
    expect(() => buildTheme(base, unsolved)).toThrow(BrandingContrastError);
  });

  test("a display name or a seed that would break out of the stylesheet never reaches the css", () => {
    const plain = buildTheme(base).compiled.css;
    for (const displayName of [
      '"]}</style><script>alert(1)</script>{',
      "x */ } body{display:none} /*",
      "\\3c /style>",
    ]) {
      // The name is a label, not CSS: the stylesheet is the same without it.
      expect(buildTheme({ ...base, displayName }).compiled.css).toBe(plain);
    }
    expect(plain).not.toContain("<");
    for (const seed of [
      "#0a7ea4;} body{display:none}",
      "#0a7ea4 */ body{display:none} /*",
      "red;}</style><script>alert(1)</script>",
      "oklch(0.5 0.1 200)}</style>",
      "url(javascript:alert(1))",
      "var(--x)",
      "rgb(1 2 3 / </style>)",
    ]) {
      expect(() => buildTheme({ ...base, seed })).toThrow(
        expect.objectContaining({ code: "BAD_USER_INPUT", field: "seed" }),
      );
    }
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
    const events = await eventsOf(tenantA);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: users.adminA,
      action: "branding.update",
      target: { type: "branding", id: tenantA },
    });

    const again = await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, logo: LOGO },
    });
    expect(payloadOf(again).changed).toBe(false);
    // A repeat is recorded too: the retry of a call whose record failed.
    expect(await eventsOf(tenantA)).toHaveLength(2);

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
    const failing = new BrandingService(mongo.db.branding, failingCompile);
    // The resolver maps this error to a 422; the service is the unit under test here.
    await expect(failing.update(tenantB, base)).rejects.toBeInstanceOf(
      BrandingContrastError,
    );
    expect(await brandingService.get(tenantB)).toBeUndefined();
  });

  test("a hostile display name is stored as text and leaves the css alone", async () => {
    const hostile = "</style><script>alert(1)</script>";
    const stored = await brandingService.update(tenantC, {
      ...base,
      displayName: hostile,
    });
    expect(stored.branding.displayName).toBe(hostile);
    expect(stored.branding.css).not.toContain("<");
    expect(stored.branding.css).not.toContain("alert");
  });

  test("concurrent updates apply one after the other: one document, no lost decision", async () => {
    const mine = { tenantId: new ObjectId(tenantC) };
    await mongo.db.branding.raw.deleteMany(mine);
    const seeds = ["#0a7ea4", "#7a3cff", "#d4381c"];
    const results = await Promise.all(
      seeds.map((seed) => brandingService.update(tenantC, { ...base, seed })),
    );
    expect(results.every((r) => r.changed)).toBe(true);
    const docs = await mongo.db.branding.raw.find(mine).toArray();
    expect(docs).toHaveLength(1);
    expect(seeds).toContain(String(docs[0]?.["seed"]));

    // A logo set while another call (sending none) is under way is kept.
    await Promise.all([
      brandingService.update(tenantC, { ...base, seed: "#0a7ea4", logo: LOGO }),
      brandingService.update(tenantC, { ...base, seed: "#7a3cff" }),
      brandingService.update(tenantC, { ...base, seed: "#d4381c" }),
    ]);
    expect((await brandingService.get(tenantC))?.logo).not.toBeNull();
    await mongo.db.branding.raw.deleteMany(mine);

    // A double submit of a first brand: one call stores it, the other finds it.
    const twice = await Promise.all([
      brandingService.update(tenantC, base),
      brandingService.update(tenantC, base),
    ]);
    expect(twice.map((r) => r.changed).sort()).toEqual([false, true]);
    expect(await mongo.db.branding.raw.countDocuments(mine)).toBe(1);

    // More writers than attempts: each call is stored or refused CONFLICT,
    // never an unexpected error, and the brand stays one whole document.
    const crowd = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        brandingService.update(tenantC, { ...base, displayName: `Crowd ${i}` }),
      ),
    );
    expect(crowd.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of crowd) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(BrandingConflictError);
      }
    }
    expect(await mongo.db.branding.raw.countDocuments(mine)).toBe(1);
    await mongo.db.branding.raw.deleteMany(mine);
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
    const before = (await eventsOf(tenantA)).length;
    const result = await run(UPDATE, users.viewerA, { t: tenantA, i: base });
    expect(result.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");
    // A refused mutation records no admin event.
    expect(await eventsOf(tenantA)).toHaveLength(before);
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
    await run(UPDATE, users.adminA, {
      t: tenantA,
      i: { ...base, logo: LOGO, backgroundPreset: "aurora", motif: "star" },
    });
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

    // Kept for good only under the URL that names this image.
    const revalidated = "public, max-age=300, must-revalidate";
    expect(response.headers.get("cache-control")).toBe(revalidated);
    const versioned = await app.request(
      `${host(slugA)}/branding/logo?v=${etag.slice(1, 17)}`,
    );
    expect(versioned.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const stale = await app.request(`${host(slugA)}/branding/logo?v=0000`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe(revalidated);
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
          headers: {
            ...clientHeaders,
            "content-type": "application/json",
            origin: h,
          },
          body: JSON.stringify({
            query:
              "{ tenantBranding { displayName themeName css logoUrl backgroundPreset motif } }",
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
      backgroundPreset: "aurora",
      motif: "star",
    });
    expect(a.data?.tenantBranding?.logoUrl).toStartWith("/branding/logo?v=");
    const none = await ask(host("no-such-tenant"));
    expect(none.data?.tenantBranding).toBeNull();
  });
});
