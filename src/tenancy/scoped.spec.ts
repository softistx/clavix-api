import { beforeEach, describe, expect, test } from "bun:test";
import {
  getCollection,
  InvalidCursorError,
  NotFoundError,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { tenants } from "@/modules/collections";
import { clearDatabase } from "~/db";
import { notes } from "~/notes";
import { scoped } from "./scoped";

const collection = getCollection(mongo.db, notes, { autoSync: true });

const tenantA = new ObjectId();
const tenantB = new ObjectId();
const a = scoped(collection, tenantA);
const b = scoped(collection, tenantB);

beforeEach(clearDatabase);

describe("scoped types", () => {
  test("a collection without tenantId cannot be scoped", () => {
    const placeholder = getCollection(mongo.db, tenants);
    // @ts-expect-error `tenants` is not TenantOwned
    const bad = () => scoped(placeholder, tenantA);
    expect(bad).toBeFunction();
  });

  test("a tenantId in a create or update argument is a type error", () => {
    // @ts-expect-error the scope sets tenantId
    const create = () => a.create({ text: "x", tenantId: tenantB });
    // @ts-expect-error tenantId is immutable
    const update = () => a.update(new ObjectId(), { tenantId: tenantB });
    expect([create, update]).toHaveLength(2);
  });
});

describe("scoped", () => {
  test("create stamps the scope's tenant", async () => {
    const note = await a.create({ text: "A1" });
    expect(note.tenantId).toEqual(tenantA);
  });

  test("reads see their own tenant's documents only", async () => {
    await a.create({ text: "A1" });
    await a.create({ text: "A2" });
    await b.create({ text: "B1" });
    expect((await a.findMany()).map((n) => n.text).sort()).toEqual([
      "A1",
      "A2",
    ]);
    expect(await b.count()).toBe(1);
    expect(await b.exists({ text: "A1" })).toBe(false);
    expect(await b.findFirst({ text: "A1" })).toBeUndefined();
    const page = await b.paginateByCursor({ limit: 10 });
    expect(page.items.map((n) => n.text)).toEqual(["B1"]);
  });

  test("a cursor is bound to its tenant", async () => {
    await a.create({ text: "A1" });
    await a.create({ text: "A2" });
    await b.create({ text: "B1" });
    await b.create({ text: "B2" });
    const first = await a.paginateByCursor({ limit: 1 });
    const cursor = first.nextCursor ?? undefined;
    expect(cursor).toBeTruthy();
    const next = await a.paginateByCursor({ limit: 1, after: cursor });
    expect(next.items).toHaveLength(1);
    await expect(
      b.paginateByCursor({ limit: 1, after: cursor }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  test("a filter naming another tenant cannot widen the scope", async () => {
    await a.create({ text: "A1" });
    expect(await b.findMany({ filter: { tenantId: tenantA } })).toEqual([]);
  });

  test("another tenant's document is not found by id", async () => {
    const note = await a.create({ text: "A1" });
    expect(await b.findById(note._id)).toBeUndefined();
    expect(await b.findById(note.id)).toBeUndefined();
    await expect(b.getById(note._id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await a.getById(note.id)).text).toBe("A1");
  });

  test("another tenant cannot update or delete a document", async () => {
    const note = await a.create({ text: "A1" });
    await expect(
      b.update(note._id, { text: "hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(b.delete(note._id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await a.getById(note._id)).text).toBe("A1");
  });

  test("update and delete work within the tenant; delete is soft", async () => {
    const note = await a.create({ text: "A1" });
    expect((await a.update(note._id, { text: "A1'" })).text).toBe("A1'");
    await a.delete(note._id);
    expect(await a.findById(note._id)).toBeUndefined();
    expect(
      (await a.findById(note._id, { withDeleted: true }))?.deletedAt,
    ).toBeInstanceOf(Date);
  });
});

describe("scoped writes never move a document to another tenant", () => {
  test("a tenantId in a patch is refused, as a field or under an operator", async () => {
    const note = await a.create({ text: "A1" });
    const smuggled = { text: "x", tenantId: tenantB };
    await expect(a.update(note._id, smuggled)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      a.update(note._id, { $set: { tenantId: tenantB } } as never),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      a.update(note._id, { $unset: { tenantId: "" } } as never),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      a.update(note._id, { $rename: { text: "tenantId" } } as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await a.getById(note._id)).tenantId).toEqual(tenantA);
    expect(await b.findById(note._id)).toBeUndefined();
  });

  test("an operator patch without tenantId works", async () => {
    const note = await a.create({ text: "A1" });
    expect((await a.update(note._id, { $set: { text: "A2" } })).text).toBe(
      "A2",
    );
  });

  test("restore brings back an archived document of the tenant only", async () => {
    const note = await a.create({ text: "A1" });
    await a.delete(note._id);
    await expect(b.restore(note._id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await a.findById(note._id)).toBeUndefined();
    const restored = await a.restore(note._id);
    expect(restored.deletedAt).toBeNull();
    expect((await a.findById(note._id))?.text).toBe("A1");
  });

  test("updateMany patches within the tenant, archived ones on request", async () => {
    const live = await a.create({ text: "same" });
    const archived = await a.create({ text: "same" });
    await a.delete(archived._id);
    await b.create({ text: "same" });
    expect(await a.updateMany({ text: "same" }, { text: "x" })).toBe(1);
    expect((await a.getById(live._id)).text).toBe("x");
    const onArchived = { _id: archived._id };
    const withDeleted = { withDeleted: true };
    const before = await a.findById(archived._id, withDeleted);
    expect(
      await a.updateMany(onArchived, { $addToSet: { tags: "t" } }, withDeleted),
    ).toBe(1);
    const tagged = await a.findById(archived._id, withDeleted);
    expect(tagged?.tags).toEqual(["t"]);
    // Bookkeeping: no stamp is written.
    expect(tagged?.updatedAt).toEqual(before?.updatedAt);
    expect(
      await a.updateMany(onArchived, { $pull: { tags: "t" } }, withDeleted),
    ).toBe(1);
    expect((await a.findById(archived._id, withDeleted))?.tags).toEqual([]);
    expect(await b.count({ text: "same" })).toBe(1);
    await expect(
      a.updateMany({ text: "x" }, { $set: { tenantId: tenantB } } as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("updateMany withDeleted takes $addToSet and $pull only", async () => {
    const note = await a.create({ text: "A1" });
    for (const patch of [{ $set: { text: "y" } }, { text: "y" }, {}]) {
      await expect(
        a.updateMany({ _id: note._id }, patch, { withDeleted: true }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect((await a.getById(note._id)).text).toBe("A1");
  });

  test("deleteMany deletes within the tenant only", async () => {
    await a.create({ text: "same" });
    await b.create({ text: "same" });
    expect(await a.deleteMany({ text: "same" })).toBe(1);
    expect(await b.count({ text: "same" })).toBe(1);
  });

  test("createMany stamps the scope's tenant on each document", async () => {
    const made = await a.createMany([{ text: "one" }, { text: "two" }]);
    expect(made.map((n) => n.tenantId)).toEqual([tenantA, tenantA]);
    expect(await a.count()).toBe(2);
    expect(await b.count()).toBe(0);
    expect(await a.createMany([])).toEqual([]);
  });

  test("hardDeleteMany removes for good, archived ones included, within the tenant only", async () => {
    const live = await a.create({ text: "gone" });
    const archived = await a.create({ text: "gone" });
    await a.delete(archived._id);
    await b.create({ text: "gone" });
    expect(await a.hardDeleteMany({ text: "gone" })).toBe(2);
    expect(await a.findById(live._id, { withDeleted: true })).toBeUndefined();
    expect(
      await a.findById(archived._id, { withDeleted: true }),
    ).toBeUndefined();
    expect(await b.count({ text: "gone" })).toBe(1);
  });
});
