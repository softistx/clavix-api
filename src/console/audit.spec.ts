import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { createApp } from "@/app";
import { access } from "@/config/access";
import { adminEventRecorder } from "@/config/admin-events";
import { createConsoleDeps } from "@/config/console";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { verifiedCallers } from "~/console";
import { adminEvents } from "./admin-events/admin-events.model";
import {
  type AdminEventRecorder,
  createAdminEventRecorder,
} from "./admin-events/recorder";
import { type Audits, auditProblems } from "./audit";
import { onPlatform, onTenant } from "./guard";
import { CONSOLE_PATH } from "./identity";
import { audits as consoleAudits } from "./modules";
import { createConsoleSchema } from "./schema";

// Test-only mutations, merged with the console's own (whose declarations
// `specAudits` carries along). `rename` and `removeOperator` record what they
// did; `renameTwice` records two events.
const typeDefs = `type Mutation {
  rename(tenantId: ID!, id: ID!): Boolean!
  renameTwice(tenantId: ID!, id: ID!): Boolean!
  removeOperator(id: ID!): Boolean!
}`;
const specAudits: Audits = {
  ...consoleAudits,
  "Mutation.rename": "thing.rename",
  "Mutation.renameTwice": "thing.rename",
  "Mutation.removeOperator": "operator.remove",
};
const tenantOfArgs = (args: Record<string, unknown>) =>
  String(args["tenantId"]);
const schema = createConsoleSchema({
  typeDefs,
  resolvers: {
    Mutation: {
      rename: async (
        _: unknown,
        args: { tenantId: string; id: string },
        ctx,
      ) => {
        await ctx.audit("thing.rename", {
          type: "thing",
          id: args.id,
          tenantId: args.tenantId,
        });
        return true;
      },
      renameTwice: async (
        _: unknown,
        args: { tenantId: string; id: string },
        ctx,
      ) => {
        const target = { type: "thing", id: args.id, tenantId: args.tenantId };
        await ctx.audit("thing.rename", target);
        await ctx.audit("thing.rename", target);
        return true;
      },
      removeOperator: async (_: unknown, args: { id: string }, ctx) => {
        await ctx.audit("operator.remove", {
          type: "user",
          id: args.id,
          tenantId: null,
        });
        return true;
      },
    },
  },
  guards: {
    "Mutation.rename": onTenant("edit", tenantOfArgs),
    "Mutation.renameTwice": onTenant("edit", tenantOfArgs),
    "Mutation.removeOperator": onPlatform("manage"),
  },
});

const deps = createConsoleDeps({ serverFor: async () => null });
const tenantA = new ObjectId().toHexString();
const tenantB = new ObjectId().toHexString();
const ADMIN_A = "audit-admin-a";
const VIEWER_A = "audit-viewer-a";
const OPERATOR = "audit-operator";

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}
const as = (
  userId: string,
  query: string,
  options: { recorder?: AdminEventRecorder; headers?: HeadersInit } = {},
) =>
  createApp({
    console: {
      ...verifiedCallers(deps),
      ...(options.recorder === undefined
        ? {}
        : { adminEvents: options.recorder }),
      schema,
      authenticate: async () => ({
        userId,
        clientId: CONSOLE_CLIENT_ID,
        grantId: "g",
        scopes: ["console"],
        clientName: null,
        bound: null,
      }),
    },
  })
    .request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
        ...options.headers,
      },
      body: JSON.stringify({ query }),
    })
    .then((r) => r.json() as Promise<GqlResult>);
const code = (r: GqlResult) => r.errors?.[0]?.extensions?.code;
const stored = () =>
  mongo.db.adminEvents.raw.find({}).sort({ _id: 1 }).toArray();

beforeEach(async () => {
  await mongo.db.adminEvents.raw.deleteMany({});
  await access.grantTenant(tenantA, ADMIN_A, "admin");
  await access.grantTenant(tenantA, VIEWER_A, "viewer");
  await access.grantPlatform(OPERATOR, "owner");
  // As a created tenant is (config/tenancy.ts): the operator's role reaches both.
  await access.linkTenant(tenantA);
  await access.linkTenant(tenantB);
});

