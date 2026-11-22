import { afterEach, describe, expect, test } from "bun:test";
import { connectionsHarness } from "~/connections-service";
import { defined } from "~/narrow";
import { txtNameOf } from "../utils";

const { service, state, input, codeOf, reset, A } = connectionsHarness();

afterEach(reset);

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
    expect(state.asked).toEqual([txtNameOf("acme.test")]);
    // Cooldown: checked a moment ago.
    expect(await codeOf(service.verifyDomain(A, "acme", "acme.test"))).toBe(
      "VERIFY_COOLDOWN",
    );
    state.clock = new Date(state.clock.getTime() + 61_000);
    // A record with another token does not verify.
    state.txt = { kind: "records", values: ["clavix-verify=other"] };
    expect((await service.verifyDomain(A, "acme", "acme.test")).verified).toBe(
      false,
    );
    state.clock = new Date(state.clock.getTime() + 61_000);
    state.txt = {
      kind: "records",
      values: [defined(entry, "the domain").txtToken],
    };
    const done = await service.verifyDomain(A, "acme", "acme.test");
    expect(done.verified).toBe(true);
    expect(done.connection.domains[0]?.verifiedAt).toEqual(state.clock);
  });

  test("a domain the connection does not hold is not found", async () => {
    await service.create(A, input(), null);
    expect(await codeOf(service.verifyDomain(A, "acme", "none.test"))).toBe(
      "NOT_FOUND",
    );
  });

  test("a connection holds a bounded number of domains", async () => {
    await service.create(A, input(), null);
    let code = "ok";
    for (let i = 0; i < 30 && code === "ok"; i += 1) {
      code = await codeOf(service.addDomain(A, "acme", `d${i}.test`));
    }
    expect(code).toBe("BAD_USER_INPUT");
  });

  test("verifyDomain and removeDomain normalise the domain as the claim does", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "Acme.Test");
    expect(added.domains[0]?.domain).toBe("acme.test");
    state.txt = {
      kind: "records",
      values: [defined(added.domains[0], "the domain").txtToken],
    };
    const out = await service.verifyDomain(A, "acme", "  ACME.test ");
    expect(out.verified).toBe(true);
    const after = await service.removeDomain(A, "acme", " Acme.TEST");
    expect(after.domains).toEqual([]);
  });

  test("removing a domain drops it, and one never held changes nothing", async () => {
    await service.create(A, input(), null);
    await service.addDomain(A, "acme", "acme.test");
    const same = await service.removeDomain(A, "acme", "other.test");
    expect(same.domains).toHaveLength(1);
    const after = await service.removeDomain(A, "acme", "acme.test");
    expect(after.domains).toEqual([]);
  });
});
