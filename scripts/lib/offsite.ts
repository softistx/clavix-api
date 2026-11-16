// Off-host copies of the backup archives, on S3-compatible storage through
// @softistx/s3 (docs/operations.md, "Off-host copies"). The logic here (what
// is uploaded, what retention deletes, which archive "latest" is) talks to a
// RemoteArchives, so a spec drives it with an in-memory fake and no network;
// s3Archives() is the one adapter onto a bound @softistx/s3 bucket.
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { bindBucket, defineBucket } from "@softistx/s3";

export type OffsiteConfig = {
  bucket: string;
  endpoint: string | undefined;
  region: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  /** Always ends with "/" (or is empty). */
  prefix: string;
  keepDays: number;
};

/** What the shipping logic needs from the remote side; names are archive file names, prefix excluded. */
export type RemoteArchives = {
  put(name: string, body: Blob | string, type: string): Promise<void>;
  /** The object's bytes as a stream, or undefined when it does not exist. */
  open(name: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Every name under the prefix. */
  list(): Promise<string[]>;
  delete(name: string): Promise<void>;
};

const ARCHIVE = /^clavix-(\d{8}T\d{6}Z)\.archive\.gz$/;
const SIDECAR = /^clavix-(\d{8}T\d{6}Z)\.archive\.gz\.sha256$/;

/** The epoch milliseconds in `clavix-20261112T031500Z.archive.gz[.sha256]`, or undefined. */
export function archiveTime(name: string): number | undefined {
  const stamp = (ARCHIVE.exec(name) ?? SIDECAR.exec(name))?.[1];
  if (stamp === undefined) return undefined;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * The off-host settings from the environment, or undefined when shipping is off
 * (no bucket). A bucket without credentials, or a bad retention, is an error:
 * a half-configured backup must not look like a configured one.
 */
export function readOffsiteConfig(
  env: Record<string, string | undefined>,
): OffsiteConfig | undefined {
  const get = (key: string): string | undefined => {
    const value = env[`BACKUP_OFFSITE_${key}`]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const bucket = get("S3_BUCKET");
  if (bucket === undefined) return undefined;
  const accessKeyId = get("S3_ACCESS_KEY_ID");
  const secretAccessKey = get("S3_SECRET_ACCESS_KEY");
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      "BACKUP_OFFSITE_S3_BUCKET is set: BACKUP_OFFSITE_S3_ACCESS_KEY_ID and BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY are required",
    );
  }
  const keepText = get("KEEP_DAYS") ?? "30";
  if (!/^[1-9][0-9]*$/.test(keepText)) {
    throw new Error("BACKUP_OFFSITE_KEEP_DAYS must be a positive integer");
  }
  const rawPrefix = (get("S3_PREFIX") ?? "clavix-backups").replace(
    /^\/+|\/+$/g,
    "",
  );
  return {
    bucket,
    endpoint: get("S3_ENDPOINT"),
    region: get("S3_REGION"),
    accessKeyId,
    secretAccessKey,
    prefix: rawPrefix === "" ? "" : `${rawPrefix}/`,
    keepDays: Number(keepText),
  };
}

/** The remote side on a bound @softistx/s3 bucket, built from the configuration. */
export function s3Archives(config: OffsiteConfig): RemoteArchives {
  const definition = defineBucket({
    bucket: config.bucket,
    key: (p: { name: string }) => `${config.prefix}${p.name}`,
  });
  const bound = bindBucket(definition, {
    ...(config.endpoint === undefined
      ? {}
      : { endpoint: config.endpoint, virtualHostedStyle: false }),
    ...(config.region === undefined ? {} : { region: config.region }),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    timeoutMs: 30_000,
  });
  return {
    async put(name, body, type) {
      const size = typeof body === "string" ? undefined : body.size;
      if (size === undefined) {
        await bound.put({ name }, body, { type });
        return;
      }
      // Streamed with its size: the archive is never held in memory, and the
      // timeout is idle time (nothing moved), not the length of the upload.
      await bound.put({ name }, (body as Blob).stream(), {
        type,
        size,
        timeoutMs: 120_000,
      });
    },
    async open(name) {
      return (await bound.open({ name }))?.stream;
    },
    async list() {
      const prefix = bound.keyFor({ name: "" });
      const names: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await bound.list({ prefix, cursor });
        for (const item of page.items)
          names.push(item.key.slice(prefix.length));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return names;
    },
    async delete(name) {
      await bound.delete({ name });
    },
  };
}

/** Uploads an archive, then its checksum sidecar (the sidecar last: an archive without one is the partial case). */
export async function shipArchive(
  remote: RemoteArchives,
  archivePath: string,
): Promise<string[]> {
  const name = basename(archivePath);
  if (!ARCHIVE.test(name)) throw new Error(`not a backup archive: ${name}`);
  await remote.put(name, Bun.file(archivePath), "application/gzip");
  const sidecar = Bun.file(`${archivePath}.sha256`);
  await remote.put(`${name}.sha256`, sidecar, "text/plain");
  return [name, `${name}.sha256`];
}

/**
 * Deletes the archives (and sidecars) older than `keepDays` under the prefix.
 * Only names that look like our archives are touched, and the newest archive
 * always stays, so a long outage of the backup job never empties the bucket.
 * Returns the deleted names.
 */
export async function pruneRemote(
  remote: RemoteArchives,
  keepDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  const names = await remote.list();
  const archives = names.filter((n) => ARCHIVE.test(n)).sort();
  const newest = archives.at(-1);
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const deleted: string[] = [];
  for (const name of [...names].sort()) {
    const at = archiveTime(name);
    if (at === undefined || at >= cutoff) continue;
    if (newest !== undefined && name.replace(/\.sha256$/, "") === newest) {
      continue;
    }
    await remote.delete(name);
    deleted.push(name);
  }
  return deleted;
}

/** The newest archive name under the prefix, or undefined when there is none. */
export async function latestRemote(
  remote: RemoteArchives,
): Promise<string | undefined> {
  return (await remote.list())
    .filter((n) => ARCHIVE.test(n))
    .sort()
    .at(-1);
}

/**
 * Downloads an archive and its sidecar into `dir` and returns the local path.
 * `ref` is an archive name, or "latest". The sidecar is optional only when the
 * remote has none (mongo-restore then refuses it unless SKIP_CHECKSUM=yes).
 */
export async function fetchArchive(
  remote: RemoteArchives,
  ref: string,
  dir: string,
): Promise<string> {
  const name = ref === "latest" ? await latestRemote(remote) : ref;
  if (name === undefined) throw new Error("no archive in the off-host bucket");
  if (!ARCHIVE.test(name))
    throw new Error(`not a backup archive name: ${name}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  const stream = await remote.open(name);
  if (stream === undefined) {
    throw new Error(`no such archive in the off-host bucket: ${name}`);
  }
  await Bun.write(target, new Response(stream));
  const sidecar = await remote.open(`${name}.sha256`);
  if (sidecar !== undefined) {
    await Bun.write(`${target}.sha256`, new Response(sidecar));
  }
  return target;
}
