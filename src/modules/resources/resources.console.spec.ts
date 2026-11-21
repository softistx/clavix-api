import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { access, linkTenantToPlatform } from "@/config/access";
import { clientPoliciesService } from "@/config/client-policies";
import { consoleResource } from "@/config/console";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { userinfoOf } from "@/oauth/building";
import { fingerprintOf } from "@/oauth/resolution";
import { codeOf, consoleAs } from "~/console";
import { manyRows as many, oneRow as one, rowsOf } from "~/rows";

const API = "https://api.res-a.example/v1";
const admin = consoleAs("res-admin-a");
const viewer = consoleAs("res-viewer-a");
const adminB = consoleAs("res-admin-b");

let tenantA = "";
let tenantB = "";

const SCOPE = "id name description { fr en } resourceId claims";
const RESOURCE = `id uri name createdAt allowClientCredentials scopes { ${SCOPE} }`;
const CREATE = `mutation($tenantId: ID!, $input: CreateResourceInput!) {
  createResource(tenantId: $tenantId, input: $input) { ${RESOURCE} }
}`;
const UPDATE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateResourceInput!) {
  updateResource(tenantId: $tenantId, id: $id, input: $input) { ${RESOURCE} }
}`;
const DELETE = `mutation($tenantId: ID!, $id: ID!) { deleteResource(tenantId: $tenantId, id: $id) }`;
const LIST = `query($tenantId: ID!) { resources(tenantId: $tenantId) { ${RESOURCE} } }`;
const GET = `query($tenantId: ID!, $id: ID!) { resource(tenantId: $tenantId, id: $id) { ${RESOURCE} } }`;
const SCOPES = `query($tenantId: ID!, $resourceId: ID) { scopes(tenantId: $tenantId, resourceId: $resourceId) { ${SCOPE} } }`;
const CREATE_SCOPE = `mutation($tenantId: ID!, $input: CreateScopeInput!) {
  createScope(tenantId: $tenantId, input: $input) { ${SCOPE} }
}`;
const UPDATE_SCOPE = `mutation($tenantId: ID!, $id: ID!, $input: UpdateScopeInput!) {
  updateScope(tenantId: $tenantId, id: $id, input: $input) { ${SCOPE} }
}`;
const DELETE_SCOPE = `mutation($tenantId: ID!, $id: ID!) { deleteScope(tenantId: $tenantId, id: $id) }`;

const served = async (slug: string) => {
  const tenant = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  if (tenant === null) throw new Error("tenant not resolved");
  return resourcesFor(tenant);
};

let api = "";
let read = "";

beforeAll(async () => {
  tenantA = (await tenantsService.create({ slug: "res-a", name: "A" })).id;
  tenantB = (await tenantsService.create({ slug: "res-b", name: "B" })).id;
  await access.grantTenant(tenantA, "res-admin-a", "admin");
  await access.grantTenant(tenantA, "res-viewer-a", "viewer");
  await access.grantTenant(tenantB, "res-admin-b", "admin");
});

afterAll(async () => {
  for (const tenantId of [tenantA, tenantB]) {
    await mongo.db.resources.raw.deleteMany({
      tenantId: new ObjectId(tenantId),
    });
    await mongo.db.scopes.raw.deleteMany({ tenantId: new ObjectId(tenantId) });
  }
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("relations").deleteMany({});
});

describe("resources", () => {
  test("createResource stores it, named after its host by default", async () => {
    const created = one(
      await admin(CREATE, { tenantId: tenantA, input: { uri: API } }),
      "createResource",
    );
    expect(created).toMatchObject({
      uri: API,
      name: "api.res-a.example",
      scopes: [],
    });
    api = created.id;
  });

  test("the same URI again is a CONFLICT; bad URIs and the userinfo URL are refused", async () => {
    expect(
      codeOf(
        await admin(CREATE, {
          tenantId: tenantA,
          input: { uri: API, name: "Another name" },
        }),
      ),
    ).toBe("CONFLICT");
    const origin = {
      scheme: env.CLAVIX_PUBLIC_SCHEME,
      domain: env.CLAVIX_DOMAIN,
      port: env.CLAVIX_PUBLIC_PORT,
    } as const;
    for (const uri of [
      "not a uri",
      "http://api.example/v1",
      `${API}#frag`,
      "https://API.res-a.example/v2",
      userinfoOf(issuerOf("res-a", origin)),
    ]) {
      expect(
        codeOf(await admin(CREATE, { tenantId: tenantA, input: { uri } })),
      ).toBe("BAD_USER_INPUT");
    }
    expect(
      many(await admin(LIST, { tenantId: tenantA }), "resources"),
    ).toHaveLength(1);
  });

  test("updateResource renames it; the URI stays", async () => {
    const updated = one(
      await admin(UPDATE, {
        tenantId: tenantA,
        id: api,
        input: { name: "Orders API" },
      }),
      "updateResource",
    );
    expect(updated).toMatchObject({ id: api, uri: API, name: "Orders API" });
    expect(
      codeOf(
        await admin(UPDATE, {
          tenantId: tenantA,
          id: api,
          input: { name: " " },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(
        await admin(UPDATE, {
          tenantId: tenantA,
          id: "0123456789abcdef01234567",
          input: { name: "X" },
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("allowClientCredentials is off by default, set by an update, and the name is kept", async () => {
    const before = one(
      await admin(GET, { tenantId: tenantA, id: api }),
      "resource",
    );
    expect(before["allowClientCredentials"]).toBe(false);
    const on = one(
      await admin(UPDATE, {
        tenantId: tenantA,
        id: api,
        input: { allowClientCredentials: true },
      }),
      "updateResource",
    );
    expect(on).toMatchObject({
      name: before["name"],
      allowClientCredentials: true,
    });
    const renamed = one(
      await admin(UPDATE, {
        tenantId: tenantA,
        id: api,
        input: { name: "Orders API" },
      }),
      "updateResource",
    );
    expect(renamed).toMatchObject({
      name: "Orders API",
      allowClientCredentials: true,
    });
    const off = one(
      await admin(UPDATE, {
        tenantId: tenantA,
        id: api,
        input: { allowClientCredentials: false },
      }),
      "updateResource",
    );
    expect(off["allowClientCredentials"]).toBe(false);
  });

  test("resource reads one, null when unknown", async () => {
    expect(
      one(await admin(GET, { tenantId: tenantA, id: api }), "resource"),
    ).toMatchObject({ name: "Orders API" });
    const none = await admin(GET, { tenantId: tenantA, id: "nope" });
    expect(none.errors).toBeUndefined();
    expect(none.data?.["resource"]).toBeNull();
  });
});

describe("scopes", () => {
  test("createScope adds a scope to the resource, served at once", async () => {
    const before = fingerprintOf(await served("res-a"));
    const created = one(
      await admin(CREATE_SCOPE, {
        tenantId: tenantA,
        input: {
          name: "orders:read",
          resourceId: api,
          description: { fr: "Lire vos commandes", en: "Read your orders" },
          claims: ["orders", "orders", " region "],
        },
      }),
      "createScope",
    );
    expect(created).toMatchObject({
      name: "orders:read",
      resourceId: api,
      description: { fr: "Lire vos commandes", en: "Read your orders" },
      claims: ["orders", "region"],
    });
    read = created.id;
    // The token server reads the scopes on each request: the issuer's
    // fingerprint moves, so the new scope is offered with no restart.
    const now = await served("res-a");
    expect(now[API]?.scopes).toEqual(["orders:read"]);
    expect(fingerprintOf(now)).not.toBe(before);
    expect(
      one(await admin(GET, { tenantId: tenantA, id: api }), "resource")[
        "scopes"
      ],
    ).toMatchObject([{ id: read, name: "orders:read" }]);
  });

  test("a name the resource already has is a CONFLICT; a bad name or an unknown resource is refused", async () => {
    const input = { name: "orders:read", resourceId: api };
    expect(
      codeOf(await admin(CREATE_SCOPE, { tenantId: tenantA, input })),
    ).toBe("CONFLICT");
    expect(
      codeOf(
        await admin(CREATE_SCOPE, {
          tenantId: tenantA,
          input: { name: "two words", resourceId: api },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(
        await admin(CREATE_SCOPE, {
          tenantId: tenantA,
          input: { name: "x", resourceId: "0123456789abcdef01234567" },
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("another resource of the tenant may have a scope of the same name", async () => {
    const other = one(
      await admin(CREATE, {
        tenantId: tenantA,
        input: { uri: "https://billing.res-a.example/", name: "Billing" },
      }),
      "createResource",
    );
    one(
      await admin(CREATE_SCOPE, {
        tenantId: tenantA,
        input: { name: "orders:read", resourceId: other.id },
      }),
      "createScope",
    );
    const all = many(await admin(SCOPES, { tenantId: tenantA }), "scopes");
    expect(all.map((scope) => scope["resourceId"]).sort()).toEqual(
      [api, other.id].sort(),
    );
    expect(
      many(
        await admin(SCOPES, { tenantId: tenantA, resourceId: api }),
        "scopes",
      ).map((scope) => scope.id),
    ).toEqual([read]);
  });

  test("a scope with no resource is a standard OpenID Connect one", async () => {
    const standard = one(
      await admin(CREATE_SCOPE, {
        tenantId: tenantA,
        input: { name: "profile", description: { en: "See your name" } },
      }),
      "createScope",
    );
    expect(standard).toMatchObject({
      name: "profile",
      resourceId: null,
      description: { fr: "", en: "See your name" },
      claims: [],
    });
    expect(
      codeOf(
        await admin(CREATE_SCOPE, {
          tenantId: tenantA,
          input: { name: "profile" },
        }),
      ),
    ).toBe("CONFLICT");
    expect(
      codeOf(
        await admin(CREATE_SCOPE, {
          tenantId: tenantA,
          input: { name: "orders:write" },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    // A standard scope belongs to userinfo, which is built in: no stored resource offers it.
    expect(
      Object.values(await served("res-a")).flatMap((r) => r.scopes),
    ).not.toContain("profile");
  });

  test("updateScope changes only what is given; the name stays", async () => {
    const french = one(
      await admin(UPDATE_SCOPE, {
        tenantId: tenantA,
        id: read,
        input: { description: { fr: "Consulter vos commandes" } },
      }),
      "updateScope",
    );
    expect(french).toMatchObject({
      name: "orders:read",
      description: { fr: "Consulter vos commandes", en: "Read your orders" },
      claims: ["orders", "region"],
    });
    const claims = one(
      await admin(UPDATE_SCOPE, {
        tenantId: tenantA,
        id: read,
        input: { claims: [] },
      }),
      "updateScope",
    );
    expect(claims).toMatchObject({
      description: { fr: "Consulter vos commandes", en: "Read your orders" },
      claims: [],
    });
    expect(
      codeOf(
        await admin(UPDATE_SCOPE, {
          tenantId: tenantA,
          id: "0123456789abcdef01234567",
          input: { claims: [] },
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("a repeat after a failed record", () => {
  test("createResource and createScope return the stored one and record the event", async () => {
    const actions = async () =>
      (await mongo.db.adminEvents.raw.find({}).toArray()).map(
        (event) => event["action"],
      );
    const uri = "https://api.res-a.example/replay";
    const resource = one(
      await admin(CREATE, { tenantId: tenantA, input: { uri } }),
      "createResource",
    );
    await mongo.db.adminEvents.raw.deleteMany({}); // the record that failed
    const again = one(
      await admin(CREATE, { tenantId: tenantA, input: { uri } }),
      "createResource",
    );
    expect(again.id).toBe(resource.id);
    expect(await actions()).toEqual(["resource.create"]);

    const input = {
      name: "replay:read",
      resourceId: resource.id,
      description: { fr: "Lire", en: "Read" },
      claims: ["a"],
    };
    const scope = one(
      await admin(CREATE_SCOPE, { tenantId: tenantA, input }),
      "createScope",
    );
    await mongo.db.adminEvents.raw.deleteMany({});
    const repeated = one(
      await admin(CREATE_SCOPE, { tenantId: tenantA, input }),
      "createScope",
    );
    expect(repeated.id).toBe(scope.id);
    expect(await actions()).toEqual(["scope.create"]);
    expect(
      codeOf(
        await admin(CREATE_SCOPE, {
          tenantId: tenantA,
          input: { ...input, claims: ["b"] },
        }),
      ),
    ).toBe("CONFLICT");
    await admin(DELETE, { tenantId: tenantA, id: resource.id }); // and its scope
  });
});

describe("permissions and isolation", () => {
  test("a viewer reads but changes nothing", async () => {
    expect(
      many(await viewer(LIST, { tenantId: tenantA }), "resources"),
    ).toHaveLength(2);
    expect(
      many(await viewer(SCOPES, { tenantId: tenantA }), "scopes"),
    ).toHaveLength(3);
    const refused = [
      await viewer(CREATE, {
        tenantId: tenantA,
        input: { uri: "https://x.example/" },
      }),
      await viewer(UPDATE, {
        tenantId: tenantA,
        id: api,
        input: { name: "Nope" },
      }),
      await viewer(DELETE, { tenantId: tenantA, id: api }),
      await viewer(CREATE_SCOPE, {
        tenantId: tenantA,
        input: { name: "nope", resourceId: api },
      }),
      await viewer(UPDATE_SCOPE, {
        tenantId: tenantA,
        id: read,
        input: { claims: ["x"] },
      }),
      await viewer(DELETE_SCOPE, { tenantId: tenantA, id: read }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(6).fill("FORBIDDEN"));
  });

  test("tenant A's admin cannot touch tenant B", async () => {
    const refused = [
      await admin(LIST, { tenantId: tenantB }),
      await admin(GET, { tenantId: tenantB, id: api }),
      await admin(SCOPES, { tenantId: tenantB }),
      await admin(CREATE, { tenantId: tenantB, input: { uri: API } }),
      await admin(UPDATE, {
        tenantId: tenantB,
        id: api,
        input: { name: "Nope" },
      }),
      await admin(DELETE, { tenantId: tenantB, id: api }),
      await admin(CREATE_SCOPE, {
        tenantId: tenantB,
        input: { name: "openid" },
      }),
      await admin(UPDATE_SCOPE, {
        tenantId: tenantB,
        id: read,
        input: { claims: [] },
      }),
      await admin(DELETE_SCOPE, { tenantId: tenantB, id: read }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(9).fill("FORBIDDEN"));
  });

  test("A's resources and scopes are unknown under B's id", async () => {
    expect(
      many(await adminB(LIST, { tenantId: tenantB }), "resources"),
    ).toEqual([]);
    expect(many(await adminB(SCOPES, { tenantId: tenantB }), "scopes")).toEqual(
      [],
    );
    expect(
      (await adminB(GET, { tenantId: tenantB, id: api })).data?.["resource"],
    ).toBeNull();
    const refused = [
      await adminB(UPDATE, {
        tenantId: tenantB,
        id: api,
        input: { name: "Taken" },
      }),
      await adminB(CREATE_SCOPE, {
        tenantId: tenantB,
        input: { name: "steal", resourceId: api },
      }),
      await adminB(UPDATE_SCOPE, {
        tenantId: tenantB,
        id: read,
        input: { claims: ["x"] },
      }),
    ];
    expect(refused.map(codeOf)).toEqual(Array(3).fill("NOT_FOUND"));
    expect(
      (await adminB(DELETE_SCOPE, { tenantId: tenantB, id: read })).data?.[
        "deleteScope"
      ],
    ).toBe(false);
    expect(
      (await adminB(DELETE, { tenantId: tenantB, id: api })).data?.[
        "deleteResource"
      ],
    ).toBe(false);
    // The same URI is another resource in B, and nothing of A moved.
    one(
      await adminB(CREATE, { tenantId: tenantB, input: { uri: API } }),
      "createResource",
    );
    expect(Object.keys(await served("res-b"))).toEqual([API]);
    expect((await served("res-b"))[API]?.scopes).toEqual([]);
    expect(
      one(await admin(GET, { tenantId: tenantA, id: api }), "resource"),
    ).toMatchObject({ name: "Orders API", scopes: [{ id: read }] });
  });
});

describe("deleting", () => {
  test("deleteScope deletes once, then answers false", async () => {
    const extra = one(
      await admin(CREATE_SCOPE, {
        tenantId: tenantA,
        input: { name: "orders:write", resourceId: api },
      }),
      "createScope",
    );
    expect(
      (await admin(DELETE_SCOPE, { tenantId: tenantA, id: extra.id })).data?.[
        "deleteScope"
      ],
    ).toBe(true);
    expect(
      (await admin(DELETE_SCOPE, { tenantId: tenantA, id: extra.id })).data?.[
        "deleteScope"
      ],
    ).toBe(false);
    expect((await served("res-a"))[API]?.scopes).toEqual(["orders:read"]);
  });

  test("deleteResource takes its scopes with it, and only its own", async () => {
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: api })).data?.[
        "deleteResource"
      ],
    ).toBe(true);
    expect(Object.keys(await served("res-a"))).toEqual([
      "https://billing.res-a.example/",
    ]);
    const left = many(await admin(SCOPES, { tenantId: tenantA }), "scopes");
    expect(left.map((scope) => scope["name"]).sort()).toEqual([
      "orders:read",
      "profile",
    ]);
    expect(left.some((scope) => scope["resourceId"] === api)).toBe(false);
    const again = await admin(DELETE, { tenantId: tenantA, id: api });
    expect(again.errors).toBeUndefined();
    expect(again.data?.["deleteResource"]).toBe(false);
  });

  test("deleteResource prunes the exchange rules that target it, in its tenant only", async () => {
    const other = "https://billing.res-a.example/";
    const rules = (targetResources: string[]) => ({
      targetResources,
      subjectClients: "any" as const,
      subjectAgents: false,
      mode: "delegation" as const,
    });
    const a = await mongo.db.tenants.findById(tenantA);
    const b = await mongo.db.tenants.findById(tenantB);
    if (a === undefined || b === undefined) throw new Error("no tenant");
    const gone = "https://gone.res-a.example/";
    const made = one(
      await admin(CREATE, { tenantId: tenantA, input: { uri: gone } }),
      "createResource",
    );
    await clientPoliciesService.setTokenExchange(
      a._id,
      "x-a",
      rules([gone, other]),
    );
    await clientPoliciesService.setTokenExchange(b._id, "x-b", rules([gone]));
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: made.id })).data?.[
        "deleteResource"
      ],
    ).toBe(true);
    expect(
      (await clientPoliciesService.tokenExchange(a._id, "x-a"))
        ?.targetResources,
    ).toEqual([other]);
    expect(
      (await clientPoliciesService.tokenExchange(b._id, "x-b"))
        ?.targetResources,
    ).toEqual([gone]);
    // A repeat is a no-op, and the rule of the other tenant is still there.
    expect(
      (await admin(DELETE, { tenantId: tenantA, id: made.id })).data?.[
        "deleteResource"
      ],
    ).toBe(false);
  });
});

describe("admin events", () => {
  test("each mutation records its event; deleting a resource records its scopes too", async () => {
    await mongo.db.adminEvents.raw.deleteMany({});
    const resource = one(
      await admin(CREATE, {
        tenantId: tenantA,
        input: { uri: "https://audit.res-a.example/v1" },
      }),
      "createResource",
    );
    await admin(UPDATE, {
      tenantId: tenantA,
      id: resource.id,
      input: { name: "Audited" },
    });
    const scope = (name: string) =>
      admin(CREATE_SCOPE, {
        tenantId: tenantA,
        input: { name, resourceId: resource.id },
      });
    const first = one(await scope("a:read"), "createScope");
    const second = one(await scope("a:write"), "createScope");
    await admin(UPDATE_SCOPE, {
      tenantId: tenantA,
      id: first.id,
      input: { description: { en: "Read" } },
    });
    await admin(DELETE_SCOPE, { tenantId: tenantA, id: first.id });
    await admin(DELETE, { tenantId: tenantA, id: resource.id });
    // Refused: nothing recorded.
    await viewer(DELETE, { tenantId: tenantA, id: resource.id });
    const events = await mongo.db.adminEvents.raw
      .find({})
      .sort({ _id: 1 })
      .toArray();
    expect(
      events.map((event) => [event.action, event.target.type, event.target.id]),
    ).toEqual([
      ["resource.create", "resource", resource.id],
      ["resource.update", "resource", resource.id],
      ["scope.create", "scope", first.id],
      ["scope.create", "scope", second.id],
      ["scope.update", "scope", first.id],
      ["scope.delete", "scope", first.id],
      ["scope.delete", "scope", second.id],
      ["resource.delete", "resource", resource.id],
    ]);
    for (const event of events) {
      expect(event.actor).toBe("res-admin-a");
      expect(event.tenantId?.toHexString()).toBe(tenantA);
    }
    await mongo.db.adminEvents.raw.deleteMany({});
  });
});

describe("limits", () => {
  test("a description, a name or claims too long are BAD_USER_INPUT", async () => {
    const created = one(
      await admin(CREATE, {
        tenantId: tenantA,
        input: { uri: "https://limits.res-a.example/v1" },
      }),
      "createResource",
    );
    const scope = (input: Record<string, unknown>) =>
      admin(CREATE_SCOPE, {
        tenantId: tenantA,
        input: { name: "limited", resourceId: created.id, ...input },
      });
    expect(codeOf(await scope({ description: { fr: "x".repeat(301) } }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      codeOf(
        await scope({ claims: Array.from({ length: 51 }, (_, i) => `c${i}`) }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      codeOf(
        await admin(UPDATE, {
          tenantId: tenantA,
          id: created.id,
          input: { name: "n".repeat(101) },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("the console's own resource", () => {
  test("and its scopes cannot be deleted here, even by a platform owner", async () => {
    const operator = consoleAs("res-operator");
    await access.grantPlatform("res-operator", "owner");
    const platform = await mongo.db.tenants.findFirst({
      slug: PLATFORM_TENANT_SLUG,
    });
    const tenantId = platform?._id.toHexString() ?? "";
    // The specs empty the relations: link the tenant again, as the migration does.
    await linkTenantToPlatform(tenantId);
    // Idempotent: the migration seeded it, unless another spec removed it.
    await registerStoredResource({
      tenant: PLATFORM_TENANT_SLUG,
      uri: consoleResource,
      scopes: ["console", "openid"],
    });
    const found = many(await operator(LIST, { tenantId }), "resources").find(
      (resource) => resource["uri"] === consoleResource,
    );
    if (found === undefined) throw new Error("the console resource is seeded");
    const [scope] = rowsOf(found["scopes"]);
    expect(
      codeOf(await operator(DELETE_SCOPE, { tenantId, id: scope?.id ?? "" })),
    ).toBe("BAD_USER_INPUT");
    expect(codeOf(await operator(DELETE, { tenantId, id: found.id }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      one(await operator(GET, { tenantId, id: found.id }), "resource").id,
    ).toBe(found.id);
    // It never takes the client credentials grant: no user behind the token.
    expect(
      codeOf(
        await operator(UPDATE, {
          tenantId,
          id: found.id,
          input: { allowClientCredentials: true },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("a suspended tenant", () => {
  test("is readable, and its writes are TENANT_SUSPENDED for its admin", async () => {
    await tenantsService.suspend(tenantB);
    expect((await adminB(LIST, { tenantId: tenantB })).errors).toBeUndefined();
    expect(
      codeOf(
        await adminB(CREATE, {
          tenantId: tenantB,
          input: { uri: "https://late.res-b.example" },
        }),
      ),
    ).toBe("TENANT_SUSPENDED");
  });
});

describe("the tenant id's spelling", () => {
  test("an upper-case tenant id is the same tenant, as on every module", async () => {
    const lower = await admin(LIST, { tenantId: tenantA });
    const upper = await admin(LIST, { tenantId: tenantA.toUpperCase() });
    expect(upper.errors).toBeUndefined();
    expect(upper.data).toEqual(lower.data);
  });
});
