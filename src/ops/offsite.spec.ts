import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveTime,
  fetchArchive,
  latestRemote,
  pruneRemote,
  type RemoteArchives,
  readOffsiteConfig,
  s3Archives,
  shipArchive,
} from "../../scripts/lib/offsite";

// The off-host shipping logic against an in-memory remote: no network, no S3.
const fakeRemote = (seed: Record<string, string> = {}) => {
  const objects = new Map(Object.entries(seed));
  const calls: string[] = [];
  const remote: RemoteArchives = {
    async put(name, body, type) {
      calls.push(`put ${name} ${type}`);
      objects.set(name, typeof body === "string" ? body : await body.text());
    },
    async open(name) {
      const text = objects.get(name);
      return text === undefined ? undefined : new Blob([text]).stream();
    },
    async list() {
      return [...objects.keys()];
    },
    async delete(name) {
      calls.push(`delete ${name}`);
      objects.delete(name);
    },
  };
  return { remote, objects, calls };
};

const dir = mkdtempSync(join(tmpdir(), "clavix-offsite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-16T12:00:00Z");
const name = (day: string) => `clavix-${day}T031500Z.archive.gz`;

describe("readOffsiteConfig", () => {
  const base = {
    BACKUP_OFFSITE_S3_BUCKET: "backups",
    BACKUP_OFFSITE_S3_ACCESS_KEY_ID: "id",
    BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY: "secret",
  };

  test("is off without a bucket", () => {
    expect(readOffsiteConfig({})).toBeUndefined();
    expect(
      readOffsiteConfig({ BACKUP_OFFSITE_S3_BUCKET: " " }),
    ).toBeUndefined();
  });

  test("reads the defaults", () => {
    expect(readOffsiteConfig(base)).toEqual({
      bucket: "backups",
      endpoint: undefined,
      region: undefined,
      accessKeyId: "id",
      secretAccessKey: "secret",
      prefix: "clavix-backups/",
      keepDays: 30,
    });
  });

  test("normalizes the prefix and reads the retention", () => {
    const config = readOffsiteConfig({
      ...base,
      BACKUP_OFFSITE_S3_PREFIX: "/prod/clavix//",
      BACKUP_OFFSITE_S3_ENDPOINT: "https://s3.example.com",
      BACKUP_OFFSITE_S3_REGION: "eu-1",
      BACKUP_OFFSITE_KEEP_DAYS: "7",
    });
    expect(config).toMatchObject({
      prefix: "prod/clavix/",
      endpoint: "https://s3.example.com",
      region: "eu-1",
      keepDays: 7,
    });
  });

  test("refuses a bucket without credentials and a bad retention", () => {
    expect(() =>
      readOffsiteConfig({ BACKUP_OFFSITE_S3_BUCKET: "backups" }),
    ).toThrow("ACCESS_KEY_ID");
    expect(() =>
      readOffsiteConfig({ ...base, BACKUP_OFFSITE_KEEP_DAYS: "0" }),
    ).toThrow("KEEP_DAYS");
  });
});

describe("archiveTime", () => {
  test("reads the UTC stamp of an archive and of its sidecar", () => {
    expect(archiveTime(name("20261112"))).toBe(
      Date.UTC(2026, 10, 12, 3, 15, 0),
    );
    expect(archiveTime(`${name("20261112")}.sha256`)).toBe(
      Date.UTC(2026, 10, 12, 3, 15, 0),
    );
    expect(archiveTime("notes.txt")).toBeUndefined();
  });
});

describe("shipArchive", () => {
  test("uploads the archive, then its sidecar", async () => {
    const file = join(dir, name("20261116"));
    writeFileSync(file, "dump");
    writeFileSync(`${file}.sha256`, "abc  file\n");
    const { remote, objects, calls } = fakeRemote();
    expect(await shipArchive(remote, file)).toEqual([
      name("20261116"),
      `${name("20261116")}.sha256`,
    ]);
    expect(calls).toEqual([
      `put ${name("20261116")} application/gzip`,
      `put ${name("20261116")}.sha256 text/plain`,
    ]);
    expect(objects.get(name("20261116"))).toBe("dump");
  });

  test("a failing upload rejects and leaves the local file alone", async () => {
    const file = join(dir, name("20261115"));
    writeFileSync(file, "dump");
    const { remote } = fakeRemote();
    remote.put = async () => {
      throw new Error("connection refused");
    };
    await expect(shipArchive(remote, file)).rejects.toThrow(
      "connection refused",
    );
    expect(readFileSync(file, "utf8")).toBe("dump");
  });

  test("refuses a file that is not a backup archive", async () => {
    const { remote } = fakeRemote();
    await expect(shipArchive(remote, join(dir, "x.txt"))).rejects.toThrow(
      "not a backup archive",
    );
  });
});

describe("pruneRemote", () => {
  test("deletes archives and sidecars older than the retention, keeps the rest", async () => {
    const { remote, objects } = fakeRemote({
      [name("20261001")]: "a",
      [`${name("20261001")}.sha256`]: "a",
      [name("20261105")]: "b",
      [`${name("20261105")}.sha256`]: "b",
      [name("20261116")]: "c",
      [`${name("20261116")}.sha256`]: "c",
      "README.txt": "not ours",
    });
    const removed = await pruneRemote(remote, 14, NOW);
    expect(removed.sort()).toEqual([
      name("20261001"),
      `${name("20261001")}.sha256`,
    ]);
    expect([...objects.keys()].sort()).toEqual([
      "README.txt",
      name("20261105"),
      `${name("20261105")}.sha256`,
      name("20261116"),
      `${name("20261116")}.sha256`,
    ]);
  });

  test("never deletes the newest archive, however old", async () => {
    const { remote, objects } = fakeRemote({
      [name("20260101")]: "a",
      [`${name("20260101")}.sha256`]: "a",
      [name("20260102")]: "b",
      [`${name("20260102")}.sha256`]: "b",
    });
    await pruneRemote(remote, 7, NOW);
    expect([...objects.keys()].sort()).toEqual([
      name("20260102"),
      `${name("20260102")}.sha256`,
    ]);
  });

  test("an empty bucket is fine", async () => {
    expect(await pruneRemote(fakeRemote().remote, 7, NOW)).toEqual([]);
  });
});

describe("fetchArchive", () => {
  const seed = {
    [name("20261110")]: "old",
    [name("20261114")]: "new",
    [`${name("20261114")}.sha256`]: "sum  file\n",
  };

  test("latest picks the newest archive and brings its sidecar", async () => {
    const { remote } = fakeRemote(seed);
    expect(await latestRemote(remote)).toBe(name("20261114"));
    const out = join(dir, "latest");
    const path = await fetchArchive(remote, "latest", out);
    expect(path).toBe(join(out, name("20261114")));
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readFileSync(`${path}.sha256`, "utf8")).toBe("sum  file\n");
  });

  test("a named archive is fetched without a sidecar when there is none", async () => {
    const { remote } = fakeRemote(seed);
    const out = join(dir, "named");
    const path = await fetchArchive(remote, name("20261110"), out);
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(await Bun.file(`${path}.sha256`).exists()).toBe(false);
  });

  test("a missing archive, an empty bucket and a foreign name are errors", async () => {
    await expect(
      fetchArchive(fakeRemote(seed).remote, name("20200101"), dir),
    ).rejects.toThrow("no such archive");
    await expect(
      fetchArchive(fakeRemote().remote, "latest", dir),
    ).rejects.toThrow("no archive");
    await expect(
      fetchArchive(fakeRemote(seed).remote, "../etc/passwd", dir),
    ).rejects.toThrow("not a backup archive name");
  });
});

describe("s3Archives", () => {
  test("builds a remote without touching the network", () => {
    const config = readOffsiteConfig({
      BACKUP_OFFSITE_S3_BUCKET: "backups",
      BACKUP_OFFSITE_S3_ACCESS_KEY_ID: "id",
      BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY: "secret",
      BACKUP_OFFSITE_S3_ENDPOINT: "http://127.0.0.1:9",
    });
    if (config === undefined) throw new Error("config expected");
    const remote = s3Archives(config);
    expect(Object.keys(remote).sort()).toEqual([
      "delete",
      "list",
      "open",
      "put",
    ]);
  });
});
