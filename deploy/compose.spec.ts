import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOY_DIR } from "./lib";

// A text check of the traefik overlay: what traefik would be told, and what the
// staging stack must never lose. `docker compose config` is the full check.
const overlay = readFileSync(join(DEPLOY_DIR, "compose.traefik.yml"), "utf8");
// The overlay without its comments, which name the real domain and paths.
const code = overlay
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
const base = readFileSync(join(DEPLOY_DIR, "compose.yml"), "utf8");

// A compose interpolation, written so the linter does not take it for a JS template.
const v = (name: string) => `$\u007b${name}}`;

describe("compose.traefik.yml", () => {
  test("asks for the two-level wildcard on the letsencrypt resolver", () => {
    expect(overlay).toContain("tls.certresolver: letsencrypt");
    expect(overlay).toContain(`tls.domains[0].main: ${v("CLAVIX_DOMAIN")}`);
    expect(overlay).toContain(`tls.domains[0].sans: "*.${v("CLAVIX_DOMAIN")}"`);
  });

  test("routes the apex and the tenant hosts, from the env, never a fixed domain", () => {
    expect(overlay).toContain(`Host(\`${v("CLAVIX_DOMAIN")}\`)`);
    expect(overlay).toContain(
      `HostRegexp(\`${v("CLAVIX_DOMAIN_RE")}`.slice(0, -1),
    );
    expect(code).not.toMatch(/softistx\.com/);
  });

  test("joins the external proxy network and does not start caddy", () => {
    expect(overlay).toMatch(/networks:\n {2}proxy:\n {4}external: true/);
    expect(overlay).toMatch(/caddy:\n {4}profiles: \["standalone"\]/);
  });

  test("gives the api the routes caddy gave it and keeps /internal and /readyz out", () => {
    for (const path of [
      "/token",
      "/jwks.json",
      "/console/graphql",
      "/console/audit/export",
      "/healthz",
      "/.well-known/openid-configuration",
    ])
      expect(overlay).toContain(`Path(\`${path}\`)`);
    expect(code).not.toContain("/internal");
    expect(code).not.toContain("/readyz");
  });
});

describe("compose.yml", () => {
  test("every service sets deploy.resources.limits", () => {
    const services =
      base.split(/\nservices:\n/)[1]?.split(/\n(?:secrets|volumes):\n/)[0] ??
      "";
    const blocks = services
      .split(/\n {2}(?=[a-z][a-z-]*:\n)/)
      .filter((b) => b.trim());
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const block of blocks) expect(block).toContain("limits:");
  });
});