afterAll(async () => {
  await mongo.db.adminEvents.raw.deleteMany({});
  // As console.spec.ts does: the permission tuples are a spec's own.
  await oauthDb.collection("relations").deleteMany({});
});

describe("every mutation declares its audit action", () => {
  test("the real schema has no mutation without one, and no stray declaration", async () => {
    const { consoleSchema } = await import("./schema");
    expect(auditProblems(consoleSchema, consoleAudits)).toEqual({
      undeclared: [],
      stray: [],
      malformed: [],
    });
  });

  test("a schema whose mutations all declare one passes", () => {
    expect(auditProblems(schema, specAudits)).toEqual({
      undeclared: [],
      stray: [],
      malformed: [],
    });
  });

  test("a mutation with no declared action is reported", () => {
    const { "Mutation.rename": _, ...missing } = specAudits;
    expect(auditProblems(schema, missing).undeclared).toEqual([
      "Mutation.rename",
    ]);
    expect(auditProblems(schema, consoleAudits).undeclared).toEqual([
      "Mutation.rename",
      "Mutation.renameTwice",
      "Mutation.removeOperator",
    ]);
  });

  test("a declaration for no mutation, or a query, is reported", () => {
    expect(
      auditProblems(schema, {
        ...specAudits,
        "Mutation.renmae": "thing.rename",
        "Query.me": "me.read",
      }).stray,
    ).toEqual(["Mutation.renmae", "Query.me"]);
  });

  test("an action that is not <noun>.<verb> is reported", () => {
    expect(
      auditProblems(schema, {
        ...specAudits,
        "Mutation.rename": "Thing.Rename",
        "Mutation.removeOperator": "remove operator.now" as never,
      }).malformed,
    ).toEqual(["Mutation.rename", "Mutation.removeOperator"]);
  });
});

