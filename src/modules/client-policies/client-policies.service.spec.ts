import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { clientPoliciesService as service } from "@/config/client-policies";
import { mongo } from "@/config/db";
import type { TokenExchangeRules } from "./client-policies.model";

// Tenant ids of their own: the service reads and writes through the scope, so
// no tenant document is needed.
const tenant = new ObjectId();
const other = new ObjectId();

const rules = (over: Partial<TokenExchangeRules> = {}): TokenExchangeRules => ({
  targetResources: ["https://api.test/a"],
  subjectClients: ["c-1"],
  subjectAgents: false,
  mode: "delegation",
  ...over,
});

afterAll(async () => {
  for (const tenantId of [tenant, other]) {
    await mongo.db.clientPolicies.raw.deleteMany({ tenantId });
  }
});

describe("client policies", () => {
  test("a client with no rule has none, and a first write creates it", async () => {
    expect(await service.tokenExchange(tenant, "svc-new")).toBeNull();
    await service.setTokenExchange(tenant, "svc-new", rules());
    expect(await service.tokenExchange(tenant, "svc-new")).toEqual(rules());
    // A second write replaces the rules, it does not add a document.
    await service.setTokenExchange(
      tenant,
      "svc-new",
      rules({ subjectClients: "any" }),
    );
    expect(
      (await service.tokenExchange(tenant, "svc-new"))?.subjectClients,
    ).toBe("any");
    expect(
      await mongo.db.clientPolicies.raw.countDocuments({
        tenantId: tenant,
        clientId: "svc-new",
      }),
    ).toBe(1);
  });

  test("a rule of one tenant is never read for another", async () => {
    await service.setTokenExchange(tenant, "svc-iso", rules());
    expect(await service.tokenExchange(other, "svc-iso")).toBeNull();
    expect((await service.tokenExchangeOf(other, ["svc-iso"])).size).toBe(0);
    expect(await service.deleteForClient(other, "svc-iso")).toBe(false);
    expect(await service.tokenExchange(tenant, "svc-iso")).not.toBeNull();
  });

  test("tokenExchangeOf reads many clients at once and skips the ones with none", async () => {
    expect((await service.tokenExchangeOf(tenant, [])).size).toBe(0);
    await service.setTokenExchange(tenant, "svc-m1", rules());
    const found = await service.tokenExchangeOf(tenant, ["svc-m1", "svc-none"]);
    expect([...found.keys()]).toEqual(["svc-m1"]);
  });

  test("two first writes that race end with one document", async () => {
    await Promise.all([
      service.setTokenExchange(tenant, "svc-race", rules()),
      service.setTokenExchange(
        tenant,
        "svc-race",
        rules({ subjectAgents: true }),
      ),
    ]);
    expect(
      await mongo.db.clientPolicies.raw.countDocuments({
        tenantId: tenant,
        clientId: "svc-race",
      }),
    ).toBe(1);
  });

  test("a rule stored before subjectAgents existed reads as subjectAgents off", async () => {
    // Stored before the field (and its validator entry) existed: the validator
    // only checks writes, so the old document is still there after `db:sync`.
    await mongo.db.clientPolicies.raw.db.collection("clientPolicies").insertOne(
      {
        tenantId: tenant,
        clientId: "svc-legacy",
        createdAt: new Date(),
        updatedAt: new Date(),
        tokenExchange: {
          targetResources: ["https://api.test/a"],
          subjectClients: ["c-1"],
          mode: "delegation",
        },
      },
      { bypassDocumentValidation: true },
    );
    expect(await service.tokenExchange(tenant, "svc-legacy")).toEqual(rules());
    const many = await service.tokenExchangeOf(tenant, ["svc-legacy"]);
    expect(many.get("svc-legacy")?.subjectAgents).toBe(false);
  });

  test("deleteForClient says whether there were rules", async () => {
    await service.setTokenExchange(tenant, "svc-del", rules());
    expect(await service.deleteForClient(tenant, "svc-del")).toBe(true);
    expect(await service.deleteForClient(tenant, "svc-del")).toBe(false);
  });

  test("removeTarget drops a resource URI from the rules that target it", async () => {
    await service.setTokenExchange(
      tenant,
      "svc-t1",
      rules({ targetResources: ["https://api.test/rm-a"] }),
    );
    await service.setTokenExchange(
      tenant,
      "svc-t2",
      rules({ targetResources: ["https://api.test/b"] }),
    );
    expect(await service.removeTarget(tenant, "https://api.test/rm-a")).toBe(1);
    expect(
      (await service.tokenExchange(tenant, "svc-t1"))?.targetResources,
    ).toEqual([]);
    expect(
      (await service.tokenExchange(tenant, "svc-t2"))?.targetResources,
    ).toEqual(["https://api.test/b"]);
  });

  test("removeSubjectClient drops a client id from lists and leaves 'any' alone", async () => {
    await service.setTokenExchange(
      tenant,
      "svc-s1",
      rules({ subjectClients: ["gone", "kept"] }),
    );
    await service.setTokenExchange(
      tenant,
      "svc-s2",
      rules({ subjectClients: "any" }),
    );
    expect(await service.removeSubjectClient(tenant, "gone")).toBe(1);
    expect(
      (await service.tokenExchange(tenant, "svc-s1"))?.subjectClients,
    ).toEqual(["kept"]);
    expect(
      (await service.tokenExchange(tenant, "svc-s2"))?.subjectClients,
    ).toBe("any");
  });
});
