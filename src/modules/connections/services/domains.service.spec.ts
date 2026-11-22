import { afterEach, describe, expect, test } from "bun:test";
import { connectionsHarness } from "~/connections-service";
import { defined } from "~/narrow";
import { txtNameOf } from "../utils";

const { domains, records, state, input, codeOf, reset, A } =
  connectionsHarness();

afterEach(reset);

describe("domains", () => {
  test("a claim is normalised, unique in the tenant, and verified by its TXT record", async () => {
    await records.create(A, input(), null);
    const added = await domains.addDomain(A, "acme", "ACME.test");
    const [entry] = added.domains;
    expect(entry?.domain).toBe("acme.test");
    expect(entry?.verifiedAt).toBeNull();
    expect(await codeOf(domains.addDomain(A, "acme", "acme.test"))).toBe(
      "CONFLICT",
    );
    await records.create(A, input({ id: "other" }), null);
    expect(await codeOf(domains.addDomain(A, "other", "acme.test"))).toBe(
      "DOMAIN_TAKEN",
    );
    expect(await codeOf(domains.addDomain(A, "acme", "not a domain"))).toBe(
      "BAD_USER_INPUT",
    );

    // Not published yet.
    const miss = await domains.verifyDomain(A, "acme", "acme.test");
    expect(miss.verified).toBe(false);
    expect(state.asked).toEqual([txtNameOf("acme.test")]);
    // Cooldown: checked a moment ago.
    expect(await codeOf(domains.verifyDomain(A, "acme", "acme.test"))).toBe(
      "VERIFY_COOLDOWN",
    );
    state.clock = new Date(state.clock.getTime() + 61_000);
    // A record with another token does not verify.
    state.txt = { kind: "records", values: ["clavix-verify=other"] };
    expect((await domains.verifyDomain(A, "acme", "acme.test")).verified).toBe(
      false,
    );
    state.clock = new Date(state.clock.getTime() + 61_000);
    state.txt = {
      kind: "records",
      values: [defined(entry, "the domain").txtToken],
    };
    const done = await domains.verifyDomain(A, "acme", "acme.test");
    expect(done.verified).toBe(true);
    expect(done.connection.domains[0]?.verifiedAt).toEqual(state.clock);
  });

  test("a domain the connection does not hold is not found", async () => {
    await records.create(A, input(), null);
    expect(await codeOf(domains.verifyDomain(A, "acme", "none.test"))).toBe(
      "NOT_FOUND",
    );
  });

  test("a connection holds a bounded number of domains", async () => {
    await records.create(A, input(), null);
    let code = "ok";
    for (let i = 0; i < 30 && code === "ok"; i += 1) {
      code = await codeOf(domains.addDomain(A, "acme", `d${i}.test`));
    }
    expect(code).toBe("BAD_USER_INPUT");
  });

  test("verifyDomain and removeDomain normalise the domain as the claim does", async () => {
    await records.create(A, input(), null);
    const added = await domains.addDomain(A, "acme", "Acme.Test");
    expect(added.domains[0]?.domain).toBe("acme.test");
    state.txt = {
      kind: "records",
      values: [defined(added.domains[0], "the domain").txtToken],
    };
    const out = await domains.verifyDomain(A, "acme", "  ACME.test ");
    expect(out.verified).toBe(true);
    const after = await domains.removeDomain(A, "acme", " Acme.TEST");
    expect(after.domains).toEqual([]);
  });

  test("removing a domain drops it, and one never held changes nothing", async () => {
    await records.create(A, input(), null);
    await domains.addDomain(A, "acme", "acme.test");
    const same = await domains.removeDomain(A, "acme", "other.test");
    expect(same.domains).toHaveLength(1);
    const after = await domains.removeDomain(A, "acme", "acme.test");
    expect(after.domains).toEqual([]);
  });
});
