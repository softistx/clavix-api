import { afterAll, describe, expect, test } from "bun:test";
import { softwareAuthenticator } from "@softistx/janus-passkeys/testing";
import { ObjectId } from "mongodb";
import { oauthDb } from "@/config/oauth-db";
import { relatedOriginsOf } from "@/modules/domains";
import { oauthPolicySchema } from "@/modules/oauth-policy/oauth-policy.schema";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import { createTenantResolver, type TenantRecord } from "@/tenancy/resolver";
import { memoryTenantCache } from "@/tenancy/tenant-cache";
import { createTenantAuth } from "./tenant-auth";
import { buildTenantJanus, SESSION_COOKIE } from "./tenant-janus";

// ADR-0036: the rpId stays the slug host; a verified custom domain is a related
// origin, so a ceremony run on it is accepted. janus-passkeys compares
// `origins` exactly, so the list must carry every verified domain.

const DOMAIN = "clavix.test";
const SLUG_HOST = `pk-origins.${DOMAIN}`;
const CUSTOM = "https://login.pk-origins.example";
const config = { scheme: "https", domain: DOMAIN } as const;

const record: TenantRecord = {
  _id: new ObjectId(),
  slug: "pk-origins",
  name: "PK origins",
  signUp: true,
  status: "active",
  version: 1,
  signIn: signInPolicySchema.parse(undefined),
  oauth: oauthPolicySchema.parse(undefined),
};

/** The domains of the tenant, as the store would answer. */
const verified = new Set<string>();
const resolver = createTenantResolver({
  lookup: async (slug) => (slug === record.slug ? record : undefined),
  lookupById: async () => record,
  domains: {
    tenantOfHost: async () => undefined,
    primaryHostOf: async () => undefined,
    verifiedHostsOf: async () => [...verified],
  },
  cache: memoryTenantCache(),
  config,
  log: () => {},
});
const { janusIssuers } = createTenantAuth({ resolver, db: oauthDb });
const instance = async () => {
  const auth = await janusIssuers.forRequest(
    new Request(`https://${SLUG_HOST}/`),
  );
  if (auth === null) throw new Error("no janus");
  return auth;
};

/** Registers a passkey from `origin` for a new user; `true` when janus accepts it. */
async function registersFrom(origin: string, email: string) {
  const auth = await instance();
  const created = await auth.create({ email });
  await auth.verifyEmail.proveFirst(created);
  const signedIn = await auth.signInProven(created);
  if (signedIn.status !== "signedIn") throw new Error("no session");
  const current = await auth.authenticate(
    new Request(`https://${SLUG_HOST}/`, {
      headers: { cookie: `${SESSION_COOKIE}=${signedIn.token}` },
    }),
  );
  if (current === null) throw new Error("no current session");
  const user = signedIn.user;
  const { challenge } = await auth.passkeys.registrationOptions(user);
  const authenticator = await softwareAuthenticator();
  const response = await authenticator.register({
    challenge,
    origin,
    rpId: SLUG_HOST,
    userVerified: true,
  });
  try {
    await auth.passkeys.register(current, { challenge, response, name: "k" });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "PASSKEY_INVALID") return false;
    throw error;
  }
}

afterAll(async () => {
  await oauthDb.collection("partitionedUsers").deleteMany({});
  await oauthDb.collection("partitionedSessions").deleteMany({});
  await oauthDb.collection("partitionedPasskeys").deleteMany({});
});

describe("passkeys on a custom domain (related origins)", () => {
  test("the slug host's own origin is accepted, a custom domain's is not while unverified", async () => {
    expect(await registersFrom(`https://${SLUG_HOST}`, "a@x.test")).toBe(true);
    expect(await registersFrom(CUSTOM, "b@x.test")).toBe(false);
  });

  test("a verified domain's origin is accepted once the tenant's cache entry is dropped", async () => {
    verified.add("login.pk-origins.example");
    // The tenant is still cached without the origin: refused until verifyDomain
    // drops the entry (DomainsService.changed -> resolver.invalidate).
    expect(await registersFrom(CUSTOM, "c@x.test")).toBe(false);
    await resolver.invalidate([SLUG_HOST]);
    expect(await registersFrom(CUSTOM, "d@x.test")).toBe(true);
  });

  test("the cached instance is rebuilt when a domain is verified or removed", async () => {
    const before = await instance();
    expect(await instance()).toBe(before);
    verified.add("auth.pk-origins.example");
    await resolver.invalidate([SLUG_HOST]);
    const added = await instance();
    expect(added).not.toBe(before);
    verified.delete("auth.pk-origins.example");
    verified.delete("login.pk-origins.example");
    await resolver.invalidate([SLUG_HOST]);
    expect(await instance()).not.toBe(added);
  });

  test("a removed domain's origin is refused again", async () => {
    expect(await registersFrom(CUSTOM, "e@x.test")).toBe(false);
  });

  test("buildTenantJanus takes the origins from the resolved tenant", async () => {
    const tenant = await resolver.resolveHost(SLUG_HOST);
    if (tenant === null) throw new Error("no tenant");
    expect(() =>
      buildTenantJanus(oauthDb, {
        ...tenant,
        relatedOrigins: relatedOriginsOf(["a.example"], config),
      }),
    ).not.toThrow();
  });
});
