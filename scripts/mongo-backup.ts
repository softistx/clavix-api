// Dumps the Clavix database to one gzip archive with a sha256 sidecar.
//
//   MONGO_URI=mongodb://... bun scripts/mongo-backup.ts [out-dir]
//   docker compose -f deploy/compose.yml --profile tools run --rm backup
//
// MONGO_URI    required, with the database in its path (as the API reads it).
// KEEP         archives to keep in out-dir (default 14); older ones are removed.
// MONGODUMP    the mongodump binary (default: mongodump).
// BACKUP_OFFSITE_*  optional off-host copy on S3-compatible storage, see
//               scripts/lib/offsite.ts and docs/operations.md ("Off-host copies").
//               A failed upload exits non-zero; the local archive stays.
// The archive holds the tenants' ENCRYPTED signing keys: it is useless without
// CLAVIX_KEYS_MASTER_KEY, which is never in the archive. Keep both, apart.
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  pruneRemote,
  readOffsiteConfig,
  s3Archives,
  shipArchive,
} from "./lib/offsite";

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const out = Bun.argv[2] ?? "./backups";
const uri = Bun.env["MONGO_URI"] || fail("MONGO_URI is required");
const keepText = Bun.env["KEEP"] ?? "14";
const dump = Bun.env["MONGODUMP"] ?? "mongodump";
if (!/^[1-9][0-9]*$/.test(keepText)) fail("KEEP must be a positive integer");
const keep = Number(keepText);
// Read first: a half-configured off-host copy fails before the dump is taken.
let offsite: ReturnType<typeof readOffsiteConfig>;
try {
  offsite = readOffsiteConfig(Bun.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

mkdirSync(out, { recursive: true });
process.umask(0o077);
const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
const name = `clavix-${stamp}.archive.gz`;
const file = join(out, name);
const tmp = `${file}.partial`;

try {
  const dumped = await $`${dump} --uri=${uri} --archive=${tmp} --gzip --quiet`
    .nothrow()
    .quiet();
  if (dumped.exitCode !== 0) {
    process.stderr.write(dumped.stderr);
    rmSync(tmp, { force: true });
    fail(`${dump} failed (exit ${dumped.exitCode})`, dumped.exitCode);
  }
  renameSync(tmp, file);
} finally {
  rmSync(tmp, { force: true });
}

// The sidecar in `sha256sum` format, so `sha256sum --check` reads it too.
const hasher = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
const hash = hasher.digest("hex");
await Bun.write(`${file}.sha256`, `${hash}  ${name}\n`);

// Retention: the newest `keep` archives stay.
const archives = readdirSync(out)
  .filter((f) => /^clavix-.*\.archive\.gz$/.test(f))
  .map((f) => ({ f, at: statSync(join(out, f)).mtimeMs }))
  .sort((a, b) => b.at - a.at || b.f.localeCompare(a.f));
for (const { f } of archives.slice(keep)) {
  rmSync(join(out, f), { force: true });
  rmSync(join(out, `${f}.sha256`), { force: true });
}

console.log(file);

if (offsite !== undefined) {
  // The local archive is already safe on disk: whatever happens below, it stays.
  const remote = s3Archives(offsite);
  try {
    const sent = await shipArchive(remote, file);
    console.error(`offsite: uploaded ${sent.join(", ")}`);
  } catch (error) {
    console.error(
      `offsite: FAILED, the local archive ${file} is kept: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(3);
  }
  try {
    const removed = await pruneRemote(remote, offsite.keepDays);
    if (removed.length > 0) {
      console.error(
        `offsite: removed ${removed.length} object(s) older than ${offsite.keepDays} days`,
      );
    }
  } catch (error) {
    console.error(
      `offsite: uploaded, but the remote retention FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(3);
  }
}
