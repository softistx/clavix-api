// Restores a scripts/mongo-backup.ts archive.
//
//   CONFIRM=yes MONGO_URI=mongodb://... bun scripts/mongo-restore.ts <archive> [target-db]
//   CONFIRM=yes docker compose -f deploy/compose.yml --profile tools run --rm restore /backups/<archive>
//
// Without CONFIRM=yes nothing is touched. The target database is the one in
// MONGO_URI unless target-db is given (a drill restores into a scratch name,
// e.g. clavix-drill, and leaves production alone). Collections are dropped and
// recreated from the archive (--drop). Stop the api first when restoring over
// the live database (docs/operations.md, "Restore").
// <archive> may be `offsite:latest` or `offsite:<archive name>`: the archive (and its
// .sha256) is first downloaded from the off-host bucket (BACKUP_OFFSITE_*, as the
// backup reads them) into RESTORE_FETCH_DIR (default: a new temporary folder).
// MONGORESTORE  the mongorestore binary (default: mongorestore).
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { fetchArchive, readOffsiteConfig, s3Archives } from "./lib/offsite";

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const requested =
  Bun.argv[2] ??
  fail(
    "usage: mongo-restore.ts <archive | offsite:latest | offsite:<name>> [target-db]",
  );
const uri = Bun.env["MONGO_URI"] || fail("MONGO_URI is required");
const restore = Bun.env["MONGORESTORE"] ?? "mongorestore";

const archive = await (async () => {
  if (!requested.startsWith("offsite:")) return requested;
  try {
    const config =
      readOffsiteConfig(Bun.env) ??
      fail("offsite: BACKUP_OFFSITE_S3_BUCKET is not set");
    const dir =
      Bun.env["RESTORE_FETCH_DIR"] ??
      mkdtempSync(join(tmpdir(), "clavix-restore-"));
    const path = await fetchArchive(
      s3Archives(config),
      requested.slice("offsite:".length),
      dir,
    );
    console.error(`offsite: downloaded ${path}`);
    return path;
  } catch (error) {
    return fail(
      `offsite: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
})();

if (!existsSync(archive)) fail(`no such archive: ${archive}`);
const sidecar = Bun.file(`${archive}.sha256`);
if (await sidecar.exists()) {
  const expected = (await sidecar.text()).trim().split(/\s+/)[0];
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(archive).stream()) hasher.update(chunk);
  const actual = hasher.digest("hex");
  if (expected?.toLowerCase() !== actual) {
    fail(`checksum mismatch: ${archive} is damaged`);
  }
} else if (Bun.env["SKIP_CHECKSUM"] !== "yes") {
  fail(
    `no ${archive}.sha256 next to the archive (SKIP_CHECKSUM=yes to restore it unchecked)`,
  );
}

// The database the archive was taken from, and the one it goes to.
const withoutScheme = uri.slice(uri.indexOf("://") + 3);
const afterHost = withoutScheme.slice(withoutScheme.indexOf("/") + 1);
const sourceDb = afterHost.split("?")[0] ?? "";
const targetDb = Bun.argv[3] ?? sourceDb;
const NAME = /^[A-Za-z0-9_-]+$/;
if (!NAME.test(sourceDb) || !NAME.test(targetDb)) {
  fail(
    "MONGO_URI must name the database in its path, and the names be letters, digits, - or _",
  );
}
// The URI without its database: mongorestore takes the namespaces from the flags.
const queryAt = uri.indexOf("?");
const head = queryAt === -1 ? uri : uri.slice(0, queryAt);
const base = head.slice(0, head.length - `/${sourceDb}`.length);
const search = queryAt === -1 ? "" : uri.slice(queryAt);

if (Bun.env["CONFIRM"] !== "yes") {
  console.error(
    `would restore ${archive} into database '${targetDb}' (dropping its collections).`,
  );
  fail("run again with CONFIRM=yes to do it.", 2);
}

const nsFrom = `${sourceDb}.*`;
const nsTo = `${targetDb}.*`;
const restored =
  await $`${restore} --uri=${`${base}/${search}`} --archive=${archive} --gzip --drop --nsInclude=${nsFrom} --nsFrom=${nsFrom} --nsTo=${nsTo}`.nothrow();
if (restored.exitCode !== 0) process.exit(restored.exitCode);
console.log(`restored ${archive} into ${targetDb}`);
