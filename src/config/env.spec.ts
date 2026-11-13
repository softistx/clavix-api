import { expect, test } from "bun:test";

// src/config/env.ts checks Bun.env once, when it is first imported: a spec
// gives it a fresh copy (a query string makes a new module) under the values it
// tests.
let loads = 0;
const load = async (values: Record<string, string | undefined>) => {
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, Bun.env[key]]),
  );
  const set = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  };
  set(values);
  try {
    loads += 1;
    return await import(`./env.ts?load=${loads}`);
  } finally {
    set(before);
  }
};

const clean = {
  REDIS_URL: undefined,
  CLAVIX_DOMAIN: undefined,
  CLAVIX_PUBLIC_SCHEME: undefined,
  CLAVIX_PUBLIC_PORT: undefined,
  CLAVIX_KEYS_MASTER_KEY: undefined,
  CLAVIX_SMTP_URL: undefined,
};

const masterKey = Buffer.alloc(32, 7).toString("base64");

test("outside production the defaults stand in", async () => {
  const { env } = await load(clean);
  expect(env.REDIS_URL).toBeUndefined();
  expect(env.CLAVIX_DOMAIN).toBe("clavix.localhost");
  expect(env.CLAVIX_PUBLIC_SCHEME).toBe("https");
  expect(env.CLAVIX_PUBLIC_PORT).toBeUndefined();
});

test("the values are read", async () => {
  const { env } = await load({
    ...clean,
    REDIS_URL: "redis://localhost:6379",
    CLAVIX_DOMAIN: "clavix.example",
    CLAVIX_PUBLIC_SCHEME: "http",
    CLAVIX_PUBLIC_PORT: "3000",
  });
  expect(env.REDIS_URL).toBe("redis://localhost:6379");
  expect(env.CLAVIX_DOMAIN).toBe("clavix.example");
  expect(env.CLAVIX_PUBLIC_SCHEME).toBe("http");
  expect(env.CLAVIX_PUBLIC_PORT).toBe(3000);
});

test("empty REDIS_URL and CLAVIX_PUBLIC_PORT are unset", async () => {
  const { env } = await load({
    ...clean,
    REDIS_URL: "",
    CLAVIX_PUBLIC_PORT: "",
  });
  expect(env.REDIS_URL).toBeUndefined();
  expect(env.CLAVIX_PUBLIC_PORT).toBeUndefined();
});

test("a malformed variable stops the app, naming it", async () => {
  await expect(load({ ...clean, MONGO_URI: "http://x" })).rejects.toThrow(
    "MONGO_URI",
  );
  await expect(load({ ...clean, REDIS_URL: "nope" })).rejects.toThrow(
    "REDIS_URL",
  );
  await expect(
    load({ ...clean, CLAVIX_DOMAIN: "Clavix.Example" }),
  ).rejects.toThrow("CLAVIX_DOMAIN");
  await expect(load({ ...clean, CLAVIX_DOMAIN: "localhost" })).rejects.toThrow(
    "CLAVIX_DOMAIN",
  );
  await expect(load({ ...clean, CLAVIX_PUBLIC_SCHEME: "ftp" })).rejects.toThrow(
    "CLAVIX_PUBLIC_SCHEME",
  );
  await expect(load({ ...clean, CLAVIX_PUBLIC_PORT: "70000" })).rejects.toThrow(
    "CLAVIX_PUBLIC_PORT",
  );
});

test("production requires REDIS_URL and CLAVIX_DOMAIN and refuses http", async () => {
  const production = {
    NODE_ENV: "production",
    REDIS_URL: "redis://redis:6379",
    CLAVIX_DOMAIN: "clavix.example",
    CLAVIX_PUBLIC_SCHEME: "https",
    CLAVIX_KEYS_MASTER_KEY: masterKey,
    CLAVIX_SMTP_URL: "smtps://relay.example:465",
  };
  await expect(
    load({ ...clean, ...production, CLAVIX_SMTP_URL: undefined }),
  ).rejects.toThrow("CLAVIX_SMTP_URL");
  await expect(
    load({ ...clean, ...production, CLAVIX_SMTP_URL: "http://relay" }),
  ).rejects.toThrow("CLAVIX_SMTP_URL");
  // `production` is read at import, so each case sets NODE_ENV for its load.
  const { env } = await load({ ...clean, ...production });
  expect(env.CLAVIX_DOMAIN).toBe("clavix.example");
  await expect(
    load({ ...clean, ...production, REDIS_URL: undefined }),
  ).rejects.toThrow("REDIS_URL");
  await expect(
    load({ ...clean, ...production, CLAVIX_DOMAIN: undefined }),
  ).rejects.toThrow("CLAVIX_DOMAIN");
  await expect(
    load({ ...clean, ...production, CLAVIX_PUBLIC_SCHEME: "http" }),
  ).rejects.toThrow("CLAVIX_PUBLIC_SCHEME");
});

