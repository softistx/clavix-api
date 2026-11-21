import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { agentClientsService as service } from "@/config/agent-clients";
import { mongo } from "@/config/db";

const tenant = new ObjectId().toHexString();
const other = new ObjectId().toHexString();

afterAll(async () => {
  for (const id of [tenant, other]) {
    await mongo.db.agentClients.raw.deleteMany({ tenantId: new ObjectId(id) });
  }
});

describe("AgentsService", () => {
  test("records an agent once and counts by kind within the tenant", async () => {
    await service.record(tenant, { clientId: "a", kind: "dynamic" });
    await service.record(tenant, { clientId: "a", kind: "dynamic" });
    await service.record(tenant, { clientId: "m", kind: "metadata" });
    await service.record(other, { clientId: "z", kind: "dynamic" });
    expect(await service.count(tenant)).toBe(2);
    expect(await service.count(tenant, "dynamic")).toBe(1);
    expect(await service.has(tenant, "a")).toBe(true);
    expect(await service.has(other, "a")).toBe(false);
  });

  test("kinds and registeredAt are bounded by the ids given", async () => {
    expect([...(await service.kinds(tenant)).entries()].sort()).toEqual([
      ["a", "dynamic"],
      ["m", "metadata"],
    ]);
    expect([...(await service.kinds(tenant, ["m", "nope"]))]).toEqual([
      ["m", "metadata"],
    ]);
    expect((await service.kinds(tenant, [])).size).toBe(0);
    expect((await service.registeredAt(tenant, [])).size).toBe(0);
    expect((await service.registeredAt(tenant, ["a"])).get("a")).toBeInstanceOf(
      Date,
    );
  });

  test("registeredBefore lists the older agents, remove forgets one", async () => {
    expect(await service.registeredBefore(tenant, new Date(0))).toEqual([]);
    expect(
      (
        await service.registeredBefore(tenant, new Date(Date.now() + 1000))
      ).sort(),
    ).toEqual(["a", "m"]);
    await service.remove(tenant, "a");
    await service.remove(tenant, "a");
    expect(await service.has(tenant, "a")).toBe(false);
    expect(await service.count(tenant)).toBe(1);
  });
});
