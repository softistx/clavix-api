import { afterEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import type { TxtAnswer } from "@/modules/domains/dns";
import { createSecretBox } from "@/modules/sign-in-methods/secrets";
import { QuotaExceededError } from "@/modules/usage/quota";
import { ConnectionError } from "./connections.errors";
import {
  type ConnectionInput,
  ConnectionsService,
  txtNameOf,
} from "./connections.service";

const collection = mongo.db.connections;
const box = createSecretBox(
  crypto.getRandomValues(new Uint8Array(32)),
  "connection-secrets",
);
let clock = new Date("2026-11-18T12:00:00Z");
let txt: TxtAnswer = { kind: "none" };
const asked: string[] = [];
let linked = 0;
const logged: string[] = [];
const service = new ConnectionsService(collection, box, {
  txt: {
    resolveTxt: async (name) => {
      asked.push(name);
      return txt;
    },
  },
  links: async () => linked,
  now: () => clock,
  log: (message) => logged.push(message),
});
const A = new ObjectId().toHexString();
const B = new ObjectId().toHexString();

const input = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
  id: "acme",
  name: "Acme SSO",
  issuer: "https://login.acme.test",
  clientId: "client-1",
  clientSecret: "s3cr3t-value",
  ...over,
});

afterEach(async () => {
  clock = new Date("2026-11-18T12:00:00Z");
  txt = { kind: "none" };
  asked.length = 0;
  linked = 0;
  logged.length = 0;
  await collection.raw.deleteMany({});
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectionError) return error.code;
    if (error instanceof QuotaExceededError) return "QUOTA";
    return String(error);
  }
  return "ok";
};

describe("create", () => {
  test("seals the secret and never stores it in clear", async () => {
    const created = await service.create(A, input(), null);
    expect(created.connectionId).toBe("acme");
    const raw = JSON.stringify(await collection.raw.find({}).toArray());
    expect(raw).not.toContain("s3cr3t-value");
    expect(created.domains).toEqual([]);
  });

  test("refuses what janus's checkConnection refuses, naming no value", async () => {
    for (const over of [
      { issuer: "http://login.acme.test" },
      { idTokenSignedResponseAlg: "HS256" },
      { id: "Acme" },
      { id: "google" },
      { claims: { email: "sub" } },
    ]) {
      expect(await codeOf(service.create(A, input(over), null))).toBe(
        "BAD_USER_INPUT",
      );
    }
    try {
      await service.create(A, input({ issuer: "http://leak.acme.test" }), null);
    } catch (error) {
      expect((error as Error).message).not.toContain("leak.acme.test");
      expect((error as Error).message).not.toContain("s3cr3t-value");
    }
    expect(await collection.raw.countDocuments({})).toBe(0);
  });

  test("an id is taken once per tenant, and the quota counts the tenant's own", async () => {
    await service.create(A, input(), 1);
    expect(await codeOf(service.create(A, input(), 5))).toBe("CONFLICT");
    expect(await codeOf(service.create(A, input({ id: "two" }), 1))).toBe(
      "QUOTA",
    );
    // Another tenant has its own count and its own id space.
    expect(await codeOf(service.create(B, input(), 1))).toBe("ok");
  });
});

describe("tenant isolation", () => {
  test("a connection of A is unknown to B", async () => {
    await service.create(A, input(), null);
    expect(await service.find(B, "acme")).toBeUndefined();
    expect(await service.list(B)).toEqual([]);
    expect(await codeOf(service.update(B, "acme", { name: "x" }))).toBe(
      "NOT_FOUND",
    );
    expect(await service.delete(B, "acme")).toBe(false);
    expect(await service.find(A, "acme")).toBeDefined();
    expect(await service.sourceOf(B).findConnection("acme")).toBeNull();
  });
});

describe("domains", () => {
  test("a claim is normalised, unique in the tenant, and verified by its TXT record", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "ACME.test");
    const [entry] = added.domains;
    expect(entry?.domain).toBe("acme.test");
    expect(entry?.verifiedAt).toBeNull();
    expect(await codeOf(service.addDomain(A, "acme", "acme.test"))).toBe(
      "CONFLICT",
    );
    await service.create(A, input({ id: "other" }), null);
    expect(await codeOf(service.addDomain(A, "other", "acme.test"))).toBe(
      "DOMAIN_TAKEN",
    );
    expect(await codeOf(service.addDomain(A, "acme", "not a domain"))).toBe(
      "BAD_USER_INPUT",
    );

    // Not published yet.
    const miss = await service.verifyDomain(A, "acme", "acme.test");
    expect(miss.verified).toBe(false);
    expect(asked).toEqual([txtNameOf("acme.test")]);
    // Cooldown: checked a moment ago.
    expect(await codeOf(service.verifyDomain(A, "acme", "acme.test"))).toBe(
      "VERIFY_COOLDOWN",
    );
    clock = new Date(clock.getTime() + 61_000);
    // A record with another token does not verify.
    txt = { kind: "records", values: ["clavix-verify=other"] };
    expect((await service.verifyDomain(A, "acme", "acme.test")).verified).toBe(
      false,
    );
    clock = new Date(clock.getTime() + 61_000);
    txt = { kind: "records", values: [entry?.txtToken as string] };
    const done = await service.verifyDomain(A, "acme", "acme.test");
    expect(done.verified).toBe(true);
    expect(done.connection.domains[0]?.verifiedAt).toEqual(clock);
  });

  test("a verified domain is reached through the source, an unverified one is not", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "acme.test");
    const source = service.sourceOf(A);
    expect(await source.findConnection("acme")).toBeNull();
    expect(await source.findConnectionByDomain("acme.test")).toBeNull();
    txt = {
      kind: "records",
      values: [added.domains[0]?.txtToken as string],
    };
    await service.verifyDomain(A, "acme", "acme.test");
    const found = await source.findConnectionByDomain("acme.test");
    expect(found?.id).toBe("acme");
    expect(found?.client.secret).toBe("s3cr3t-value");
    expect(found?.domains).toEqual(["acme.test"]);
    expect((await source.findConnection("acme"))?.issuer).toBe(
      "https://login.acme.test",
    );
    // Off, or in another tenant: nothing answers.
    expect(
      await service.sourceOf(B).findConnectionByDomain("acme.test"),
    ).toBeNull();
    await service.update(A, "acme", { enabled: false });
    expect(await source.findConnection("acme")).toBeNull();
    expect(await source.findConnectionByDomain("acme.test")).toBeNull();
  });

  test("a secret that cannot be opened is not offered, and nothing is logged of it", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "acme.test");
    txt = { kind: "records", values: [added.domains[0]?.txtToken as string] };
    await service.verifyDomain(A, "acme", "acme.test");
    // Sealed for another connection id: the context no longer matches.
    await collection.raw.updateMany(
      {},
      { $set: { secret: box.seal("x", "other-context") } },
    );
    expect(await service.sourceOf(A).findConnection("acme")).toBeNull();
    expect(logged.join("\n")).not.toContain("s3cr3t-value");
  });

  test("removing a domain drops it", async () => {
    await service.create(A, input(), null);
    await service.addDomain(A, "acme", "acme.test");
    const after = await service.removeDomain(A, "acme", "acme.test");
    expect(after.domains).toEqual([]);
  });
});

