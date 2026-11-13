import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access } from "@/config/access";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { issuerOf } from "@/modules/tenants/identity";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { userinfoOf } from "@/oauth/building";
import { fingerprintOf } from "@/oauth/resolution";
import { codeOf, consoleAs } from "~/console";

const API = "https://api.res-a.example/v1";
const admin = consoleAs("res-admin-a");
const viewer = consoleAs("res-viewer-a");
const adminB = consoleAs("res-admin-b");

let tenantA = "";
let tenantB = "";

const SCOPE = "id name description { fr en } resourceId claims";
const RESOURCE = `id uri name createdAt scopes { ${SCOPE} }`;
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

type Row = Record<string, unknown> & { id: string };
const one = (result: Awaited<ReturnType<typeof admin>>, field: string) => {
  expect(result.errors).toBeUndefined();
  return result.data?.[field] as Row;
};
const many = (result: Awaited<ReturnType<typeof admin>>, field: string) => {
  expect(result.errors).toBeUndefined();
  return result.data?.[field] as Row[];
};
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
    await mongo.db.resources.raw.deleteMany({ tenantId: tenantId as never });
    await mongo.db.scopes.raw.deleteMany({ tenantId: tenantId as never });
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
      codeOf(await admin(CREATE, { tenantId: tenantA, input: { uri: API } })),
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
});
