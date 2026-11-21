import { describe, expect, test } from "bun:test";
import {
  createMemoryOAuthStore,
  hashOAuthSecret,
  type OAuthClientRecord,
} from "@softistx/janus-oauth";
import { countClientViews, listClientViews, MAX_READS } from "./clients.search";
import { capability } from "./clients.utils";

const record = (
  id: string,
  extra: Partial<OAuthClientRecord> = {},
): OAuthClientRecord => ({
  id,
  name: `Client ${id}`,
  redirectUris: ["https://app.example/cb"],
  source: "registered",
  createdAt: new Date("2026-11-12T00:00:00Z"),
  expiresAt: null,
  ...extra,
});

async function storeWith(records: OAuthClientRecord[]) {
  const store = createMemoryOAuthStore();
  for (const client of records) await store.upsertClient(client);
  let reads = 0;
  const list = capability(store.listClients, "listClients");
  return {
    listClients: (options?: Parameters<typeof list>[0]) => {
      reads += 1;
      return list(options);
    },
    reads: () => reads,
  };
}

// Every page of a listing, following the cursor to the end.
async function all(
  listClients: Parameters<typeof listClientViews>[0],
  options: { limit: number; q?: string },
) {
  const pages: string[][] = [];
  let after: string | null = null;
  do {
    const page = await listClientViews(listClients, { ...options, after });
    pages.push(page.items.map((item) => item.clientId));
    after = page.nextCursor;
  } while (after !== null);
  return pages;
}

const pad = (n: number) => String(n).padStart(2, "0");

describe("listClientViews", () => {
  test("pages in id order with one read per page", async () => {
    const store = await storeWith(["c", "a", "b"].map((id) => record(id)));
    expect(await all(store.listClients, { limit: 2 })).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(store.reads()).toBe(2);
  });

  test("a view carries no secret hash, and both grant types by default", async () => {
    const secretHash = hashOAuthSecret("a-secret");
    const store = await storeWith([
      record("back", {
        tokenEndpointAuthMethod: "client_secret_basic",
        secretHash,
      }),
      record("code", { grantTypes: ["authorization_code"] }),
    ]);
    const page = await listClientViews(store.listClients, { limit: 10 });
    expect(JSON.stringify(page)).not.toContain(secretHash);
    expect(
      page.items.map((item) => [item.clientId, item.type, item.grantTypes]),
    ).toEqual([
      ["back", "confidential", ["authorization_code", "refresh_token"]],
      ["code", "public", ["authorization_code"]],
    ]);
  });

  test("a search finds every match once, across pages, whatever the case", async () => {
    const store = await storeWith([
      ...Array.from({ length: 30 }, (_, i) => record(`a${pad(i)}`)),
      record("m1", { name: "Mobile" }),
      record("m2", { name: "MOBILE two" }),
      record("z-mob", { name: "Other" }),
    ]);
    const pages = await all(store.listClients, { limit: 1, q: " mob " });
    expect(pages.flat()).toEqual(["m1", "m2", "z-mob"]);
  });

  test("a search stops after its reads and answers a short page with a cursor", async () => {
    const store = await storeWith([
      ...Array.from({ length: MAX_READS + 5 }, (_, i) => record(`a${pad(i)}`)),
      record("target"),
    ]);
    const first = await listClientViews(store.listClients, {
      limit: 1,
      q: "target",
    });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(store.reads()).toBe(MAX_READS);
    const next = await listClientViews(store.listClients, {
      limit: 1,
      q: "target",
      after: first.nextCursor,
    });
    expect(next.items.map((item) => item.clientId)).toEqual(["target"]);
    expect(next.nextCursor).toBeNull();
  });

  test("a client that is not registered here is left out", async () => {
    const store = await storeWith([
      record("https://client.example/meta", {
        source: "metadata",
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      }),
      record("mine"),
    ]);
    expect((await all(store.listClients, { limit: 10 })).flat()).toEqual([
      "mine",
    ]);
  });
});

test("capability refuses a store without the method", () => {
  expect(() => capability(undefined, "listClients")).toThrow(
    "the OAuth store has no listClients()",
  );
});

describe("countClientViews", () => {
  test("counts every registered client over several reads, with or without q", async () => {
    const store = await storeWith([
      ...Array.from({ length: 130 }, (_, n) => record(`app-${pad(n)}`)),
      record("other", { name: "Zed" }),
      record("meta", { source: "metadata" }),
    ]);
    expect(await countClientViews(store.listClients)).toBe(131);
    expect(await countClientViews(store.listClients, { q: "  APP-12 " })).toBe(
      11,
    );
    expect(await countClientViews(store.listClients, { q: "nothing" })).toBe(0);
  });
});
