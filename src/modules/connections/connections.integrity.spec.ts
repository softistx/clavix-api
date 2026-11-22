import { afterEach, describe, expect, test } from "bun:test";
import { scopeToTenant } from "@softistx/mongo";
import { connectionsHarness } from "~/connections-service";
import { defined } from "~/narrow";
import {
  assertClaimable,
  assertDomainsFree,
  assertUnlinked,
} from "./connections.integrity";

const { collection, service, input, codeOf, reset, A } = connectionsHarness();

afterEach(reset);

describe("assertDomainsFree", () => {
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

  test("no domain, or only the connection's own, is free", async () => {
    const created = await service.create(A, input(), null);
    const scoped = scopeToTenant(collection, created.tenantId);
    await assertDomainsFree(scoped, created, []);
    await assertDomainsFree(scoped, created, ["acme.test"]);
  });
});

describe("assertUnlinked", () => {
  test("refuses with the given message and field while accounts are linked", async () => {
    const links = async () => 1;
    const refused = assertUnlinked(links, A, "acme", "in use", "issuer");
    expect(await codeOf(refused)).toBe("CONNECTION_IN_USE");
    await assertUnlinked(async () => 0, A, "acme", "in use");
  });
});

describe("assertClaimable", () => {
  test("a domain on the connection is a conflict, one on another is taken", async () => {
    await service.create(A, input(), null);
    const added = await service.addDomain(A, "acme", "acme.test");
    const current = defined(added, "the connection");
    const scoped = scopeToTenant(collection, current.tenantId);
    expect(await codeOf(assertClaimable(scoped, current, "acme.test"))).toBe(
      "CONFLICT",
    );
    const other = defined(
      await service.create(A, input({ id: "other" }), null),
      "the other",
    );
    expect(await codeOf(assertClaimable(scoped, other, "acme.test"))).toBe(
      "DOMAIN_TAKEN",
    );
    expect(await codeOf(assertClaimable(scoped, other, "free.test"))).toBe(
      "ok",
    );
  });
});
