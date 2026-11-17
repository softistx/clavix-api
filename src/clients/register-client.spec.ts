import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  DEVICE_GRANT,
  hashOAuthSecret,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import {
  CliInputError,
  SuspendedTenantError,
  UnknownTenantError,
} from "@/cli/errors";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { partitionOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { TenantsService } from "@/modules/tenants/tenants.service";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTenantResolver } from "@/tenancy/resolver";
import { noTenantCache } from "@/tenancy/tenant-cache";
import { createTenantParOff } from "../../test/tenant-par-off";
import { parseClientArgs } from "./cli";
import { clientIdOf, registerClient } from "./register-client";

const DOMAIN = "clavix.test";
const REDIRECT = "https://app.example/callback";
const config = { scheme: "https", domain: DOMAIN } as const;
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const options = { db: oauthDb, findTenant };

const resolver = createTenantResolver({
  lookup: findTenant,
  cache: noTenantCache,
  config,
});
const tenants = new TenantsService(mongo.db.tenants, {
  domain: DOMAIN,
  onHostsChanged: (hosts) => resolver.invalidate(hosts),
});
const keys = new Map<string, SigningKeyStore>();
const issuers = createClavixOAuthIssuers({
  resolver,
  db: oauthDb,
  signingKeysFor: (tenantId) => {
    let store = keys.get(tenantId);
    if (store === undefined) {
      store = createMemorySigningKeys();
      keys.set(tenantId, store);
    }
    return store;
  },
  authFor: () => ({
    authenticate: async () => null,
    findUser: async () => null,
  }),
  claimsFor: () => async () => ({}),
  resourcesFor: () => ({ "https://api.clavix.test/mcp": { scopes: ["read"] } }),
});

const storeOf = async (slug: string) => {
  const tenant = await findTenant(slug);
  if (tenant === undefined) throw new Error(`no tenant ${slug}`);
  return createMongoOAuth(oauthDb, { partition: partitionOf(tenant._id) });
};

const authorize = async (slug: string, clientId: string) =>
  issuers.handle(
    new Request(
      `https://${slug}.${DOMAIN}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: await s256Challenge("v".repeat(64)),
        code_challenge_method: "S256",
        scope: "read",
        resource: "https://api.clavix.test/mcp",
      })}`,
    ),
  );