test("the keys master key: a public default outside production, never in it", async () => {
  const { env, DEV_KEYS_MASTER_KEY } = await load(clean);
  expect(env.CLAVIX_KEYS_MASTER_KEY).toBe(DEV_KEYS_MASTER_KEY);
  expect(Buffer.from(DEV_KEYS_MASTER_KEY, "base64")).toHaveLength(32);
  const given = await load({ ...clean, CLAVIX_KEYS_MASTER_KEY: masterKey });
  expect(given.env.CLAVIX_KEYS_MASTER_KEY).toBe(masterKey);

  const production = {
    ...clean,
    NODE_ENV: "production",
    REDIS_URL: "redis://redis:6379",
    CLAVIX_DOMAIN: "clavix.example",
    CLAVIX_SMTP_URL: "smtps://relay.example:465",
  };
  // Missing, short, long and not base64 are all refused in production...
  for (const bad of [
    undefined,
    "",
    Buffer.alloc(16, 7).toString("base64"),
    Buffer.alloc(33, 7).toString("base64"),
    "not base64 at all, but 44 characters long......",
  ]) {
    await expect(
      load({ ...production, CLAVIX_KEYS_MASTER_KEY: bad }),
    ).rejects.toThrow("CLAVIX_KEYS_MASTER_KEY");
  }
  // ...and a malformed one is refused outside it too, not replaced by the default.
  await expect(
    load({ ...clean, CLAVIX_KEYS_MASTER_KEY: "c2hvcnQ=" }),
  ).rejects.toThrow("CLAVIX_KEYS_MASTER_KEY");
});

test("the keys master key takes a keyring: a comma-separated list, no repeat", async () => {
  const next = Buffer.alloc(32, 9).toString("base64");
  const ring = `${next},${masterKey}`;
  const { env } = await load({ ...clean, CLAVIX_KEYS_MASTER_KEY: ring });
  expect(env.CLAVIX_KEYS_MASTER_KEY).toBe(ring);
  await expect(
    load({ ...clean, CLAVIX_KEYS_MASTER_KEY: `${masterKey},${masterKey}` }),
  ).rejects.toThrow("CLAVIX_KEYS_MASTER_KEY");
  await expect(
    load({ ...clean, CLAVIX_KEYS_MASTER_KEY: `${masterKey},c2hvcnQ=` }),
  ).rejects.toThrow("CLAVIX_KEYS_MASTER_KEY");
});

test("the sign-in code limits and the proxy count have defaults and are read", async () => {
  const { env } = await load({
    ...clean,
    CLAVIX_CODE_IP_LIMIT: undefined,
    CLAVIX_CODE_IP_WINDOW_SECONDS: undefined,
    CLAVIX_CODE_TENANT_LIMIT: undefined,
    CLAVIX_CODE_TENANT_WINDOW_SECONDS: undefined,
    CLAVIX_TRUSTED_PROXIES: undefined,
  });
  expect(env.CLAVIX_CODE_IP_LIMIT).toBe(20);
  expect(env.CLAVIX_CODE_IP_WINDOW_SECONDS).toBe(600);
  expect(env.CLAVIX_CODE_TENANT_LIMIT).toBe(200);
  expect(env.CLAVIX_CODE_TENANT_WINDOW_SECONDS).toBe(3600);
  expect(env.CLAVIX_TRUSTED_PROXIES).toBe(0);
  const set = await load({
    ...clean,
    CLAVIX_CODE_IP_LIMIT: "5",
    CLAVIX_TRUSTED_PROXIES: "2",
  });
  expect(set.env.CLAVIX_CODE_IP_LIMIT).toBe(5);
  expect(set.env.CLAVIX_TRUSTED_PROXIES).toBe(2);
  await expect(load({ ...clean, CLAVIX_CODE_IP_LIMIT: "0" })).rejects.toThrow(
    "CLAVIX_CODE_IP_LIMIT",
  );
});

test("CLAVIX_TRUSTED_PROXIES is required in production, with a clear error", async () => {
  const production = {
    ...clean,
    NODE_ENV: "production",
    REDIS_URL: "redis://redis:6379",
    CLAVIX_DOMAIN: "clavix.example",
    CLAVIX_SMTP_URL: "smtps://relay.example:465",
    CLAVIX_KEYS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  await expect(
    load({ ...production, CLAVIX_TRUSTED_PROXIES: undefined }),
  ).rejects.toThrow("CLAVIX_TRUSTED_PROXIES is required in production");
  await expect(
    load({ ...production, CLAVIX_TRUSTED_PROXIES: "" }),
  ).rejects.toThrow("CLAVIX_TRUSTED_PROXIES");
  const zero = await load({ ...production, CLAVIX_TRUSTED_PROXIES: "0" });
  expect(zero.env.CLAVIX_TRUSTED_PROXIES).toBe(0);
});
