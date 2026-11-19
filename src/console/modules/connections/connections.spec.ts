import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { codeOf, consoleAs } from "~/console";

const admin = consoleAs("cn-admin-a");
const viewer = consoleAs("cn-viewer-a");
const adminB = consoleAs("cn-admin-b");

let tenantA = "";
let tenantB = "";

const SECRET = "s3cr3t-never-returned";
const FIELDS = `id name issuer clientId emailTrust requireSso jit showButton enabled revision
  domains { domain txtName txtToken verified } claims { email } upstreamMfa { acr }`;
const CREATE = `mutation($tenantId: ID!, $input: CreateConnectionInput!) {
  createConnection(tenantId: $tenantId, input: $input) { ${FIELDS} }
}`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateConnectionInput!) {
  updateConnection(tenantId: $tenantId, id: $id, input: $input) { ${FIELDS} }
}`;
const SECRET_MUTATION = `mutation($tenantId: ID!, $id: ID!, $clientSecret: String!) {
  setConnectionSecret(tenantId: $tenantId, id: $id, clientSecret: $clientSecret) { ${FIELDS} }
}`;
const DELETE = `mutation($tenantId: ID!, $id: ID!) { deleteConnection(tenantId: $tenantId, id: $id) }`;
const ADD = `mutation($tenantId: ID!, $id: ID!, $domain: String!) {
  addConnectionDomain(tenantId: $tenantId, id: $id, domain: $domain) { ${FIELDS} }
}`;
const REMOVE = `mutation($tenantId: ID!, $id: ID!, $domain: String!) {
  removeConnectionDomain(tenantId: $tenantId, id: $id, domain: $domain) { ${FIELDS} }
}`;
const LIST = `query($tenantId: ID!) { connections(tenantId: $tenantId) { ${FIELDS} } }`;
const ONE = `query($tenantId: ID!, $id: ID!) { connection(tenantId: $tenantId, id: $id) { ${FIELDS} } }`;
const CHECK = `query($tenantId: ID!, $input: CheckConnectionInput!) {
  checkConnection(tenantId: $tenantId, input: $input) { issuer authorizationEndpoint }
}`;

const base = (over: Record<string, unknown> = {}) => ({
  id: "acme",
  name: "Acme SSO",
  issuer: "https://login.acme.test",
  clientId: "client-1",
  clientSecret: SECRET,
  ...over,
});

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "cn-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "cn-b", name: "B" })).id;
  await access.grantTenant(tenantA, "cn-admin-a", "admin");
  await access.grantTenant(tenantA, "cn-viewer-a", "viewer");
  await access.grantTenant(tenantB, "cn-admin-b", "admin");
}, 30_000);

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await mongo.db.connections.raw.deleteMany({});
  await mongo.db.adminEvents.raw.deleteMany({});
  await oauthDb.collection("relations").deleteMany({});
});

describe("createConnection", () => {
  test("creates, lists and shows no secret", async () => {
    const result = await admin(CREATE, { tenantId: tenantA, input: base() });
    expect(result.errors).toBeUndefined();
    expect(result.data?.["createConnection"]).toMatchObject({
      id: "acme",
      emailTrust: "CLAIM_AND_DOMAIN",
      requireSso: true,
      jit: true,
      showButton: false,
      enabled: true,
      revision: 1,
      domains: [],
    });
    const list = await admin(LIST, { tenantId: tenantA });
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The sealed value sits in the store, not the clear secret.
    expect(
      JSON.stringify(await mongo.db.connections.raw.find({}).toArray()),
    ).not.toContain(SECRET);
  });

  test("refuses a record janus refuses, a taken id and a built-in name", async () => {
    for (const input of [
      base({ issuer: "http://login.acme.test" }),
      base({ idTokenSignedResponseAlg: "RS256", claims: { email: "sub" } }),
      base({ id: "google" }),
      base({ id: "Bad_Id" }),
    ]) {
      const result = await admin(CREATE, { tenantId: tenantA, input });
      expect(codeOf(result)).toBe("BAD_USER_INPUT");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    expect(
      codeOf(await admin(CREATE, { tenantId: tenantA, input: base() })),
    ).toBe("CONFLICT");
  });

  test("a viewer and another tenant's admin are refused; B never sees A's", async () => {
    const input = base({ id: "nope" });
    expect(codeOf(await viewer(CREATE, { tenantId: tenantA, input }))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await adminB(CREATE, { tenantId: tenantA, input }))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await adminB(LIST, { tenantId: tenantA }))).toBe("FORBIDDEN");
    const { name: _name, ...candidate } = input;
    expect(
      codeOf(await viewer(CHECK, { tenantId: tenantA, input: candidate })),
    ).toBe("FORBIDDEN");
    const own = await adminB(LIST, { tenantId: tenantB });
    expect(own.data?.["connections"]).toEqual([]);
    const crossed = await adminB(ONE, { tenantId: tenantB, id: "acme" });
    expect(crossed.data?.["connection"]).toBeNull();
    expect(
      codeOf(
        await adminB(UPDATE, {
          tenantId: tenantB,
          id: "acme",
          input: { name: "x" },
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("the quota of the free plan is 1", async () => {
    const over = await admin(CREATE, {
      tenantId: tenantA,
      input: base({ id: "second" }),
    });
    expect(codeOf(over)).toBe("QUOTA_EXCEEDED");
    expect(await mongo.db.connections.raw.countDocuments({})).toBe(1);
    const viewed = await viewer(LIST, { tenantId: tenantA });
    expect(viewed.errors).toBeUndefined();
  });
});

describe("update, secret, domains and delete", () => {
  test("a full life", async () => {
    const updated = await admin(UPDATE, {
      tenantId: tenantA,
      id: "acme",
      input: { name: "Acme", showButton: true, upstreamMfa: { acr: "mfa" } },
    });
    expect(updated.data?.["updateConnection"]).toMatchObject({
      name: "Acme",
      showButton: true,
      upstreamMfa: { acr: "mfa" },
      revision: 2,
    });
    const reset = await admin(SECRET_MUTATION, {
      tenantId: tenantA,
      id: "acme",
      clientSecret: "another-secret-value",
    });
    expect(reset.errors).toBeUndefined();
    expect(JSON.stringify(reset)).not.toContain("another-secret-value");
    const added = await admin(ADD, {
      tenantId: tenantA,
      id: "acme",
      domain: "Acme.TEST",
    });
    const domain = (
      (added.data ?? {})["addConnectionDomain"] as unknown as {
        domains: {
          domain: string;
          txtName: string;
          txtToken: string;
          verified: boolean;
        }[];
      }
    ).domains[0];
    expect(domain).toMatchObject({
      domain: "acme.test",
      txtName: "_clavix-sso.acme.test",
      verified: false,
    });
    expect(domain?.txtToken).toStartWith("clavix-verify=");
    expect(
      codeOf(
        await admin(ADD, {
          tenantId: tenantA,
          id: "acme",
          domain: "acme.test",
        }),
      ),
    ).toBe("CONFLICT");
    const removed = await admin(REMOVE, {
      tenantId: tenantA,
      id: "acme",
      domain: "acme.test",
    });
    expect(
      (
        (removed.data ?? {})["removeConnectionDomain"] as unknown as {
          domains: unknown[];
        }
      ).domains,
    ).toEqual([]);
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: "acme" })).data,
    ).toEqual({ deleteConnection: true });
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: "acme" })).data,
    ).toEqual({ deleteConnection: false });
  });
});

describe("checkConnection", () => {
  test("refuses a candidate janus refuses, with no request made", async () => {
    for (const input of [
      base({ issuer: "http://login.acme.test" }),
      base({ idTokenSignedResponseAlg: "RS256", scopes: ["bad scope"] }),
    ]) {
      const result = await admin(CHECK, { tenantId: tenantA, input });
      expect(codeOf(result)).toBe("BAD_USER_INPUT");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  test("refuses a private issuer", async () => {
    const result = await admin(CHECK, {
      tenantId: tenantA,
      input: base({ issuer: "https://10.0.0.5" }),
    });
    expect(["ISSUER_REFUSED", "BAD_USER_INPUT"]).toContain(
      codeOf(result) ?? "",
    );
  }, 20_000);
});

describe("audit", () => {
  test("each write is recorded, with no secret or issuer in it", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    await mongo.db.connections.raw.deleteMany({});
    await admin(CREATE, { tenantId: tenantA, input: base() });
    await admin(UPDATE, {
      tenantId: tenantA,
      id: "acme",
      input: { jit: false },
    });
    await admin(SECRET_MUTATION, {
      tenantId: tenantA,
      id: "acme",
      clientSecret: "yet-another-secret",
    });
    await admin(ADD, { tenantId: tenantA, id: "acme", domain: "acme.test" });
    await admin(REMOVE, { tenantId: tenantA, id: "acme", domain: "acme.test" });
    await admin(DELETE, { tenantId: tenantA, id: "acme" });
    const events = await mongo.db.adminEvents.raw
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(events.map((event) => event.action)).toEqual([
      "connection.create",
      "connection.update",
      "connection.setSecret",
      "connection.addDomain",
      "connection.removeDomain",
      "connection.delete",
    ]);
    const text = JSON.stringify(events);
    for (const leak of [
      SECRET,
      "yet-another-secret",
      "login.acme.test",
      "acme.test",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});
