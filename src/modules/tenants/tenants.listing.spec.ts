import { afterEach, describe, expect, test } from "bun:test";
import { mongo } from "@/config/db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "./tenants.rules";
import { stateOf } from "./tenants.utils";

const clear = () =>
  mongo.db.tenants.raw.deleteMany({ slug: { $ne: PLATFORM_TENANT_SLUG } });
afterEach(clear);

const make = (slug: string, name = `${slug} Inc`) =>
  tenantsService.create({ slug, name });

describe("TenantsService", () => {
  test("lists by slug, filters by state and search, and pages with a cursor", async () => {
    await make("acme", "Acme Corp");
    const beta = await make("beta", "Beta Labs");
    const gamma = await make("gamma", "Gamma");
    await tenantsService.suspend(beta._id.toHexString());
    await tenantsService.trash(gamma._id.toHexString());

    const slugs = async (o: Parameters<typeof tenantsService.list>[0]) =>
      (await tenantsService.list(o)).items.map((t) => t.slug);
    expect(await slugs({ first: 50, state: "active" })).toContain("acme");
    expect(await slugs({ first: 50, state: "active" })).not.toContain("beta");
    expect(await slugs({ first: 50, state: "suspended" })).toEqual(["beta"]);
    expect(await slugs({ first: 50, state: "deleted" })).toEqual(["gamma"]);
    expect(await slugs({ first: 50, q: "ac" })).toEqual(["acme"]);
    expect(await slugs({ first: 50, q: "labs" })).toEqual(["beta"]);
    expect(await slugs({ first: 50, q: "a.c" })).toEqual([]); // regex is escaped

    const page = await tenantsService.list({ first: 2, state: undefined });
    expect(page.items).toHaveLength(2);
    const rest = await tenantsService.list({
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
    const renamed = await tenantsService.update(t._id, {
      name: " Acme 2 ",
      signUp: true,
    });
    expect(renamed).toMatchObject({ name: "Acme 2", signUp: true });
    const same = await tenantsService.update(t._id, {
      name: "Acme 2",
      signUp: true,
    });
    expect(same.version).toBe(renamed.version);
    expect(() => tenantsService.update(t._id, { name: "  " })).toThrow(
      TypeError,
    );
  });

  test("setPlan sets the plan and the overrides, and is idempotent", async () => {
    const t = await make("acme");
    expect(t.plan).toBe("free");
    const pro = await tenantsService.setPlan(t._id, {
      plan: "pro",
      quotaOverrides: { mau: 5 },
    });
    expect(pro).toMatchObject({ plan: "pro", quotaOverrides: { mau: 5 } });
    const again = await tenantsService.setPlan(t._id, {
      plan: "pro",
      quotaOverrides: { mau: 5 },
    });
    expect(again.version).toBe(pro.version);
  });

  test("trash, restore and the state of a tenant", async () => {
    const t = await make("acme");
    const id = t._id.toHexString();
    await tenantsService.suspend(id);
    const trashed = await tenantsService.trash(id);
    expect(stateOf(trashed)).toBe("deleted");
    expect((await tenantsService.trash(id)).version).toBe(trashed.version);
    await expect(tenantsService.update(id, { name: "x" })).rejects.toThrow();
    expect(await tenantsService.visibleByIds([id])).toEqual([]);
    const back = await tenantsService.restore(id);
    expect(stateOf(back)).toBe("suspended"); // the status it had
    expect((await tenantsService.restore(id)).version).toBe(back.version);
    expect(await tenantsService.find("not-an-id")).toBeUndefined();
    await expect(
      tenantsService.get("65f0000000000000000000aa"),
    ).rejects.toThrow();
  });
});
