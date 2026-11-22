import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { tenantDoc } from "~/tenant-doc";
import {
  dropHosts,
  escapeRegex,
  hostOf,
  issuerOf,
  issuerOfHost,
  listFilterOf,
  listScopeOf,
  objectIdsOf,
  partitionOf,
  reasonOf,
  registeredOf,
  stateOf,
} from "./tenants.utils";

test("the issuer is derived from the slug, scheme, domain and port", () => {
  expect(issuerOf("acme", { scheme: "https", domain: "clavix.example" })).toBe(
    "https://acme.clavix.example",
  );
  expect(
    issuerOf("acme", {
      scheme: "http",
      domain: "clavix.localhost",
      port: 3000,
    }),
  ).toBe("http://acme.clavix.localhost:3000");
  expect(hostOf("acme", "clavix.example")).toBe("acme.clavix.example");
});

test("the partition is the id in hex", () => {
  const id = new ObjectId();
  expect(partitionOf(id)).toBe(id.toHexString());
});

test("issuerOfHost keeps the scheme and port of the origin", () => {
  expect(
    issuerOfHost("login.acme.test", { scheme: "http", domain: "x", port: 80 }),
  ).toBe("http://login.acme.test:80");
  expect(issuerOfHost("a.test", { scheme: "https", domain: "x" })).toBe(
    "https://a.test",
  );
});

test("reasonOf words an Error by its message and anything else by its string", () => {
  expect(reasonOf(new Error("down"))).toBe("down");
  expect(reasonOf("plain")).toBe("plain");
});

test("escapeRegex matches the text literally", () => {
  expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
  expect(new RegExp(escapeRegex("(x)")).test("(x)")).toBe(true);
});

test("objectIdsOf keeps the valid ids only", () => {
  const id = new ObjectId();
  expect(objectIdsOf([id.toHexString(), "nope"])).toEqual([id]);
});

test("registeredOf reports a stored tenant", () => {
  const tenant = tenantDoc();
  expect(registeredOf(tenant, true)).toEqual({
    created: true,
    tenantId: tenant._id.toHexString(),
    slug: "acme",
    name: "Acme",
    status: "active",
    signUp: false,
  });
});

test("stateOf: the status, the trash, or null once the purge started", () => {
  const base = { status: "active", deletedAt: null } as const;
  expect(stateOf(base)).toBe("active");
  expect(stateOf({ ...base, status: "suspended" })).toBe("suspended");
  expect(stateOf({ ...base, deletedAt: new Date() })).toBe("deleted");
  expect(
    stateOf({ ...base, deletedAt: new Date(), purgeStartedAt: new Date() }),
  ).toBeNull();
});

test("listFilterOf: state, ids and the search become one filter", () => {
  const plain = listFilterOf({});
  expect(plain).toEqual({ purgeStartedAt: { $exists: false } });
  expect(listFilterOf({ state: "live" })).toMatchObject({ deletedAt: null });
  expect(listFilterOf({ state: "deleted" })).toMatchObject({
    deletedAt: { $ne: null },
  });
  expect(listFilterOf({ ids: [] })).toMatchObject({ _id: { $in: [] } });
  const searched = listFilterOf({ q: " Ac.me " });
  expect(searched.$or).toEqual([
    { slug: { $regex: "^ac\\.me" } },
    { name: { $regex: "Ac\\.me", $options: "i" } },
  ]);
});

test("listScopeOf binds a cursor to its search", () => {
  expect(listScopeOf({ first: 5, q: " a ", state: "live" })).toBe(
    listScopeOf({ first: 9, q: "a", state: "live" }),
  );
  expect(listScopeOf({ first: 5, q: "a" })).not.toBe(
    listScopeOf({ first: 5, q: "b" }),
  );
  expect(listScopeOf({ first: 5, ids: [] })).not.toBe(
    listScopeOf({ first: 5 }),
  );
});

test("dropHosts drops the slug host and the custom hosts; a failing port is logged and the other still runs", async () => {
  const dropped: string[][] = [];
  const logged: string[] = [];
  const tenant = { slug: "acme", _id: new ObjectId() };
  await dropHosts(
    {
      domain: "clavix.test",
      hostsOf: () => ["acme.example"],
      onHostsChanged: (hosts) => {
        dropped.push(hosts);
      },
      log: (message) => logged.push(message),
    },
    tenant,
  );
  expect(dropped).toEqual([["acme.clavix.test", "acme.example"]]);
  await dropHosts(
    {
      domain: "clavix.test",
      hostsOf: () => {
        throw new Error("store down");
      },
      onHostsChanged: (hosts) => {
        dropped.push(hosts);
      },
      log: (message) => logged.push(message),
    },
    tenant,
  );
  expect(dropped[1]).toEqual(["acme.clavix.test"]);
  expect(logged).toEqual([
    "tenants: hostsOf failed for acme.clavix.test: store down",
  ]);
});
