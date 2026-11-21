import { afterEach, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerClient } from "@/modules/clients/register-client";
import { parseTenantArgs } from "./tenants.cli";
import { TenantInputError } from "./tenants.errors";
import { PLATFORM_TENANT_SLUG, RESERVED_SLUGS } from "./tenants.rules";
import { TenantsService } from "./tenants.service";
import { partitionOf } from "./tenants.utils";

const collection = mongo.db.tenants;
const created: string[] = [];
const service = new TenantsService(collection, {
  domain: "clavix.test",
  onCreated: (id) => {
    created.push(id);
  },
});

afterEach(async () => {
  created.length = 0;
  await collection.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } });
});

describe("parseTenantArgs", () => {
  test("reads the flags", () => {
    expect(
      parseTenantArgs(["--slug", "acme", "--name", "Acme", "--sign-up"]),
    ).toEqual({ slug: "acme", name: "Acme", signUp: true });
    expect(parseTenantArgs(["--slug", "acme", "--name", "Acme"])).toEqual({
      slug: "acme",
      name: "Acme",
    });
  });

  test("refuses a missing flag or an unknown one", () => {
    expect(() => parseTenantArgs(["--name", "Acme"])).toThrow(TenantInputError);
    expect(() => parseTenantArgs(["--slug", "acme"])).toThrow(TenantInputError);
    expect(() =>
      parseTenantArgs(["--slug", "acme", "--name", "A", "--nope"]),
    ).toThrow(TenantInputError);
  });
});

describe("TenantsService.register", () => {
  test("creates an active, closed tenant and gives it its first key hook", async () => {
    const result = await service.register({
      slug: "acme",
      name: " Acme ",
    });
    expect(result).toMatchObject({
      created: true,
      slug: "acme",
      name: "Acme",
      status: "active",
      signUp: false,
    });
    expect(created).toEqual([result.tenantId]);
    const stored = await collection.findFirst({ slug: "acme" });
    expect(stored && partitionOf(stored._id)).toBe(result.tenantId);
  });

  test("a re-run with the same name creates nothing; another name is refused", async () => {
    const first = await service.register({ slug: "acme", name: "Acme" });
    const again = await service.register({ slug: "acme", name: "Acme" });
    expect(again).toMatchObject({ created: false, tenantId: first.tenantId });
    expect(created).toEqual([first.tenantId]);
    await expect(
      service.register({ slug: "acme", name: "Other" }),
    ).rejects.toThrow(/already exists/);
    await expect(
      service.register({ slug: "acme", name: "Acme", signUp: true }),
    ).rejects.toThrow(/already exists/);
    expect(await collection.raw.countDocuments({ slug: "acme" })).toBe(1);
  });

  test("refuses invalid and reserved slugs with the module's own rules", async () => {
    for (const slug of ["A", "x", "-ab", "has space", ...RESERVED_SLUGS]) {
      await expect(service.register({ slug, name: "N" })).rejects.toThrow(
        TenantInputError,
      );
    }
    await expect(service.register({ slug: "ok", name: " " })).rejects.toThrow(
      TenantInputError,
    );
    expect(
      await collection.raw.countDocuments({ slug: { $ne: "clavix" } }),
    ).toBe(0);
  });

  test("a deleted tenant's slug stays reserved", async () => {
    const first = await service.register({ slug: "gone", name: "Gone" });
    await service.delete(first.tenantId);
    await expect(
      service.register({ slug: "gone", name: "Gone" }),
    ).rejects.toThrow(/deleted tenant/);
    expect(await collection.raw.countDocuments({ slug: "gone" })).toBe(1);
  });
});

describe("isolation between tenants", () => {
  test("a tenant created by script has its own partition: nothing of another tenant is in it", async () => {
    const a = await service.register({ slug: "isoa", name: "A" });
    const b = await service.register({ slug: "isob", name: "B" });
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.slug).not.toBe(b.slug);

    const findTenant = (slug: string) => collection.findFirst({ slug });
    await registerClient(
      { db: oauthDb, findTenant },
      { tenant: "isoa", name: "App", redirectUris: ["https://a.example/cb"] },
    );
    const storeOf = (tenantId: string) =>
      createMongoOAuth(oauthDb, { partition: tenantId });
    expect(await storeOf(a.tenantId).findClient("app")).not.toBeNull();
    expect(await storeOf(b.tenantId).findClient("app")).toBeNull();

    // A's slug cannot be taken over through a registration on B's name.
    await expect(service.register({ slug: "isoa", name: "B" })).rejects.toThrow(
      TenantInputError,
    );
    expect((await findTenant("isoa"))?.name).toBe("A");
  });
});
