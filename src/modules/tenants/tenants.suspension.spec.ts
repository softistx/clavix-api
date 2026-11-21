import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MemoryMailer } from "@softistx/mail";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { mailer } from "@/config/mail";
import { createTenancy, tenantsService } from "@/config/tenancy";
import { settled } from "@/modules/auth";
import type { TxtAnswer } from "@/modules/domains";
import { DomainsService, RECHECK_GRACE_DAYS } from "@/modules/domains";
import { memoryTenantCache } from "@/tenancy/tenant-cache";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { quietDomains } from "~/ports";
import { PLATFORM_TENANT_SLUG } from "./tenants.rules";
import { issuerOf } from "./tenants.utils";

const memory = mailer as MemoryMailer;
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const app = createTestApp();
const url = (slug: string) => `${issuerOf(slug, origin)}/graphql`;

interface Answer {
  status: number;
  data: Record<string, unknown> | null;
  errors?: { extensions?: { code?: string } }[];
}
async function gql(slug: string, query: string): Promise<Answer> {
  const response = await app.request(url(slug), {
    method: "POST",
    headers: { ...clientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as Omit<Answer, "status">;
  return { ...body, status: response.status, data: body.data ?? null };
}
const REQUEST =
  'mutation { requestSignInCode(email: "ada@example.test") { challenge } }';
const verify = (challenge: string) =>
  `mutation { verifySignInCode(challenge: "${challenge}", code: "000000") { __typename } }`;

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});

describe("a suspended or deleted tenant's hosted pages", () => {
  let id = "";
  beforeAll(async () => {
    id = (
      await tenantsService.create({
        slug: "frozen",
        name: "Frozen",
        signUp: true,
      })
    )._id.toHexString();
  });

  test("sign-in works while active, is refused with TENANT_SUSPENDED once suspended, and works again after resume", async () => {
    const before = memory.sent.length;
    const ok = await gql("frozen", REQUEST);
    await settled();
    expect(ok.errors).toBeUndefined();
    expect(memory.sent.length).toBeGreaterThan(before);
    const requested = ok.data?.["requestSignInCode"] as
      | { challenge: string }
      | undefined;
    const challenge = requested?.challenge ?? "";

    await tenantsService.suspend(id);
    for (const query of [REQUEST, verify(challenge)]) {
      const refused = await gql("frozen", query);
      expect(refused.status).toBe(403);
      expect(refused.errors?.[0]?.extensions?.code).toBe("TENANT_SUSPENDED");
    }
    const sent = memory.sent.length;
    await gql("frozen", REQUEST);
    await settled();
    expect(memory.sent.length).toBe(sent);

    // Reading who is signed in and signing out still answer.
    const me = await gql("frozen", "{ currentUser { id } }");
    expect(me.errors).toBeUndefined();
    expect(
      (await gql("frozen", "mutation { signOut }")).errors,
    ).toBeUndefined();

    await tenantsService.reactivate(id);
    expect((await gql("frozen", REQUEST)).errors).toBeUndefined();
  });

  test("social sign-in and invitation acceptance are refused like code sign-in, then work again", async () => {
    const social = [
      'mutation { socialSignInStart(provider: "github", returnTo: null) { url } }',
      'mutation { socialSignInComplete(callbackUrl: "https://x.test/cb", flow: "f") { __typename } }',
      'mutation { acceptInvitation(code: "abc") { signedIn } }',
    ];
    await tenantsService.suspend(id);
    for (const query of social) {
      const refused = await gql("frozen", query);
      expect(refused.status).toBe(403);
      expect(refused.errors?.[0]?.extensions?.code).toBe("TENANT_SUSPENDED");
    }
    await tenantsService.reactivate(id);
    for (const query of social) {
      const answer = await gql("frozen", query);
      expect(answer.errors?.[0]?.extensions?.code).not.toBe("TENANT_SUSPENDED");
    }
  });

  test("a deleted tenant is refused like a suspended one, a restored one is not", async () => {
    await tenantsService.delete(id);
    const refused = await gql("frozen", REQUEST);
    expect(refused.errors?.[0]?.extensions?.code).toBe("TENANT_SUSPENDED");
    await tenantsService.restore(id);
    expect((await gql("frozen", REQUEST)).errors).toBeUndefined();
  });
});

describe("a suspension and the cached custom hosts", () => {
  test("a verified host and a lapsed primary host are not live at once after a suspension", async () => {
    const created = await tenantsService.create({
      slug: "cached-custom",
      name: "Cached",
    });
    const records = new Map<string, TxtAnswer>();
    let clock = new Date("2026-11-12T12:00:00Z");
    const store = new DomainsService(mongo.db.domains, {
      ...quietDomains,
      dns: {
        resolveTxt: async (name) => records.get(name) ?? { kind: "none" },
      },
      platformDomain: env.CLAVIX_DOMAIN,
      now: () => clock,
      log: () => {},
    });
    const verified = async (host: string) => {
      const claim = await store.add(created._id, host, null);
      records.set(`_clavix.${host}`, {
        kind: "records",
        values: [claim.txtToken],
      });
      return (await store.verify(created._id, claim._id.toHexString())).domain;
    };
    const kept = "login.cached-tenant.com";
    const primary = "id.cached-tenant.com";
    await verified(kept);
    const second = await verified(primary);
    await store.setPrimary(created._id, second._id.toHexString());
    // The primary's record disappears for good: it lapses, and still resolves.
    records.delete(`_clavix.${primary}`);
    await store.recheckAll(async () => {});
    clock = new Date(clock.getTime() + (RECHECK_GRACE_DAYS + 1) * 86_400_000);
    await store.recheckAll(async () => {});
    expect(await store.verifiedHostsOf(created._id)).toEqual([kept]);

    const tenancy = createTenancy({
      onCreated: async () => {},
      log: () => {},
      tenants: mongo.db.tenants,
      cache: memoryTenantCache(Date.now),
      config: origin,
      domains: {
        tenantOfHost: (host) => store.tenantOfHost(host),
        primaryHostOf: (tenantId) => store.primaryHostOf(tenantId),
        verifiedHostsOf: (tenantId) => store.verifiedHostsOf(tenantId),
      },
      hostsOf: (tenantId) => store.resolvingHostsOf(tenantId),
    });
    for (const host of [kept, primary]) {
      expect((await tenancy.tenantResolver.resolveHost(host))?.status).toBe(
        "active",
      );
    }
    await tenancy.tenantsService.suspend(created._id.toHexString());
    for (const host of [kept, primary]) {
      expect((await tenancy.tenantResolver.resolveHost(host))?.status).toBe(
        "suspended",
      );
    }
  });
});
