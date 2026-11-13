import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { QuotaExceededError } from "@/modules/usage/quota";
import type { TxtAnswer, TxtResolver } from "./dns";
import { DomainError } from "./domains.errors";
import { DomainStore, mintToken, RECHECK_GRACE_DAYS } from "./domains.service";

const collection = mongo.db.domains;
const records = new Map<string, TxtAnswer>();
const dns: TxtResolver = {
  resolveTxt: async (name) => records.get(name) ?? { kind: "none" },
};
let clock = new Date("2026-11-12T12:00:00Z");
const changed: string[][] = [];
const store = new DomainStore(collection, {
  dns,
  platformDomain: "clavix.test",
  now: () => clock,
  onHostsChanged: (hosts) => {
    changed.push(hosts);
  },
  log: () => {},
});
const A = new ObjectId();
const B = new ObjectId();
const publish = (host: string, token: string) =>
  records.set(`_clavix.${host}`, { kind: "records", values: [token] });
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return "none";
};

afterEach(async () => {
  records.clear();
  changed.length = 0;
  clock = new Date("2026-11-12T12:00:00Z");
  await collection.raw.deleteMany({});
});

const addVerified = async (tenant: ObjectId, host: string) => {
  const claim = await store.add(tenant, host, null);
  publish(claim.host, claim.txtToken);
  return (await store.verify(tenant, claim._id.toHexString())).domain;
};

describe("tokens", () => {
  test("are unguessable and distinct", () => {
    const a = mintToken();
    expect(a).toStartWith("clavix-verify=");
    expect(a.length).toBeGreaterThan(40);
    expect(mintToken()).not.toBe(a);
  });
});

describe("add", () => {
  test("normalises, is idempotent, starts pending with its own token", async () => {
    const one = await store.add(A, "Auth.Acme.com.", null);
    const two = await store.add(A, "auth.acme.com", null);
    expect(one.host).toBe("auth.acme.com");
    expect(one.status).toBe("pending");
    expect(one.primary).toBe(false);
    expect(two._id.equals(one._id)).toBe(true);
    expect(await store.count(A)).toBe(1);
  });

  test("two tenants may both claim a host; tokens differ", async () => {
    const a = await store.add(A, "shared.acme.com", null);
    const b = await store.add(B, "shared.acme.com", null);
    expect(a.txtToken).not.toBe(b.txtToken);
  });

  test("refuses platform domains, IPs, localhost, wildcards", async () => {
    for (const host of [
      "x.clavix.test",
      "1.2.3.4",
      "localhost",
      "*.acme.com",
    ]) {
      expect(await codeOf(store.add(A, host, null))).toBe("BAD_USER_INPUT");
    }
  });

  test("enforces the domains quota, counting pending claims", async () => {
    await store.add(A, "one.acme.com", 2);
    await store.add(A, "two.acme.com", 2);
    const refused = await store.add(A, "three.acme.com", 2).catch((e) => e);
    expect(refused).toBeInstanceOf(QuotaExceededError);
    expect(refused.key).toBe("domains");
    expect(await store.count(A)).toBe(2);
    // The same host again stays idempotent at the limit.
    await store.add(A, "two.acme.com", 2);
  });

  test("a host verified by another tenant is DOMAIN_TAKEN", async () => {
    await addVerified(A, "auth.acme.com");
    expect(await codeOf(store.add(B, "auth.acme.com", null))).toBe(
      "DOMAIN_TAKEN",
    );
  });
});

