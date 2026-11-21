import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { tenantsService } from "@/config/tenancy";
import { defined } from "~/narrow";
import {
  can,
  janusCount,
  janusOf,
  logged,
  ownedCount,
  run,
  seed,
  state,
  useTenantPurgeHooks,
} from "~/tenant-purge";
import { SlugTakenError } from "./tenants.errors";
import { purgeAtOf } from "./tenants.trash";

useTenantPurgeHooks();

describe("the tenant purge", () => {
  test("purges tenant A at purgeAt and leaves tenant B whole", async () => {
    const a = await seed("alpha");
    const b = await seed("bravo");
    await mongo.db.adminEvents.raw.insertOne({
      _id: new ObjectId(),
      actor: "op",
      action: "tenant.delete",
      tenantId: a._id,
      target: { type: "tenant", id: a._id.toHexString() },
      at: new Date(),
      requestId: "r",
    });
    const trashed = await tenantsService.trash(a._id.toHexString());
    const due = purgeAtOf(defined(trashed.deletedAt, "the deletion date"));
    const bBefore = await janusOf(b._id.toHexString());

    expect(await run(due)).toEqual({
      purged: [a._id.toHexString()],
      failed: [],
    });
    // A's partition is empty in every janus collection, with the counts logged.
    expect(await janusCount(a._id.toHexString())).toBe(0);
    expect(logged.join("\n")).toContain('"clients":1');
    expect(logged.join("\n")).toContain('"users":1');
    expect(logged.join("\n")).toContain('"invitations":1');
    expect(logged.join("\n")).toMatch(/"signingKeys":[1-9]/);
    // B's partition is untouched, document for document.
    expect(await janusOf(b._id.toHexString())).toEqual(bBefore);
    // A: documents, roles and platform link gone.
    expect(await ownedCount(a)).toBe(0);
    expect(await can(a, "user-alpha")).toBe(false);
    // B: untouched.
    expect(await ownedCount(b)).toBe(2);
    expect(await can(b, "user-bravo")).toBe(true);
    // The audit trail of A stays.
    expect(
      await mongo.db.adminEvents.raw.countDocuments({ tenantId: a._id }),
    ).toBe(1);
    // The tombstone keeps the slug, and the tenant is gone for everyone.
    const tomb = await mongo.db.tenants.raw.findOne({ _id: a._id });
    expect(tomb).toMatchObject({ slug: "alpha", name: "" });
    expect(tomb?.["purgedAt"]).toBeInstanceOf(Date);
    expect(await tenantsService.find(a._id.toHexString())).toBeUndefined();
    await expect(
      tenantsService.create({ slug: "alpha", name: "again" }),
    ).rejects.toBeInstanceOf(SlugTakenError);
    expect(
      (await tenantsService.list({ first: 50 })).items.map((t) => t.slug),
    ).not.toContain("alpha");
    // A second run finds nothing to do.
    expect(await run(due)).toEqual({ purged: [], failed: [] });
  });
  test("a purge that failed is resumed by the next run, and cannot be restored meanwhile", async () => {
    const a = await seed("alpha");
    const id = a._id.toHexString();
    const trashed = await tenantsService.trash(id);
    const due = purgeAtOf(defined(trashed.deletedAt, "the deletion date"));
    state.failFor = id;
    expect(await run(due)).toEqual({ purged: [], failed: [id] });
    expect(await ownedCount(a)).toBe(2);
    // The OAuth part went before the outage; the users are still there.
    expect(await janusCount(id)).toBeGreaterThan(0);
    // Claimed: it resolves nowhere and cannot be restored.
    await expect(tenantsService.restore(id)).rejects.toThrow();
    state.failFor = undefined;
    expect(await run(due)).toEqual({ purged: [id], failed: [] });
    expect(await ownedCount(a)).toBe(0);
    expect(await janusCount(id)).toBe(0);
  });
});
