import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeEnv,
  DEPLOY_DIR,
  domainRegex,
  envFileProblem,
  envProblems,
  imageRepository,
  parseEnv,
  staleImageIds,
  uiContext,
} from "./lib";

const good = {
  CLAVIX_DOMAIN: "clavix.softistx.com",
  CLAVIX_API_IMAGE: "clavix-api:staging",
  CLAVIX_UI_IMAGE: "clavix-ui:staging",
  CLAVIX_KEYS_MASTER_KEY: "k",
  REDIS_PASSWORD: "r",
  MONGO_ROOT_PASSWORD: "m",
  MONGO_APP_PASSWORD: "a",
  MONGO_KEYFILE: "f",
  CONSOLE_SESSION_SECRET: "s",
};

describe("parseEnv", () => {
  test("skips comments and blanks, strips one pair of quotes", () => {
    expect(parseEnv("# c\n\nA=1\nB=\"two words\"\nC='x'\n")).toEqual({
      A: "1",
      B: "two words",
      C: "x",
    });
  });

  test("drops an inline comment of an unquoted value, keeps a # inside quotes", () => {
    expect(parseEnv('A=v # note\nB=a#b\nC="x # y" # n\n')).toEqual({
      A: "v",
      B: "a#b",
      C: "x # y",
    });
  });
});

describe("envFileProblem", () => {
  const dir = mkdtempSync(join(tmpdir(), "clavix-deploy-"));
  const file = join(dir, ".env");

  test("a missing file is refused", () => {
    expect(envFileProblem(file)).toContain("is missing");
  });

  test("a file others can read is refused, 600 and 400 pass", () => {
    writeFileSync(file, "A=1\n");
    chmodSync(file, 0o644);
    expect(envFileProblem(file)).toContain("mode 644");
    chmodSync(file, 0o600);
    expect(envFileProblem(file)).toBeUndefined();
    chmodSync(file, 0o400);
    expect(envFileProblem(file)).toBeUndefined();
  });
});

describe("envProblems", () => {
  test("a complete staging file has none", () => {
    expect(envProblems(good)).toEqual([]);
  });

  test("names each missing variable", () => {
    const { REDIS_PASSWORD: _r, MONGO_KEYFILE: _k, ...rest } = good;
    expect(envProblems(rest)).toEqual([
      "REDIS_PASSWORD is not set",
      "MONGO_KEYFILE is not set",
    ]);
  });

  test("refuses a domain with a scheme, a port or a wildcard", () => {
    for (const bad of [
      "https://clavix.softistx.com",
      "clavix.softistx.com:443",
      "*.softistx.com",
      "Clavix.softistx.com",
    ])
      expect(envProblems({ ...good, CLAVIX_DOMAIN: bad })).toHaveLength(1);
  });

  test("refuses an image that names a registry: staging builds on the host", () => {
    const problems = envProblems({
      ...good,
      CLAVIX_API_IMAGE: "registry.example.com/clavix-api:1",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("names a registry");
  });
});

describe("domainRegex", () => {
  test("escapes the dots and matches one label only", () => {
    const re = new RegExp(domainRegex("clavix.softistx.com"));
    expect(re.test("acme.clavix.softistx.com")).toBe(true);
    expect(re.test("console.clavix.softistx.com")).toBe(true);
    expect(re.test("clavix.softistx.com")).toBe(false);
    expect(re.test("a.b.clavix.softistx.com")).toBe(false);
    expect(re.test("acme.clavixXsoftistx.com")).toBe(false);
    expect(re.test("acme.clavix.softistx.com.evil.io")).toBe(false);
  });

  test("throws on something that is not a DNS name", () => {
    expect(() => domainRegex("*.x.com")).toThrow();
  });
});

describe("composeEnv", () => {
  test("drops the shell exports the file defines, keeps the others, adds the derived", () => {
    const env = composeEnv(
      { REDIS_PASSWORD: "stale", PATH: "/bin" },
      { REDIS_PASSWORD: "fresh" },
      { CLAVIX_DOMAIN_RE: "^x$" },
    );
    expect(env).toEqual({ PATH: "/bin", CLAVIX_DOMAIN_RE: "^x$" });
  });
});

describe("uiContext", () => {
  test("defaults to the sibling checkout, absolute paths are kept", () => {
    expect(uiContext({})).toBe(
      join(DEPLOY_DIR, "../../clavix-ui").replace(/\/deploy\/\.\.\//, "/"),
    );
    expect(uiContext({ CLAVIX_UI_CONTEXT: "/srv/clavix-ui" })).toBe(
      "/srv/clavix-ui",
    );
  });
});

describe("images", () => {
  test("imageRepository drops the tag, keeps a registry port", () => {
    expect(imageRepository("clavix-api:staging")).toBe("clavix-api");
    expect(imageRepository("clavix-api")).toBe("clavix-api");
    expect(imageRepository("localhost:5000/clavix-api:1")).toBe(
      "localhost:5000/clavix-api",
    );
  });

  test("staleImageIds keeps the current ids and lists each other id once", () => {
    const current = new Set(["sha256:new"]);
    expect(
      staleImageIds(
        ["sha256:new", "sha256:old", "", "sha256:old", " sha256:older "],
        current,
      ),
    ).toEqual(["sha256:old", "sha256:older"]);
  });
});