describe("verify", () => {
  test("reports NO_RECORD, MISMATCH and LOOKUP_FAILED without verifying", async () => {
    const claim = await store.add(A, "auth.acme.com", null);
    const id = claim._id.toHexString();
    expect((await store.verify(A, id)).failure).toBe("NO_RECORD");
    publish("auth.acme.com", "clavix-verify=wrong");
    expect((await store.verify(A, id)).failure).toBe("MISMATCH");
    records.set("_clavix.auth.acme.com", { kind: "failed" });
    const last = await store.verify(A, id);
    expect(last.failure).toBe("LOOKUP_FAILED");
    expect(last.domain.status).toBe("pending");
  });

  test("a token of another tenant does not verify", async () => {
    const a = await store.add(A, "auth.acme.com", null);
    const b = await store.add(B, "auth.acme.com", null);
    publish("auth.acme.com", a.txtToken);
    expect((await store.verify(B, b._id.toHexString())).failure).toBe(
      "MISMATCH",
    );
    expect((await store.verify(A, a._id.toHexString())).failure).toBeNull();
  });

  test("first verifier wins and evicts the other pending claims", async () => {
    const a = await store.add(A, "auth.acme.com", null);
    await store.add(B, "auth.acme.com", null);
    publish("auth.acme.com", a.txtToken);
    const done = await store.verify(A, a._id.toHexString());
    expect(done.domain.status).toBe("verified");
    expect(done.domain.verifiedAt).not.toBeNull();
    expect(await store.tenantOfHost("auth.acme.com")).toEqual(A);
    expect(await store.count(B)).toBe(0);
    expect(changed.flat()).toContain("auth.acme.com");
  });

  test("another tenant cannot see or verify a claim by id", async () => {
    const a = await store.add(A, "auth.acme.com", null);
    expect(await codeOf(store.verify(B, a._id.toHexString()))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("primary and remove", () => {
  test("only a verified domain becomes primary; one primary at a time", async () => {
    const pending = await store.add(A, "p.acme.com", null);
    expect(await codeOf(store.setPrimary(A, pending._id.toHexString()))).toBe(
      "DOMAIN_NOT_VERIFIED",
    );
    const one = await addVerified(A, "one.acme.com");
    const two = await addVerified(A, "two.acme.com");
    await store.setPrimary(A, one._id.toHexString());
    await store.setPrimary(A, two._id.toHexString());
    expect(await store.primaryHostOf(A)).toBe("two.acme.com");
    expect(await store.verifiedHostsOf(A)).toHaveLength(2);
  });

  test("the primary cannot be removed; others can, and it frees the quota", async () => {
    const one = await addVerified(A, "one.acme.com");
    const two = await addVerified(A, "two.acme.com");
    await store.setPrimary(A, one._id.toHexString());
    expect(await codeOf(store.remove(A, one._id.toHexString()))).toBe(
      "DOMAIN_PRIMARY",
    );
    expect(await store.remove(A, two._id.toHexString())).toBe(true);
    expect(await store.remove(A, two._id.toHexString())).toBe(false);
    expect(await store.tenantOfHost("two.acme.com")).toBeUndefined();
    expect(await store.count(A)).toBe(1);
  });

  test("deleteOwnedBy removes a tenant's domains only", async () => {
    await addVerified(A, "one.acme.com");
    await store.add(B, "b.acme.com", null);
    expect(await store.deleteOwnedBy(A)).toBe(1);
    expect(await store.count(A)).toBe(0);
    expect(await store.count(B)).toBe(1);
  });
});

describe("recheckAll", () => {
  const DAY = 24 * 3600_000;

  test("a record still there keeps the domain verified", async () => {
    await addVerified(A, "auth.acme.com");
    expect(await store.recheckAll()).toEqual({ checked: 1, unverified: 0 });
    expect(await store.tenantOfHost("auth.acme.com")).toEqual(A);
  });

  test("a lookup failure changes nothing", async () => {
    await addVerified(A, "auth.acme.com");
    records.set("_clavix.auth.acme.com", { kind: "failed" });
    clock = new Date(clock.getTime() + 30 * DAY);
    expect((await store.recheckAll()).unverified).toBe(0);
    expect(await store.tenantOfHost("auth.acme.com")).toEqual(A);
  });

  test("a missing record lapses only after the 7-day grace, then tells once", async () => {
    await addVerified(A, "auth.acme.com");
    records.clear();
    const told: string[] = [];
    const tell = async (d: { host: string }) => {
      told.push(d.host);
    };
    await store.recheckAll(tell);
    clock = new Date(clock.getTime() + (RECHECK_GRACE_DAYS - 1) * DAY);
    await store.recheckAll(tell);
    expect(told).toEqual([]);
    expect(await store.verifiedHostsOf(A)).toEqual(["auth.acme.com"]);
    clock = new Date(clock.getTime() + 2 * DAY);
    expect((await store.recheckAll(tell)).unverified).toBe(1);
    expect(told).toEqual(["auth.acme.com"]);
    expect(await store.verifiedHostsOf(A)).toEqual([]);
    await store.recheckAll(tell);
    expect(told).toHaveLength(1);
  });

  test("the record coming back resets the grace", async () => {
    const claim = await addVerified(A, "auth.acme.com");
    records.clear();
    await store.recheckAll();
    publish("auth.acme.com", claim.txtToken);
    await store.recheckAll();
    const stored = await collection.findById(claim._id);
    expect(stored?.failingSince).toBeNull();
  });

  test("a lapsed primary keeps its flag and still resolves its host", async () => {
    const claim = await addVerified(A, "auth.acme.com");
    await store.setPrimary(A, claim._id.toHexString());
    records.clear();
    await store.recheckAll();
    clock = new Date(clock.getTime() + 8 * DAY);
    await store.recheckAll();
    expect(await store.primaryHostOf(A)).toBe("auth.acme.com");
    expect(await store.tenantOfHost("auth.acme.com")).toEqual(A);
    expect(await store.verifiedHostsOf(A)).toEqual([]);
  });
});
