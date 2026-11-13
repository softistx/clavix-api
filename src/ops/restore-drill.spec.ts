import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mongo } from "@/config/db";
import { env } from "@/config/env";

// The restore drill (docs/operations.md, "Restore drill"): dump the test
// database with scripts/mongo-backup.sh, restore the archive into a scratch
// database with scripts/mongo-restore.sh, and compare. It needs the MongoDB
// database tools (mongodump, mongorestore) on the PATH, or MONGODUMP and
// MONGORESTORE pointing at them; without them it is skipped, never faked.
const dumpBin = Bun.env["MONGODUMP"] ?? "mongodump";
const restoreBin = Bun.env["MONGORESTORE"] ?? "mongorestore";
const hasTools = Bun.which(dumpBin) !== null && Bun.which(restoreBin) !== null;

const SCRATCH = "clavix-test-drill";
const out = mkdtempSync(join(tmpdir(), "clavix-drill-"));
const root = join(import.meta.dir, "../..");

const run = async (
  script: string,
  args: string[],
  extra: Record<string, string>,
) => {
  const proc = Bun.spawn(["bash", join(root, "scripts", script), ...args], {
    env: { ...Bun.env, MONGO_URI: env.MONGO_URI, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, code };
};

afterAll(async () => {
  rmSync(out, { recursive: true, force: true });
  await mongo.db.client.db(SCRATCH).dropDatabase();
});

describe.skipIf(!hasTools)("restore drill", () => {
  test("a backup restores into a scratch database, collections, documents and indexes intact", async () => {
    const notes = mongo.db.collection("drill_notes");
    await notes.deleteMany({});
    await notes.createIndex({ key: 1 }, { unique: true, name: "key_1" });
    await notes.insertMany([
      { key: "a", value: { n: 1 } },
      { key: "b", value: { n: 2 } },
    ]);

    const backup = await run("mongo-backup.sh", [out], {});
    expect(backup.code).toBe(0);
    const archive = backup.stdout.split("\n").pop() ?? "";
    expect(archive).toMatch(/clavix-.*\.archive\.gz$/);
    expect(readdirSync(out)).toContain(`${archive.split("/").pop()}.sha256`);

    // Without CONFIRM=yes the restore touches nothing.
    const dry = await run("mongo-restore.sh", [archive, SCRATCH], {});
    expect(dry.code).toBe(2);
    expect(await mongo.db.client.db(SCRATCH).collections()).toHaveLength(0);

    const restored = await run("mongo-restore.sh", [archive, SCRATCH], {
      CONFIRM: "yes",
    });
    expect(restored.code).toBe(0);

    const scratch = mongo.db.client.db(SCRATCH);
    const names = async (db: typeof scratch) =>
      (await db.listCollections().toArray()).map((c) => c.name).sort();
    expect(await names(scratch)).toEqual(await names(mongo.db));
    for (const name of await names(mongo.db)) {
      expect(await scratch.collection(name).countDocuments()).toBe(
        await mongo.db.collection(name).countDocuments(),
      );
    }
    const restoredNotes = await scratch
      .collection("drill_notes")
      .find()
      .sort({ key: 1 })
      .toArray();
    expect(restoredNotes.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "a", value: { n: 1 } },
      { key: "b", value: { n: 2 } },
    ]);
    const indexes = await scratch.collection("drill_notes").indexes();
    expect(indexes.find((i) => i.name === "key_1")?.unique).toBe(true);
    // The seeded tenants (the `clavix` operator tenant) came back byte for byte.
    expect(
      await scratch.collection("tenants").find().sort({ _id: 1 }).toArray(),
    ).toEqual(
      await mongo.db.collection("tenants").find().sort({ _id: 1 }).toArray(),
    );

    await notes.drop();
  }, 120_000);

  test("a damaged archive is refused before anything is restored", async () => {
    const backup = await run("mongo-backup.sh", [out], {});
    const archive = backup.stdout.split("\n").pop() ?? "";
    await Bun.write(archive, "not an archive");
    const restored = await run("mongo-restore.sh", [archive, SCRATCH], {
      CONFIRM: "yes",
    });
    expect(restored.code).toBe(1);
    expect(restored.stderr).toContain("checksum mismatch");
  }, 60_000);
});
