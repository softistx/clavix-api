import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { tenantAdmin, tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "./slug";
import { stateOf } from "./tenants.admin";
import { purgeAtOf } from "./trash.schema";

const clear = () =>
  mongo.db.tenants.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } });
afterEach(clear);

const make = (slug: string, name = `${slug} Inc`) =>
  tenantsService.create({ slug, name });

describe("TenantAdminService", () => {
  test("lists by slug, filters by state and search, and pages with a cursor", async () => {
    await make("acme", "Acme Corp");
    const beta = await make("beta", "Beta Labs");
    const gamma = await make("gamma", "Gamma");
    await tenantsService.suspend(beta._id.toHexString());
    await tenantAdmin.trash(gamma._id.toHexString());

    const slugs = async (o: Parameters<typeof tenantAdmin.list>[0]) =>
      (await tenantAdmin.list(o)).items.map((t) => t.slug);
    expect(await slugs({ first: 50, state: "active" })).toContain("acme");
    expect(await slugs({ first: 50, state: "active" })).not.toContain("beta");
    expect(await slugs({ first: 50, state: "suspended" })).toEqual(["beta"]);
    expect(await slugs({ first: 50, state: "deleted" })).toEqual(["gamma"]);
    expect(await slugs({ first: 50, q: "ac" })).toEqual(["acme"]);
    expect(await slugs({ first: 50, q: "labs" })).toEqual(["beta"]);
    expect(await slugs({ first: 50, q: "a.c" })).toEqual([]); // regex is escaped

    const page = await tenantAdmin.list({ first: 2, state: undefined });
    expect(page.items).toHaveLength(2);
    const rest = await tenantAdmin.list({
      first: 50,
      after: page.nextCursor ?? undefined,
    });
    expect(
      [...page.items, ...rest.items]
        .map((t) => t.slug)
        .filter((s) => s !== PLATFORM_TENANT_SLUG),
    ).toEqual(["acme", "beta", "gamma"]);
  });

  test("update renames and toggles sign-up, and does nothing when nothing changes", async () => {
    const t = await make("acme");
    const renamed = await tenantAdmin.update(t._id, {
      name: " Acme 2 ",
      signUp: true,
    });
    expect(renamed).toMatchObject({ name: "Acme 2", signUp: true });
    const same = await tenantAdmin.update(t._id, {
      name: "Acme 2",
      signUp: true,
    });
    expect(same.version).toBe(renamed.version);
    expect(() => tenantAdmin.update(t._id, { name: "  " })).toThrow(TypeError);
  });

  test("setPlan sets the plan and the overrides, and is idempotent", async () => {
    const t = await make("acme");
    expect(t.plan).toBe("free");
    const pro = await tenantAdmin.setPlan(t._id, {
      plan: "pro",
      quotaOverrides: { mau: 5 },
    });
    expect(pro).toMatchObject({ plan: "pro", quotaOverrides: { mau: 5 } });
    const again = await tenantAdmin.setPlan(t._id, {
      plan: "pro",
      quotaOverrides: { mau: 5 },
    });
    expect(again.version).toBe(pro.version);
  });

  test("trash, restore and the state of a tenant", async () => {
    const t = await make("acme");
    const id = t._id.toHexString();
    await tenantsService.suspend(id);
    const trashed = await tenantAdmin.trash(id);
    expect(stateOf(trashed)).toBe("deleted");
    expect((await tenantAdmin.trash(id)).version).toBe(trashed.version);
    await expect(tenantAdmin.update(id, { name: "x" })).rejects.toThrow();
    expect(await tenantAdmin.visibleByIds([id])).toEqual([]);
    const back = await tenantAdmin.restore(id);
    expect(stateOf(back)).toBe("suspended"); // the status it had
    expect((await tenantAdmin.restore(id)).version).toBe(back.version);
    expect(await tenantAdmin.find("not-an-id")).toBeUndefined();
    await expect(tenantAdmin.get("65f0000000000000000000aa")).rejects.toThrow();
  });

  test("purgeDue and claimPurge follow the 30 days; a claimed tenant cannot be restored", async () => {
    const t = await make("acme");
    const id = t._id.toHexString();
    const trashed = await tenantAdmin.trash(id);
    const due = purgeAtOf(trashed.deletedAt as Date);
    const before = new Date(due.getTime() - 1000);
    expect((await tenantAdmin.purgeDue(before)).map((x) => x.slug)).toEqual([]);
    expect(await tenantAdmin.claimPurge(trashed, before)).toBe(false);
    expect((await tenantAdmin.purgeDue(due)).map((x) => x.slug)).toEqual([
      "acme",
    ]);
    expect(await tenantAdmin.claimPurge(trashed, due)).toBe(true);
    expect(await tenantAdmin.claimPurge(trashed, due)).toBe(true); // a resume
    expect(await tenantAdmin.find(id)).toBeUndefined();
    await expect(tenantAdmin.restore(id)).rejects.toThrow();
    // still due until marked purged
    expect(await tenantAdmin.purgeDue(due)).toHaveLength(1);
    await tenantAdmin.markPurged(trashed, due);
    expect(await tenantAdmin.purgeDue(due)).toEqual([]);
    expect(await tenantAdmin.claimPurge(trashed, due)).toBe(false);
  });

  test("a live tenant is not due", async () => {
    await make("acme");
    expect(await tenantAdmin.purgeDue(new Date("2099-01-01"))).toEqual([]);
  });
});
