import { describe, expect, test } from "bun:test";
import { TenantsService } from "@/modules/tenants";
import { tenantsOver } from "~/oauth-tenants";
import { tenantDoc } from "~/tenant-doc";

describe("tenantsOver", () => {
  test("is a real TenantsService", () => {
    const tenants = tenantsOver({
      liveByIds: async () => [],
      updateOAuth: async () => tenantDoc(),
    });
    expect(tenants).toBeInstanceOf(TenantsService);
  });

  test("answers liveByIds and updateOAuth from the parts", async () => {
    const tenant = tenantDoc();
    const calls: string[] = [];
    const tenants = tenantsOver({
      liveByIds: async (ids) => {
        calls.push(ids.join(","));
        return [tenant];
      },
      updateOAuth: async (_id, change) => {
        calls.push(String(change(tenant)));
        return tenant;
      },
    });
    expect(await tenants.liveByIds(["a", "b"])).toEqual([tenant]);
    expect(await tenants.updateOAuth(tenant._id, () => null)).toBe(tenant);
    expect(calls).toEqual(["a,b", "null"]);
  });
});
