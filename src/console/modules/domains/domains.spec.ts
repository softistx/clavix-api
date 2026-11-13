import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { domainStore, tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

const admin = consoleAs("dom-admin-a");
const viewer = consoleAs("dom-viewer-a");
const adminB = consoleAs("dom-admin-b");

let tenantA = "";
let tenantB = "";

const FIELDS = "id host status txtRecord { name value } primary";
const ADD = `mutation($tenantId: ID!, $host: String!) {
  addDomain(tenantId: $tenantId, host: $host) { ${FIELDS} }
}`;
const VERIFY = `mutation($tenantId: ID!, $id: ID!) {
  verifyDomain(tenantId: $tenantId, id: $id) { domain { id status } failure }
}`;
const REMOVE = `mutation($tenantId: ID!, $id: ID!) { removeDomain(tenantId: $tenantId, id: $id) }`;
const PRIMARY = `mutation($tenantId: ID!, $id: ID!) {
  setPrimaryDomain(tenantId: $tenantId, id: $id) { id primary }
}`;
const LIST = `query($tenantId: ID!) { domains(tenantId: $tenantId) { ${FIELDS} } }`;
const GET = `query($tenantId: ID!, $id: ID!) { domain(tenantId: $tenantId, id: $id) { ${FIELDS} } }`;

const idOf = (result: Awaited<ReturnType<typeof admin>>) =>
  String((result.data?.["addDomain"] as { id: string } | undefined)?.id);

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "dom-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "dom-b", name: "B" })).id;
  // Pro: five domains.
  for (const id of [tenantA, tenantB]) {
    await mongo.db.tenants.raw.updateOne(
      { _id: new ObjectId(id) },
      { $set: { plan: "pro" } },
    );
  }
  await access.grantTenant(tenantA, "dom-admin-a", "admin");
  await access.grantTenant(tenantA, "dom-viewer-a", "viewer");
  await access.grantTenant(tenantB, "dom-admin-b", "admin");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.domains.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("the tenant id's spelling on a write", () => {
  test("addDomain with an upper-case tenant id adds the domain and keeps the quota", async () => {
    const result = await admin(ADD, {
      tenantId: tenantA.toUpperCase(),
      host: "upper.acme.com",
    });
    expect(result.errors).toBeUndefined();
  });
});

describe("addDomain", () => {
  test("claims a normalised host and shows the TXT record to publish", async () => {
    const result = await admin(ADD, {
      tenantId: tenantA,
      host: "Auth.Acme.com.",
    });
    expect(result.errors).toBeUndefined();
    const domain = result.data?.["addDomain"] as {
      host: string;
      status: string;
      primary: boolean;
      txtRecord: { name: string; value: string };
    };
    expect(domain).toMatchObject({
      host: "auth.acme.com",
      status: "PENDING",
      primary: false,
    });
    expect(domain.txtRecord.name).toBe("_clavix.auth.acme.com");
    expect(domain.txtRecord.value).toStartWith("clavix-verify=");
  });

  test("is idempotent", async () => {
    const one = await admin(ADD, { tenantId: tenantA, host: "idem.acme.com" });
    const two = await admin(ADD, { tenantId: tenantA, host: "IDEM.acme.com" });
    expect(idOf(two)).toBe(idOf(one));
  });

  test.each(["", "*.acme.com", "127.0.0.1", "localhost", "x.clavix.localhost"])(
    "refuses %p with BAD_USER_INPUT on host",
    async (host) => {
      const result = await admin(ADD, { tenantId: tenantA, host });
      expect(codeOf(result)).toBe("BAD_USER_INPUT");
      expect(
        (result.errors?.[0]?.extensions as { field?: string } | undefined)
          ?.field,
      ).toBe("host");
    },
  );

  test("a viewer cannot add; another tenant's admin cannot either", async () => {
    expect(
      codeOf(await viewer(ADD, { tenantId: tenantA, host: "v.acme.com" })),
    ).toBe("FORBIDDEN");
    expect(
      codeOf(await adminB(ADD, { tenantId: tenantA, host: "b.acme.com" })),
    ).toBe("FORBIDDEN");
  });

  test("the quota is enforced and the usage count is real", async () => {
    await mongo.db.domains.raw.deleteMany({});
    await mongo.db.tenants.raw.updateOne(
      { _id: new ObjectId(tenantA) },
      { $set: { plan: "free" } },
    );
    expect(
      (await admin(ADD, { tenantId: tenantA, host: "one.acme.com" })).errors,
    ).toBeUndefined();
    const over = await admin(ADD, { tenantId: tenantA, host: "two.acme.com" });
    expect(codeOf(over)).toBe("QUOTA_EXCEEDED");
    expect(await domainStore.count(new ObjectId(tenantA))).toBe(1);
    expect(await usageService.count(tenantA, "domains")).toBe(1);
    await mongo.db.tenants.raw.updateOne(
      { _id: new ObjectId(tenantA) },
      { $set: { plan: "pro" } },
    );
  });
});

describe("quota under concurrency", () => {
  test("parallel claims past the quota leave exactly the quota's worth", async () => {
    await mongo.db.domains.raw.deleteMany({});
    await mongo.db.tenants.raw.updateOne(
      { _id: new ObjectId(tenantA) },
      { $set: { plan: "free" } },
    );
    const results = await Promise.all(
      ["p1", "p2", "p3", "p4"].map((label) =>
        admin(ADD, { tenantId: tenantA, host: `${label}.acme.com` }),
      ),
    );
    const accepted = results.filter((r) => r.errors === undefined);
    expect(accepted).toHaveLength(1);
    expect(results.filter((r) => codeOf(r) === "QUOTA_EXCEEDED")).toHaveLength(
      3,
    );
    expect(await domainStore.count(new ObjectId(tenantA))).toBe(1);
    await mongo.db.tenants.raw.updateOne(
      { _id: new ObjectId(tenantA) },
      { $set: { plan: "pro" } },
    );
  });
});

describe("verify cooldown", () => {
  test("a second verify of one claim is VERIFY_COOLDOWN (429) with retryAfter", async () => {
    const added = await admin(ADD, { tenantId: tenantA, host: "cd.acme.com" });
    const id = idOf(added);
    expect(
      (await admin(VERIFY, { tenantId: tenantA, id })).errors,
    ).toBeUndefined();
    const again = await admin(VERIFY, { tenantId: tenantA, id });
    expect(codeOf(again)).toBe("VERIFY_COOLDOWN");
    const extensions = again.errors?.[0]?.extensions as
      | { retryAfter?: number }
      | undefined;
    expect(extensions?.retryAfter).toBeGreaterThan(0);
    expect(extensions?.retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("reads, isolation, remove, primary", () => {
  test("list and get are tenant-scoped; a viewer may read", async () => {
    await mongo.db.domains.raw.deleteMany({});
    const added = await admin(ADD, { tenantId: tenantA, host: "r.acme.com" });
    const id = idOf(added);
    const list = await viewer(LIST, { tenantId: tenantA });
    expect(
      ((list.data?.["domains"] as { host: string }[] | undefined) ?? []).map(
        (d) => d.host,
      ),
    ).toEqual(["r.acme.com"]);
    // Tenant B sees none of A's, by list or by id.
    const other = await adminB(LIST, { tenantId: tenantB });
    expect(other.data?.["domains"]).toEqual([]);
    expect(codeOf(await adminB(GET, { tenantId: tenantA, id }))).toBe(
      "FORBIDDEN",
    );
    // Under its own tenant the id is simply not found.
    const own = await adminB(GET, { tenantId: tenantB, id });
    expect(own.data?.["domain"] ?? null).toBeNull();
  });

  test("verify without the record reports NO_RECORD or a lookup failure, never verifies", async () => {
    const added = await admin(ADD, { tenantId: tenantA, host: "nr.acme.com" });
    const result = await admin(VERIFY, {
      tenantId: tenantA,
      id: idOf(added),
    });
    const payload = result.data?.["verifyDomain"] as {
      domain: { status: string };
      failure: string;
    };
    expect(payload.domain.status).toBe("PENDING");
    expect(["NO_RECORD", "LOOKUP_FAILED"]).toContain(payload.failure);
    expect(
      codeOf(
        await admin(VERIFY, { tenantId: tenantA, id: String(new ObjectId()) }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("setPrimary needs a verified domain; the primary cannot be removed", async () => {
    const added = await admin(ADD, { tenantId: tenantA, host: "pm.acme.com" });
    const id = idOf(added);
    expect(codeOf(await admin(PRIMARY, { tenantId: tenantA, id }))).toBe(
      "DOMAIN_NOT_VERIFIED",
    );
    await mongo.db.domains.raw.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "verified", verifiedAt: new Date() } },
    );
    const set = await admin(PRIMARY, { tenantId: tenantA, id });
    expect(set.data?.["setPrimaryDomain"]).toEqual({ id, primary: true });
    expect(codeOf(await admin(REMOVE, { tenantId: tenantA, id }))).toBe(
      "DOMAIN_PRIMARY",
    );
  });

  test("a verified host elsewhere is DOMAIN_TAKEN; remove is idempotent and viewer-proof", async () => {
    const taken = await adminB(ADD, { tenantId: tenantB, host: "pm.acme.com" });
    expect(codeOf(taken)).toBe("DOMAIN_TAKEN");
    const mine = await admin(ADD, { tenantId: tenantA, host: "rm.acme.com" });
    const id = idOf(mine);
    expect(codeOf(await viewer(REMOVE, { tenantId: tenantA, id }))).toBe(
      "FORBIDDEN",
    );
    expect((await admin(REMOVE, { tenantId: tenantA, id })).data).toEqual({
      removeDomain: true,
    });
    expect((await admin(REMOVE, { tenantId: tenantA, id })).data).toEqual({
      removeDomain: false,
    });
  });
});

describe("audit", () => {
  test("each change is recorded, a repeat remove too, a refused one nothing", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    await mongo.db.domains.raw.deleteMany({});
    const added = await admin(ADD, { tenantId: tenantA, host: "au.acme.com" });
    const id = idOf(added);
    await viewer(REMOVE, { tenantId: tenantA, id });
    await admin(REMOVE, { tenantId: tenantA, id });
    await admin(REMOVE, { tenantId: tenantA, id });
    // A repeat is recorded too (the first run's event may have been lost).
    const events = await mongo.db.adminEvents.raw
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(events.map((event) => event.action)).toEqual([
      "domain.add",
      "domain.remove",
      "domain.remove",
    ]);
  });
});

describe("removeDomain with an id the trail cannot hold", () => {
  test("is false, not an error", async () => {
    const result = await admin(REMOVE, {
      tenantId: tenantA,
      id: "x".repeat(300),
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ removeDomain: false });
  });
});

describe("setPrimaryDomain at the very same time", () => {
  test("exactly one domain is primary afterwards", async () => {
    await mongo.db.domains.raw.deleteMany({});
    const ids: string[] = [];
    for (const host of ["p1.acme.com", "p2.acme.com", "p3.acme.com"]) {
      const id = idOf(await admin(ADD, { tenantId: tenantA, host }));
      await mongo.db.domains.raw.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "verified", verifiedAt: new Date() } },
      );
      ids.push(id);
    }
    await Promise.all(
      ids.map((id) => admin(PRIMARY, { tenantId: tenantA, id })),
    );
    const listed = await admin(LIST, { tenantId: tenantA });
    const rows = listed.data?.["domains"] as { primary: boolean }[];
    expect(rows.filter((row) => row.primary)).toHaveLength(1);
  });
});

describe("the tenant id's spelling", () => {
  test("an upper-case tenant id is the same tenant, as on every module", async () => {
    const lower = await admin(LIST, { tenantId: tenantA });
    const upper = await admin(LIST, { tenantId: tenantA.toUpperCase() });
    expect(upper.errors).toBeUndefined();
    expect(upper.data).toEqual(lower.data);
  });
});