beforeAll(async () => {
  for (const slug of ["regalpha", "regbeta", "regpaused"]) {
    await createTenantParOff(tenants, { slug, name: slug });
  }
  for (const slug of ["regalpha", "regbeta"]) {
    const tenant = await resolver.resolveHost(`${slug}.${DOMAIN}`);
    const store = createMemorySigningKeys();
    keys.set(tenant?.tenantId ?? "", store);
    await rotateSigningKeys(store, {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
  }
  const paused = await findTenant("regpaused");
  await tenants.suspend(paused?._id.toHexString() ?? "");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});

describe("registerClient", () => {
  test("creates a public client, then updates it on a re-run without duplicating", async () => {
    const first = await registerClient(options, {
      tenant: "regalpha",
      name: "Web app",
      redirectUris: [REDIRECT],
    });
    expect(first).toMatchObject({
      created: true,
      clientId: "web-app",
      type: "public",
      clientSecret: null,
    });
    const second = await registerClient(options, {
      tenant: "regalpha",
      name: "Web app v2",
      clientId: "web-app",
      redirectUris: [REDIRECT, "https://app.example/other"],
    });
    expect(second).toMatchObject({ created: false, clientSecret: null });
    const store = await storeOf("regalpha");
    const stored = await store.findClient("web-app");
    expect(stored).toMatchObject({
      name: "Web app v2",
      redirectUris: [REDIRECT, "https://app.example/other"],
      source: "registered",
    });
    expect(stored?.tokenEndpointAuthMethod).toBeUndefined();
    const duplicates = await oauthDb
      .collection("oauthClients")
      .countDocuments({ "_id.id": "web-app" });
    expect(duplicates).toBeLessThanOrEqual(1);
  });

  test("a confidential secret is shown once, stored hashed and kept on re-run", async () => {
    const first = await registerClient(options, {
      tenant: "regalpha",
      name: "Back office",
      redirectUris: [REDIRECT],
      type: "confidential",
    });
    expect(first.clientSecret).toBeString();
    const store = await storeOf("regalpha");
    const stored = await store.findClient("back-office");
    expect(stored?.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(stored?.secretHash).toBe(
      hashOAuthSecret(first.clientSecret as string),
    );
    expect(JSON.stringify(stored)).not.toContain(first.clientSecret as string);

    const again = await registerClient(options, {
      tenant: "regalpha",
      name: "Back office",
      redirectUris: [REDIRECT],
      type: "confidential",
    });
    expect(again).toMatchObject({ created: false, clientSecret: null });
    expect((await store.findClient("back-office"))?.secretHash).toBe(
      stored?.secretHash as string,
    );

    const rotated = await registerClient(options, {
      tenant: "regalpha",
      name: "Back office",
      redirectUris: [REDIRECT],
      type: "confidential",
      rotateSecret: true,
    });
    expect(rotated.clientSecret).toBeString();
    expect(rotated.clientSecret).not.toBe(first.clientSecret);
    expect((await store.findClient("back-office"))?.secretHash).toBe(
      hashOAuthSecret(rotated.clientSecret as string),
    );
  });

  test("a confidential client is not turned public by a re-run without --confidential", async () => {
    await registerClient(options, {
      tenant: "regalpha",
      name: "Keeps type",
      redirectUris: [REDIRECT],
      type: "confidential",
    });
    await expect(
      registerClient(options, {
        tenant: "regalpha",
        name: "Keeps type",
        redirectUris: [REDIRECT],
      }),
    ).rejects.toBeInstanceOf(CliInputError);
    expect(
      (await (await storeOf("regalpha")).findClient("keeps-type"))?.secretHash,
    ).toBeString();
  });

  test("a public client is not turned confidential by --confidential", async () => {
    await registerClient(options, {
      tenant: "regalpha",
      name: "Stays public",
      redirectUris: [REDIRECT],
    });
    await expect(
      registerClient(options, {
        tenant: "regalpha",
        name: "Stays public",
        redirectUris: [REDIRECT],
        type: "confidential",
      }),
    ).rejects.toThrow(/is a public client/);
    const stored = await (await storeOf("regalpha")).findClient("stays-public");
    expect(stored?.secretHash).toBeUndefined();
    expect(stored?.tokenEndpointAuthMethod).toBeUndefined();
  });

  test("--rotate-secret on a public client is refused, not ignored", async () => {
    await registerClient(options, {
      tenant: "regalpha",
      name: "No secret",
      redirectUris: [REDIRECT],
    });
    await expect(
      registerClient(options, {
        tenant: "regalpha",
        name: "No secret",
        redirectUris: [REDIRECT],
        rotateSecret: true,
      }),
    ).rejects.toThrow(/--rotate-secret needs a confidential client/);
  });

  test("an unknown slug and a suspended tenant are refused", async () => {
    const input = { name: "App", redirectUris: [REDIRECT] };
    await expect(
      registerClient(options, { ...input, tenant: "nobody" }),
    ).rejects.toBeInstanceOf(UnknownTenantError);
    await expect(
      registerClient(options, { ...input, tenant: "regpaused" }),
    ).rejects.toBeInstanceOf(SuspendedTenantError);
    const store = await storeOf("regpaused");
    expect(await store.findClient("app")).toBeNull();
  });

  test("--grants is stored as written, in the offered order, and kept by a re-run without it", async () => {
    const base = { tenant: "regalpha", redirectUris: [REDIRECT] };
    const store = await storeOf("regalpha");
    await registerClient(options, {
      ...base,
      name: "Code only",
      grants: ["authorization_code"],
    });
    expect((await store.findClient("code-only"))?.grantTypes).toEqual([
      "authorization_code",
    ]);
    await registerClient(options, {
      ...base,
      name: "Code only",
      grants: ["refresh_token", "authorization_code"],
    });
    expect((await store.findClient("code-only"))?.grantTypes).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    await registerClient(options, { ...base, name: "Code only" });
    expect((await store.findClient("code-only"))?.grantTypes).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    await registerClient(options, { ...base, name: "Fresh" });
    expect((await store.findClient("fresh"))?.grantTypes).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  test("a device-only client needs no redirect URI and is idempotent on a re-run that repeats --grants", async () => {
    const store = await storeOf("regalpha");
    await registerClient(options, {
      tenant: "regalpha",
      name: "Set top box",
      redirectUris: [],
      grants: [DEVICE_GRANT],
    });
    expect((await store.findClient("set-top-box"))?.grantTypes).toEqual([
      DEVICE_GRANT,
    ]);
    await registerClient(options, {
      tenant: "regalpha",
      name: "Set top box",
      redirectUris: [],
      grants: [DEVICE_GRANT],
    });
    expect((await store.findClient("set-top-box"))?.grantTypes).toEqual([
      DEVICE_GRANT,
    ]);
    // Without --grants the client is taken as a redirect one, which needs a URI.
    await expect(
      registerClient(options, {
        tenant: "regalpha",
        name: "Set top box",
        redirectUris: [],
      }),
    ).rejects.toBeInstanceOf(CliInputError);
    // With a refresh token, in the offered order.
    await registerClient(options, {
      tenant: "regalpha",
      name: "Set top box",
      redirectUris: [],
      grants: ["refresh_token", DEVICE_GRANT],
    });
    expect((await store.findClient("set-top-box"))?.grantTypes).toEqual([
      "refresh_token",
      DEVICE_GRANT,
    ]);
  });

  test("a client that uses the redirect still needs one, even beside the device grant", async () => {
    await expect(
      registerClient(options, {
        tenant: "regalpha",
        name: "Both",
        redirectUris: [],
        grants: ["authorization_code", DEVICE_GRANT],
      }),
    ).rejects.toBeInstanceOf(CliInputError);
  });

  test("bad input is refused before anything is written", async () => {
    const base = { tenant: "regalpha", name: "Bad", redirectUris: [REDIRECT] };
    for (const input of [
      { ...base, name: "  " },
      { ...base, redirectUris: [] },
      { ...base, redirectUris: ["http://app.example/cb"] },
      { ...base, redirectUris: ["https://app.example/cb#frag"] },
      { ...base, grants: ["client_credentials"] },
      { ...base, grants: [] },
      { ...base, grants: ["refresh_token"] },
      { ...base, clientId: "Not Valid" },
    ]) {
      await expect(registerClient(options, input)).rejects.toBeInstanceOf(
        CliInputError,
      );
    }
    expect(await (await storeOf("regalpha")).findClient("bad")).toBeNull();
  });
});

describe("isolation between tenants", () => {
  test("a client of tenant A is not found on B, and B's /authorize refuses it", async () => {
    await registerClient(options, {
      tenant: "regalpha",
      name: "Isolated",
      redirectUris: [REDIRECT],
    });
    expect(
      await (await storeOf("regalpha")).findClient("isolated"),
    ).not.toBeNull();
    expect(await (await storeOf("regbeta")).findClient("isolated")).toBeNull();

    // Registered, A's /authorize goes on to consent; B refuses the same id.
    const onA = await authorize("regalpha", "isolated");
    expect(onA.status).toBe(302);
    expect(onA.headers.get("location")).toContain("/consent");
    const onB = await authorize("regbeta", "isolated");
    expect(onB.status).toBe(400);
    expect(await onB.json()).toMatchObject({ error: "invalid_client" });
  });

  test("the same id on both tenants gives two separate clients", async () => {
    await registerClient(options, {
      tenant: "regalpha",
      name: "Shared id",
      redirectUris: [REDIRECT],
    });
    await registerClient(options, {
      tenant: "regbeta",
      name: "Shared id",
      redirectUris: ["https://beta.example/cb"],
    });
    expect(
      (await (await storeOf("regalpha")).findClient("shared-id"))?.redirectUris,
    ).toEqual([REDIRECT]);
    expect(
      (await (await storeOf("regbeta")).findClient("shared-id"))?.redirectUris,
    ).toEqual(["https://beta.example/cb"]);
  });
});

describe("requirePar", () => {
  test("is stored, kept on a re-run that says nothing, and cleared by false", async () => {
    await createTenantParOff(tenants, { slug: "regpar", name: "Par" });
    const base = {
      tenant: "regpar",
      name: "App",
      redirectUris: [REDIRECT],
    };
    const first = await registerClient(options, { ...base, requirePar: true });
    expect(first.requirePar).toBe(true);
    const store = await storeOf("regpar");
    expect(
      (await store.findClient("app"))?.requirePushedAuthorizationRequests,
    ).toBe(true);
    expect((await registerClient(options, base)).requirePar).toBe(true);
    const cleared = await registerClient(options, {
      ...base,
      requirePar: false,
    });
    expect(cleared.requirePar).toBe(false);
    expect(
      (await store.findClient("app"))?.requirePushedAuthorizationRequests,
    ).toBeUndefined();
  });

  test("the flags --require-par and --no-require-par become the input", () => {
    const line = ["--tenant", "a", "--name", "x", "--redirect-uri", REDIRECT];
    expect(parseClientArgs([...line, "--require-par"]).requirePar).toBe(true);
    expect(parseClientArgs([...line, "--no-require-par"]).requirePar).toBe(
      false,
    );
    expect(parseClientArgs(line).requirePar).toBeUndefined();
  });
});

describe("command line", () => {
  test("flags become an input", () => {
    expect(
      parseClientArgs([
        "--tenant",
        "acme",
        "--name",
        "Back office",
        "--redirect-uri",
        "https://a.example/cb",
        "--redirect-uri",
        "https://b.example/cb",
        "--confidential",
        "--grants",
        "authorization_code,refresh_token",
      ]),
    ).toEqual({
      tenant: "acme",
      name: "Back office",
      redirectUris: ["https://a.example/cb", "https://b.example/cb"],
      type: "confidential",
      grants: ["authorization_code", "refresh_token"],
    });
  });

  test("a missing flag or an unknown one is refused", () => {
    expect(() => parseClientArgs(["--name", "x"])).toThrow(CliInputError);
    expect(() => parseClientArgs(["--tenant", "a"])).toThrow(CliInputError);
    expect(() =>
      parseClientArgs(["--tenant", "a", "--name", "x", "--nope"]),
    ).toThrow(CliInputError);
  });

  test("the default id is the name as a-z0-9-", () => {
    expect(clientIdOf("  Back Office (EU)! ")).toBe("back-office-eu");
  });
});
