import { afterEach, describe, expect, test } from "bun:test";
import { connectionsHarness } from "~/connections-service";
import { instance } from "~/narrow";

const {
  collection,
  box,
  records,
  sources,
  state,
  input,
  codeOf,
  verified,
  reset,
  A,
  B,
} = connectionsHarness();

afterEach(reset);

describe("create", () => {
  test("seals the secret and never stores it in clear", async () => {
    const created = await records.create(A, input(), null);
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
      expect(await codeOf(records.create(A, input(over), null))).toBe(
        "BAD_USER_INPUT",
      );
    }
    try {
      await records.create(A, input({ issuer: "http://leak.acme.test" }), null);
    } catch (error) {
      const { message } = instance(error, Error);
      expect(message).not.toContain("leak.acme.test");
      expect(message).not.toContain("s3cr3t-value");
    }
    expect(await collection.raw.countDocuments({})).toBe(0);
  });

  test("an id is taken once per tenant, and the quota counts the tenant's own", async () => {
    await records.create(A, input(), 1);
    expect(await codeOf(records.create(A, input(), 5))).toBe("CONFLICT");
    expect(await codeOf(records.create(A, input({ id: "two" }), 1))).toBe(
      "QUOTA",
    );
    // Another tenant has its own count and its own id space.
    expect(await codeOf(records.create(B, input(), 1))).toBe("ok");
  });
});

describe("reads", () => {
  test("a connection of A is unknown to B", async () => {
    await records.create(A, input(), null);
    expect(await records.find(B, "acme")).toBeUndefined();
    expect(await records.list(B)).toEqual([]);
    expect(await records.count(B)).toBe(0);
    expect(await codeOf(records.update(B, "acme", { name: "x" }))).toBe(
      "NOT_FOUND",
    );
    expect(await records.delete(B, "acme")).toBe(false);
    expect(await records.find(A, "acme")).toBeDefined();
    expect(await sources.sourceOf(B).findConnection("acme")).toBeNull();
  });

  test("the list is oldest first and counted", async () => {
    await records.create(A, input({ id: "one" }), null);
    await records.create(A, input({ id: "two" }), null);
    expect((await records.list(A)).map((doc) => doc.connectionId)).toEqual([
      "one",
      "two",
    ]);
    expect(await records.count(A)).toBe(2);
  });
});

describe("update and delete", () => {
  test("the issuer and the delete are refused while accounts are linked", async () => {
    await records.create(A, input(), null);
    state.linked = 2;
    expect(
      await codeOf(
        records.update(A, "acme", { issuer: "https://other.acme.test" }),
      ),
    ).toBe("CONNECTION_IN_USE");
    expect(await codeOf(records.delete(A, "acme"))).toBe("CONNECTION_IN_USE");
    // The rest may change.
    const renamed = await records.update(A, "acme", { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.revision).toBe(2);
    state.linked = 0;
    expect(await records.delete(A, "acme")).toBe(true);
    expect(await records.delete(A, "acme")).toBe(false);
  });

  test("an update never opens the secret: a rename works under a dropped key", async () => {
    await records.create(A, input(), null);
    await collection.raw.updateMany(
      {},
      { $set: { secret: box.seal("x", "other-context") } },
    );
    const renamed = await records.update(A, "acme", { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    const scopes = await records.update(A, "acme", { scopes: ["openid"] });
    expect(scopes.scopes).toEqual(["openid"]);
  });

  test("a patch clears an optional field with null and keeps the rest", async () => {
    await records.create(
      A,
      input({ scopes: ["openid"], clientAuthentication: "basic" }),
      null,
    );
    const cleared = await records.update(A, "acme", {
      scopes: null,
      clientAuthentication: null,
    });
    expect(cleared.scopes).toBeNull();
    expect(cleared.clientAuthentication).toBeNull();
    expect(cleared.clientId).toBe("client-1");
  });
});

describe("the iss response parameter (RFC 9207, IdP mix-up)", () => {
  test("an issuer that advertises it is pinned: the record the library reads requires iss", async () => {
    state.advertised.set("https://login.acme.test", true);
    expect((await records.create(A, input(), null)).requireIss).toBe(true);
    await verified(A);
    const record = await sources.sourceOf(A).findConnection("acme");
    expect(record?.requireIssParameter).toBe(true);
  });

  test("an issuer that does not advertise it, or cannot be read, is not pinned", async () => {
    expect((await records.create(A, input(), null)).requireIss).toBe(false);
    state.advertised.set("https://login.down.test", new Error("unreachable"));
    const down = await records.create(
      A,
      input({ id: "down", issuer: "https://login.down.test" }),
      null,
    );
    expect(down.requireIss).toBe(false);
    await verified(A, "down", "down.test");
    const record = await sources.sourceOf(A).findConnection("down");
    expect(record?.requireIssParameter).toBeUndefined();
  });

  test("a new issuer is probed again, an unchanged one keeps its pin", async () => {
    state.advertised.set("https://login.acme.test", true);
    await records.create(A, input(), null);
    state.advertised.set("https://login.acme.test", false);
    const renamed = await records.update(A, "acme", { name: "Acme" });
    expect(renamed.requireIss).toBe(true);
    const moved = await records.update(A, "acme", {
      issuer: "https://login.other.test",
    });
    expect(moved.requireIss).toBe(false);
  });
});