describe("ctx.audit", () => {
  test("appends who, what, which tenant, which target, when and the request", async () => {
    const before = Date.now();
    const result = await as(
      ADMIN_A,
      `mutation { rename(tenantId: "${tenantA}", id: "t-1") }`,
    );
    expect(result.errors).toBeUndefined();
    const events = await stored();
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("no event");
    expect(Object.keys(event).sort()).toEqual([
      "_id",
      "action",
      "actor",
      "at",
      "requestId",
      "target",
      "tenantId",
    ]);
    expect(event).toMatchObject({
      actor: ADMIN_A,
      action: "thing.rename",
      target: { type: "thing", id: "t-1" },
    });
    expect((event["tenantId"] as ObjectId).toHexString()).toBe(tenantA);
    expect((event["at"] as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(event["requestId"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("an action on the platform has no tenant", async () => {
    const result = await as(OPERATOR, 'mutation { removeOperator(id: "u-9") }');
    expect(result.errors).toBeUndefined();
    expect(await stored()).toMatchObject([
      {
        actor: OPERATOR,
        action: "operator.remove",
        tenantId: null,
        target: { type: "user", id: "u-9" },
      },
    ]);
  });

  test("the events of one request share its id; a client's x-request-id is not believed", async () => {
    await as(
      ADMIN_A,
      `mutation { renameTwice(tenantId: "${tenantA}", id: "t-1") }`,
      { headers: { "x-request-id": "forged" } },
    );
    await as(
      ADMIN_A,
      `mutation { rename(tenantId: "${tenantA}", id: "t-1") }`,
      {
        headers: { "x-request-id": "forged" },
      },
    );
    const ids = (await stored()).map((event) => event["requestId"] as string);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1] as string);
    expect(ids[2]).not.toBe(ids[0] as string);
    expect(ids).not.toContain("forged");
  });

  test("a refused mutation records nothing: a viewer, and tenant A's admin on B", async () => {
    expect(
      code(
        await as(
          VIEWER_A,
          `mutation { rename(tenantId: "${tenantA}", id: "t-1") }`,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(
        await as(
          ADMIN_A,
          `mutation { rename(tenantId: "${tenantB}", id: "t-1") }`,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      code(await as(ADMIN_A, 'mutation { removeOperator(id: "u-9") }')),
    ).toBe("FORBIDDEN");
    expect(await stored()).toEqual([]);
  });

  test("tenantId is stored as the tenant's ObjectId, so a tenant's events are found by it", async () => {
    await as(
      OPERATOR,
      `mutation { rename(tenantId: "${tenantA}", id: "a-1") }`,
    );
    await as(
      OPERATOR,
      `mutation { rename(tenantId: "${tenantB}", id: "b-1") }`,
    );
    const ofA = await mongo.db.adminEvents.raw
      .find({ tenantId: new ObjectId(tenantA) })
      .toArray();
    expect(ofA.map((event) => event["target"])).toEqual([
      { type: "thing", id: "a-1" },
    ]);
  });

  test("a failed record fails the mutation", async () => {
    const result = await as(
      ADMIN_A,
      `mutation { rename(tenantId: "${tenantA}", id: "t-1") }`,
      {
        recorder: {
          record: async () => {
            throw new Error("database down");
          },
        },
      },
    );
    expect(result.data).toBeNull();
    expect(result.errors).toHaveLength(1);
    // Masked: the cause is not the caller's business.
    expect(JSON.stringify(result.errors)).not.toContain("database down");
  });
});

describe("the recorder", () => {
  const event = {
    actor: "u-1",
    action: "thing.rename",
    tenantId: null,
    target: { type: "thing", id: "t-1" },
    requestId: "r-1",
  } as const;

  test("stores nothing beyond the target's type and id", async () => {
    await adminEventRecorder.record({
      ...event,
      target: { ...event.target, secret: "s3cret", before: "old" } as never,
      secret: "s3cret",
    } as never);
    const [found] = await stored();
    expect(found?.["target"]).toEqual({ type: "thing", id: "t-1" });
    expect(JSON.stringify(found)).not.toContain("s3cret");
    expect(JSON.stringify(found)).not.toContain("old");
  });

  test("refuses an action that is not <noun>.<verb>, and a tenant id that is not one", async () => {
    await expect(
      adminEventRecorder.record({ ...event, action: "Renamed it" as never }),
    ).rejects.toThrow();
    await expect(
      adminEventRecorder.record({ ...event, tenantId: "not-an-id" }),
    ).rejects.toThrow();
    expect(await stored()).toEqual([]);
  });

  test("the time is the recorder's clock", async () => {
    const at = new Date("2026-11-12T10:00:00.000Z");
    await createAdminEventRecorder(mongo.db.adminEvents, () => at).record(
      event,
    );
    expect((await stored())[0]?.["at"]).toEqual(at);
  });

  test("the server refuses a document with a field the schema does not have", async () => {
    await expect(
      mongo.db.adminEvents.raw.insertOne({
        _id: new ObjectId(),
        actor: "u-1",
        action: "thing.rename",
        tenantId: null,
        target: { type: "thing", id: "t-1", before: "old" } as never,
        at: new Date(),
        requestId: "r-1",
      }),
    ).rejects.toThrow();
  });

  test("it only appends", () => {
    expect(Object.keys(adminEventRecorder)).toEqual(["record"]);
  });

  test("the collection is indexed by tenant and by actor, newest first", async () => {
    const indexes = await mongo.db.adminEvents.raw.indexes();
    expect(indexes.map((index) => [index.name, index.key])).toEqual(
      expect.arrayContaining([
        ["adminEvents_tenant_at", { tenantId: 1, at: -1 }],
        ["adminEvents_actor_at", { actor: 1, at: -1 }],
      ]),
    );
    expect(adminEvents.indexes).toHaveLength(2);
  });
});