describe("update, secret and delete", () => {
  test("the issuer and the delete are refused while accounts are linked", async () => {
    await service.create(A, input(), null);
    linked = 2;
    expect(
      await codeOf(
        service.update(A, "acme", { issuer: "https://other.acme.test" }),
      ),
    ).toBe("CONNECTION_IN_USE");
    expect(await codeOf(service.delete(A, "acme"))).toBe("CONNECTION_IN_USE");
    // The rest may change.
    const renamed = await service.update(A, "acme", { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.revision).toBe(2);
    linked = 0;
    expect(await service.delete(A, "acme")).toBe(true);
    expect(await service.delete(A, "acme")).toBe(false);
  });

  test("a new secret replaces the sealed one", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "acme.test");
    txt = { kind: "records", values: [added.domains[0]?.txtToken as string] };
    await service.verifyDomain(A, "acme", "acme.test");
    await service.setSecret(A, "acme", "brand-new-secret");
    const found = await service.sourceOf(A).findConnection("acme");
    expect(found?.client.secret).toBe("brand-new-secret");
    expect(
      JSON.stringify(await collection.raw.find({}).toArray()),
    ).not.toContain("brand-new-secret");
  });

  test("two enabled connections never hold one domain: switching one on is refused", async () => {
    await service.create(A, input(), null);
    await service.addDomain(A, "acme", "acme.test");
    await service.update(A, "acme", { enabled: false });
    await service.create(A, input({ id: "other" }), null);
    await collection.raw.updateOne(
      { connectionId: "other" },
      {
        $set: {
          domains: [
            {
              domain: "acme.test",
              txtToken: "t",
              verifiedAt: null,
              checkedAt: null,
            },
          ],
        },
      },
    );
    expect(await codeOf(service.update(A, "acme", { enabled: true }))).toBe(
      "DOMAIN_TAKEN",
    );
  });
});

describe("the iss response parameter (RFC 9207, IdP mix-up)", () => {
  const advertised = new Map<string, boolean | Error>();
  const pinning = new ConnectionsService(collection, box, {
    txt: { resolveTxt: async () => txt },
    links: async () => 0,
    advertisesIss: async (issuer) => {
      const answer = advertised.get(issuer) ?? false;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => clock,
  });
  const verified = async (id: string) => {
    const added = await pinning.addDomain(A, id, `${id}.test`);
    txt = { kind: "records", values: [added.domains[0]?.txtToken as string] };
    await pinning.verifyDomain(A, id, `${id}.test`);
  };

  afterEach(() => advertised.clear());

  test("an issuer that advertises it is pinned: the record the library reads requires iss", async () => {
    advertised.set("https://login.acme.test", true);
    expect((await pinning.create(A, input(), null)).requireIss).toBe(true);
    await verified("acme");
    const record = await pinning.sourceOf(A).findConnection("acme");
    expect(record?.requireIssParameter).toBe(true);
  });

  test("an issuer that does not advertise it, or cannot be read, is not pinned", async () => {
    expect((await pinning.create(A, input(), null)).requireIss).toBe(false);
    advertised.set("https://login.down.test", new Error("unreachable"));
    const down = await pinning.create(
      A,
      input({ id: "down", issuer: "https://login.down.test" }),
      null,
    );
    expect(down.requireIss).toBe(false);
    await verified("down");
    const record = await pinning.sourceOf(A).findConnection("down");
    expect(record?.requireIssParameter).toBeUndefined();
  });

  test("a new issuer is probed again, an unchanged one keeps its pin", async () => {
    advertised.set("https://login.acme.test", true);
    await pinning.create(A, input(), null);
    advertised.set("https://login.acme.test", false);
    const renamed = await pinning.update(A, "acme", { name: "Acme" });
    expect(renamed.requireIss).toBe(true);
    const moved = await pinning.update(A, "acme", {
      issuer: "https://login.other.test",
    });
    expect(moved.requireIss).toBe(false);
  });
});
