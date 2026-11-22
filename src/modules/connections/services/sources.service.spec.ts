import { afterEach, describe, expect, test } from "bun:test";
import { connectionsHarness } from "~/connections-service";
import { defined } from "~/narrow";

const { collection, box, service, state, input, verified, reset, A, B } =
  connectionsHarness();

afterEach(reset);

describe("the janus source", () => {
  test("a verified domain is reached through the source, an unverified one is not", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "acme.test");
    const source = service.sourceOf(A);
    expect(await source.findConnection("acme")).toBeNull();
    expect(await source.findConnectionByDomain("acme.test")).toBeNull();
    state.txt = {
      kind: "records",
      values: [defined(added.domains[0], "the domain").txtToken],
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
    await verified(A);
    // Sealed for another connection id: the context no longer matches.
    await collection.raw.updateMany(
      {},
      { $set: { secret: box.seal("x", "other-context") } },
    );
    expect(await service.sourceOf(A).findConnection("acme")).toBeNull();
    expect(state.logged.join("\n")).not.toContain("s3cr3t-value");
    expect(state.logged.join("\n")).toContain("acme");
  });

  test("isOffered is the same predicate as the source", async () => {
    const created = await service.create(A, input(), null);
    expect(service.isOffered(A, created)).toBe(false);
    await verified(A);
    expect(
      service.isOffered(A, defined(await service.find(A, "acme"), "it")),
    ).toBe(true);
  });
});

describe("the single sign-on gates", () => {
  test("an address of a verified domain requires sso, another does not", async () => {
    await service.create(A, input(), null);
    expect(await service.requiresSso(A, "ada@acme.test")).toBe(false);
    await verified(A);
    expect(await service.requiresSso(A, "ada@acme.test")).toBe(true);
    expect(await service.requiresSso(A, "ada@other.test")).toBe(false);
    expect(await service.requiresSso(A, "not-an-address")).toBe(false);
    expect(await service.requiresSso(B, "ada@acme.test")).toBe(false);
    await service.update(A, "acme", { requireSso: false });
    expect(await service.requiresSso(A, "ada@acme.test")).toBe(false);
  });

  test("jit is read on every call, so turning it off is at once", async () => {
    await service.create(A, input(), null);
    expect(await service.jitAllowed(A, "acme")).toBe(true);
    await service.update(A, "acme", { jit: false });
    expect(await service.jitAllowed(A, "acme")).toBe(false);
    expect(await service.jitAllowed(A, "none")).toBe(false);
    await service.update(A, "acme", { jit: true, enabled: false });
    expect(await service.jitAllowed(A, "acme")).toBe(false);
  });
});
