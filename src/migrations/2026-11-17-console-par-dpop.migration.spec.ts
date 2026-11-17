import { beforeEach, describe, expect, test } from "bun:test";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { getCollection } from "@softistx/mongo";
import { migrate } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { CONSOLE_CLIENT_ID } from "@/console/identity";
import { tenants } from "@/modules/collections";
import { type PublicOrigin, partitionOf } from "@/modules/tenants/identity";
import { freshMigrationDb } from "~/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import { oauthPolicyMigration } from "./2026-11-16-oauth-policy.migration";
import {
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
    expect(before?.oauth).toEqual({
      par: { required: false },
      dpop: { required: false },
    });
    const client = await consoleClient();
    expect(client?.requirePushedAuthorizationRequests).toBeUndefined();

    expect(await requireParAndDpopOnConsole(db, origin)).toBe(true);
    const after = await platform();
    expect(after?.oauth).toEqual({
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
    await requireParAndDpopOnConsole(db, origin);
    const once = await platform();
    const client = await consoleClient();
    expect(await requireParAndDpopOnConsole(db, origin)).toBe(false);
    const twice = await platform();
    expect(twice?.version).toBe(once?.version ?? -1);
    expect(twice?.oauth).toEqual(once?.oauth as never);
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
    await requireParAndDpopOnConsole(db, origin);
    expect(
      (await db.collection("tenants").findOne({ slug: "other" }))?.["oauth"],
    ).toEqual({ par: { required: false }, dpop: { required: false } });
    expect((await platform())?.oauth.par.required).toBe(true);
    await relaxParAndDpopOnConsole(db, origin);
    expect((await platform())?.oauth).toEqual({
      par: { required: false },
      dpop: { required: false },
    });
    expect((await consoleClient())?.dpopBoundAccessTokens).toBeUndefined();
    expect(
      (await consoleClient())?.requirePushedAuthorizationRequests,
    ).toBeUndefined();
  });
});
