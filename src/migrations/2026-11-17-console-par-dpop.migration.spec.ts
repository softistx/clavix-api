import { beforeEach, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import { migrate } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { tenants } from "@/modules/collections";
import { type PublicOrigin, partitionOf } from "@/modules/tenants";
import { freshMigrationDb } from "~/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import { oauthPolicyMigration } from "./2026-11-16-oauth-policy.migration";
import {
  consolePushedDpopMigration,
  id,
  relaxParAndDpopOnConsole,
  requireParAndDpopOnConsole,
} from "./2026-11-17-console-par-dpop.migration";
import { seedConsole } from "./console-seed";

const origin: PublicOrigin = { scheme: "https", domain: "clavix.test" };

let db: Db;
beforeEach(async () => {
  db = await freshMigrationDb();
  await migrate(db, [clavixTenant, oauthPolicyMigration]);
  await seedConsole(db, origin);
});

const platform = () => getCollection(db, tenants).findFirst({ slug: "clavix" });
const consoleClient = async () => {
  const tenant = await platform();
  if (tenant === undefined) throw new Error("no clavix tenant");
  return createMongoOAuth(db, {
    partition: partitionOf(tenant._id),
  }).findClient(CONSOLE_CLIENT_ID);
};

describe(id, () => {
  test("requires PAR and DPoP on the clavix tenant and its console client, once", async () => {
    const before = await platform();
    expect(before?.oauth).toMatchObject({
      par: { required: false },
      dpop: { required: false },
    });
    const client = await consoleClient();
    expect(client?.requirePushedAuthorizationRequests).toBeUndefined();

    expect(await requireParAndDpopOnConsole(db)).toBe(true);
    const after = await platform();
    expect(after?.oauth).toMatchObject({
      par: { required: true },
      dpop: { required: true },
    });
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    const pushed = await consoleClient();
    expect(pushed?.requirePushedAuthorizationRequests).toBe(true);
    expect(pushed?.dpopBoundAccessTokens).toBe(true);
    // The secret and the redirect URIs are the seed's.
    expect(pushed?.secretHash).toBe(client?.secretHash);
    expect(pushed?.redirectUris).toEqual(client?.redirectUris);
  });

  test("is idempotent: a second run changes nothing, version included", async () => {
    await requireParAndDpopOnConsole(db);
    const once = await platform();
    const client = await consoleClient();
    expect(await requireParAndDpopOnConsole(db)).toBe(false);
    const twice = await platform();
    expect(twice?.version).toBe(once?.version ?? -1);
    expect(twice?.oauth).toEqual(once?.oauth);
    expect(await consoleClient()).toEqual(client);
  });

  test("leaves the other tenants alone, and down relaxes the platform tenant", async () => {
    await db.collection("tenants").insertOne(
      {
        slug: "other",
        oauth: { par: { required: false }, dpop: { required: false } },
      },
      { bypassDocumentValidation: true },
    );
    await requireParAndDpopOnConsole(db);
    expect(
      (await db.collection("tenants").findOne({ slug: "other" }))?.["oauth"],
    ).toEqual({ par: { required: false }, dpop: { required: false } });
    expect((await platform())?.oauth.par.required).toBe(true);
    await relaxParAndDpopOnConsole(db);
    expect((await platform())?.oauth).toMatchObject({
      par: { required: false },
      dpop: { required: false },
    });
    expect((await consoleClient())?.dpopBoundAccessTokens).toBeUndefined();
    expect(
      (await consoleClient())?.requirePushedAuthorizationRequests,
    ).toBeUndefined();
  });

  test("keeps a redirect URI added later and the name, through up and down", async () => {
    const tenant = await platform();
    if (tenant === undefined) throw new Error("no clavix tenant");
    const store = createMongoOAuth(db, {
      partition: partitionOf(tenant._id),
    });
    const seeded = await consoleClient();
    if (seeded === null) throw new Error("no console client");
    const extra = "https://console.clavix.test/other/callback";
    await store.upsertClient({
      ...seeded,
      name: "Renamed",
      redirectUris: [...seeded.redirectUris, extra],
    });
    await requireParAndDpopOnConsole(db);
    const up = await consoleClient();
    expect(up?.redirectUris).toContain(extra);
    expect(up?.name).toBe("Renamed");
    expect(up?.dpopBoundAccessTokens).toBe(true);
    await relaxParAndDpopOnConsole(db);
    const down = await consoleClient();
    expect(down?.redirectUris).toContain(extra);
    expect(down?.name).toBe("Renamed");
    expect(down?.dpopBoundAccessTokens).toBeUndefined();
  });

  test("the registered migration runs up then down", async () => {
    await consolePushedDpopMigration.up({
      db,
      client: db.client,
      session: undefined,
    });
    expect((await platform())?.oauth.dpop.required).toBe(true);
    expect((await consoleClient())?.requirePushedAuthorizationRequests).toBe(
      true,
    );
    await consolePushedDpopMigration.down?.({
      db,
      client: db.client,
      session: undefined,
    });
    expect((await platform())?.oauth.dpop.required).toBe(false);
  });
});
