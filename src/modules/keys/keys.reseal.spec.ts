import { afterEach, describe, expect, test } from "bun:test";
import { StoreFailure } from "@softistx/janus";
import { mintWebhookSecret } from "@softistx/janus-webhooks";
import { mongo } from "@/config/db";
import { ConnectionsService } from "@/modules/connections";
import {
  createSecretBox,
  emptySecretResealCounts,
  SignInPolicyService,
  secretContext,
} from "@/modules/sign-in-methods";
import { TenantsService } from "@/modules/tenants";
import { WebhooksService } from "@/modules/webhooks";
import { clearDatabase } from "~/db";
import { quietTenants } from "~/ports";
import { resealAllTenants } from "./keys.reseal";
import { ensureSigningKey } from "./keys.service";
import { createTenantKeys } from "./keys.signing-keys";
import type { ResealDeps, ResealReport } from "./keys.types";
import { resealExitCode } from "./keys.utils";

const oldKey = new Uint8Array(32).fill(1);
const newKey = new Uint8Array(32).fill(2);
const A = "a".repeat(24);
const B = "b".repeat(24);
const now = new Date("2026-11-12T12:00:00Z");
const under = (keys: Uint8Array[]) =>
  createTenantKeys({ db: mongo.db, masterKey: keys });
const quiet = () => {};
type Ring = [Uint8Array, ...Uint8Array[]];

/** Clavix's own sealed stores as the server wires them, over one keyring. */
const storesUnder = (ring: Ring, log: (message: string) => void = quiet) => {
  const tenants = new TenantsService(mongo.db.tenants, {
    ...quietTenants,
    log,
    now: () => new Date(),
  });
  const boxes = {
    social: createSecretBox(ring),
    webhooks: createSecretBox(ring, "webhook-secrets"),
    connections: createSecretBox(ring, "connection-secrets"),
  };
  const webhooks = new WebhooksService(
    mongo.db.webhookEndpoints,
    mongo.db.webhookDeliveries,
    boxes.webhooks,
    {
      policy: { allowPrivate: false, resolve: async () => ["93.184.216.34"] },
      log,
      now: () => new Date(),
      mint: mintWebhookSecret,
    },
  );
  const connections = new ConnectionsService(
    mongo.db.connections,
    boxes.connections,
    {
      txt: { resolveTxt: async () => ({ kind: "none" }) },
      links: async () => 0,
      advertisesIss: async () => false,
      log,
      now: () => new Date(),
    },
  );
  const policy = new SignInPolicyService(tenants, boxes.social, log);
  const secretStores: ResealDeps["secretStores"] = {
    webhookSecrets: (tenantId) => webhooks.resealSecrets(tenantId),
    connectionSecrets: (tenantId) => connections.resealSecrets(tenantId),
    socialSecrets: (tenantId) => policy.resealSecrets(tenantId),
  };
  return { tenants, boxes, webhooks, connections, policy, secretStores };
};

/** No sealed secret of Clavix's own: the specs of the signing keys and the second factor. */
const noStores: ResealDeps["secretStores"] = {
  webhookSecrets: async () => emptySecretResealCounts(),
  connectionSecrets: async () => emptySecretResealCounts(),
  socialSecrets: async () => emptySecretResealCounts(),
};

const SLUGS = { live: "reseal-live", trashed: "reseal-trashed" } as const;

afterEach(async () => {
  await clearDatabase();
  await mongo.db.tenants.raw.deleteMany({
    slug: { $in: Object.values(SLUGS) },
  });
});

describe("master-key rotation: [old] -> [new, old] -> reseal -> [new]", () => {
  test("reseals every tenant, then reports nothing left, and the new key alone opens them", async () => {
    const before = under([oldKey]);
    await ensureSigningKey(before.signingKeysFor, A, now);
    await ensureSigningKey(before.signingKeysFor, B, now);
    const kidA = (await before.signingKeysFor(A).findCurrentKey(now))?.kid;

    // Deploy [new, old]: both tenants still open.
    const ring = [newKey, oldKey];
    expect(
      await under(ring).signingKeysFor(A).findCurrentKey(now),
    ).toMatchObject({
      kid: kidA,
    });

    const deps = {
      db: mongo.db,
      masterKeys: ring as Ring,
      tenantIds: async () => [A, B],
      log: quiet,
      secretStores: noStores,
    };
    const first = await resealAllTenants(deps);
    expect(first).toMatchObject({
      tenants: 2,
      resealed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(resealExitCode(first)).toBe(0);

    // Idempotent: the second run has nothing to do.
    const second = await resealAllTenants(deps);
    expect(second).toMatchObject({ resealed: 0, skipped: 0, failed: 0 });

    // Deploy [new] alone: the same key signs, the old key is no longer needed.
    const after = under([newKey]);
    expect((await after.signingKeysFor(A).findCurrentKey(now))?.kid).toBe(kidA);
    await expect(
      under([oldKey]).signingKeysFor(A).findCurrentKey(now),
    ).rejects.toBeInstanceOf(StoreFailure);
  });

  test("a tenant no key opens is counted as failed and the exit code is non-zero; the others are resealed", async () => {
    const stranger = new Uint8Array(32).fill(7);
    await ensureSigningKey(under([stranger]).signingKeysFor, A, now);
    await ensureSigningKey(under([oldKey]).signingKeysFor, B, now);
    const logs: string[] = [];
    const report = await resealAllTenants({
      db: mongo.db,
      masterKeys: [newKey, oldKey],
      tenantIds: async () => [A, B],
      log: (message) => logs.push(message),
      secretStores: noStores,
    });
    expect(report).toMatchObject({ tenants: 2, resealed: 1, failed: 1 });
    expect(logs.join("\n")).toContain(A);
    expect(resealExitCode(report)).toBe(1);
  });

  const clean: ResealReport = {
    tenants: 1,
    resealed: 0,
    current: 1,
    skipped: 0,
    failed: 0,
    secondFactor: {
      scanned: 0,
      resealed: 0,
      current: 0,
      skipped: 0,
      unreadable: 0,
      sealed: 0,
      behind: 0,
      recoveryCodesBehind: 0,
    },
    webhookSecrets: emptySecretResealCounts(),
    connectionSecrets: emptySecretResealCounts(),
    socialSecrets: emptySecretResealCounts(),
    oldKeyNeededBy: [],
  };

  test("skipped records make the exit code non-zero", () => {
    expect(resealExitCode({ ...clean, skipped: 1 })).toBe(1);
    expect(resealExitCode(clean)).toBe(0);
  });

  test("a second-factor secret skipped, unreadable or behind makes the exit code non-zero", () => {
    for (const field of ["skipped", "unreadable", "behind"] as const) {
      expect(
        resealExitCode({
          ...clean,
          secondFactor: { ...clean.secondFactor, [field]: 1 },
        }),
      ).toBe(1);
    }
  });

  test("the second factor's counts of every tenant are summed", async () => {
    await ensureSigningKey(under([newKey]).signingKeysFor, A, now);
    await ensureSigningKey(under([newKey]).signingKeysFor, B, now);
    const report = await resealAllTenants({
      db: mongo.db,
      masterKeys: [newKey],
      tenantIds: async () => [A, B],
      log: quiet,
      secretStores: noStores,
      resealSecondFactor: async () => ({
        scanned: 3,
        resealed: 2,
        current: 1,
        skipped: 1,
        unreadable: 0,
      }),
    });
    expect(report.secondFactor).toMatchObject({
      scanned: 6,
      resealed: 4,
      current: 2,
      skipped: 2,
    });
    expect(resealExitCode(report)).toBe(1);
  });

  test("a secret of any store skipped, unreadable or behind makes the exit code non-zero", () => {
    for (const store of [
      "webhookSecrets",
      "connectionSecrets",
      "socialSecrets",
    ] as const) {
      for (const field of ["skipped", "unreadable", "behind"] as const) {
        expect(
          resealExitCode({
            ...clean,
            [store]: { ...clean[store], [field]: 1 },
          }),
        ).toBe(1);
      }
    }
  });

  test("recovery codes under the old key do not fail the run", () => {
    expect(
      resealExitCode({
        ...clean,
        secondFactor: { ...clean.secondFactor, recoveryCodesBehind: 3 },
      }),
    ).toBe(0);
  });
});

describe("every sealed store follows the rotation (clavix-api#329)", () => {
  const WEBHOOK_URL = "https://hooks.example.com/in";
  const connection = {
    id: "acme",
    name: "Acme SSO",
    issuer: "https://login.acme.test",
    clientId: "client-1",
    clientSecret: "connection-secret-value",
  };
  const social = {
    provider: "github",
    clientId: "gh-client",
    clientSecret: "social-secret-value",
  } as const;

  /** Two tenants under `ring`, each with a social app; the second in the trash. One webhook endpoint (rolled once) and one connection on the first. */
  const seed = async (ring: Ring) => {
    const { tenants, webhooks, connections, policy } = storesUnder(ring);
    const live = await tenants.create({ slug: SLUGS.live, name: "Live" });
    const trashed = await tenants.create({
      slug: SLUGS.trashed,
      name: "Trashed",
    });
    const liveId = live._id.toHexString();
    const trashedId = trashed._id.toHexString();
    await policy.setSocial(liveId, social);
    await policy.setSocial(trashedId, social);
    await tenants.delete(trashedId);
    const created = await webhooks.createEndpoint(
      liveId,
      { url: WEBHOOK_URL },
      null,
    );
    const rolled = await webhooks.rollSecret(
      liveId,
      created.endpoint._id.toHexString(),
      true,
    );
    await connections.create(liveId, connection, null);
    return {
      liveId,
      trashedId,
      webhookSecrets: [rolled.secret, created.secret] as [string, string],
    };
  };

  const depsOf = (
    ring: Ring,
    ids: string[],
    log: (message: string) => void = quiet,
  ): ResealDeps => ({
    db: mongo.db,
    masterKeys: ring,
    tenantIds: async () => ids,
    log,
    secretStores: storesUnder(ring, log).secretStores,
  });

  test("webhook, connection and social secrets are sealed again, and the new key alone opens them", async () => {
    const { liveId, trashedId, webhookSecrets } = await seed([oldKey]);
    const ring: Ring = [newKey, oldKey];

    const first = await resealAllTenants(depsOf(ring, [liveId, trashedId]));
    const moved = { skipped: 0, unreadable: 0, behind: 0 };
    expect(first.webhookSecrets).toEqual({
      ...moved,
      scanned: 2,
      resealed: 2,
      current: 0,
    });
    expect(first.connectionSecrets).toEqual({
      ...moved,
      scanned: 1,
      resealed: 1,
      current: 0,
    });
    // The tenant in the trash too: a restore must still open its secret.
    expect(first.socialSecrets).toEqual({
      ...moved,
      scanned: 2,
      resealed: 2,
      current: 0,
    });
    expect(first.oldKeyNeededBy).toEqual([]);
    expect(resealExitCode(first)).toBe(0);

    // Idempotent: the second run finds everything under the first key.
    const second = await resealAllTenants(depsOf(ring, [liveId, trashedId]));
    for (const store of [
      second.webhookSecrets,
      second.connectionSecrets,
      second.socialSecrets,
    ]) {
      expect(store).toMatchObject({ ...moved, resealed: 0 });
      expect(store.current).toBe(store.scanned);
    }

    // Deploy [new] alone: every secret still opens, with its value.
    const after = storesUnder([newKey]);
    const [delivery] = await after.webhooks.deliveryEndpoints(liveId);
    expect(delivery?.secrets).toEqual(webhookSecrets);
    // `update` opens the stored client secret to check the record.
    await expect(
      after.connections.update(liveId, connection.id, { name: "Acme" }),
    ).resolves.toMatchObject({ name: "Acme" });
    for (const id of [liveId, trashedId]) {
      const tenant = await after.tenants.anyById(id);
      const [entry] = tenant?.signIn.social ?? [];
      if (entry === undefined) throw new Error("no social app");
      expect(
        after.boxes.social.open(
          entry.secret,
          secretContext(id, entry.provider),
        ),
      ).toBe(social.clientSecret);
    }
    // The trash was written without being restored.
    expect((await after.tenants.anyById(trashedId))?.deletedAt).toBeInstanceOf(
      Date,
    );
  });

  test("a secret no key of the list opens keeps the old key needed: counted, named, exit 1", async () => {
    const stranger = new Uint8Array(32).fill(7);
    const { liveId, trashedId } = await seed([stranger]);
    const logs: string[] = [];
    const report = await resealAllTenants(
      depsOf([newKey, oldKey], [liveId, trashedId], (m) => logs.push(m)),
    );
    const stuck = { resealed: 0, current: 0, skipped: 0 };
    expect(report.webhookSecrets).toEqual({
      ...stuck,
      scanned: 2,
      unreadable: 2,
      behind: 2,
    });
    expect(report.connectionSecrets).toEqual({
      ...stuck,
      scanned: 1,
      unreadable: 1,
      behind: 1,
    });
    expect(report.socialSecrets).toEqual({
      ...stuck,
      scanned: 2,
      unreadable: 2,
      behind: 2,
    });
    expect(report.oldKeyNeededBy).toEqual([
      "webhookSecrets.unreadable: 2",
      "webhookSecrets.behind: 2",
      "connectionSecrets.unreadable: 1",
      "connectionSecrets.behind: 1",
      "socialSecrets.unreadable: 2",
      "socialSecrets.behind: 2",
    ]);
    expect(resealExitCode(report)).toBe(1);
    // Named by id, never by value.
    expect(logs.join("\n")).toContain(connection.id);
    expect(logs.join("\n")).not.toContain(connection.clientSecret);
    expect(logs.join("\n")).toContain(
      `sign-in: the github secret of tenant ${liveId} could not be sealed again`,
    );
  });

  test("a store that throws fails its tenant once and the other stores still run", async () => {
    const { liveId } = await seed([oldKey]);
    const ring: Ring = [newKey, oldKey];
    const deps = depsOf(ring, [liveId]);
    const logs: string[] = [];
    const report = await resealAllTenants({
      ...deps,
      log: (message) => logs.push(message),
      secretStores: {
        ...deps.secretStores,
        webhookSecrets: async () => {
          throw new Error("store down");
        },
      },
    });
    expect(report.failed).toBe(1);
    expect(report.connectionSecrets.resealed).toBe(1);
    expect(report.socialSecrets.resealed).toBe(1);
    expect(report.oldKeyNeededBy).toEqual(["failed: 1"]);
    expect(logs.join("\n")).toContain(`${liveId} (webhookSecrets): store down`);
    expect(resealExitCode(report)).toBe(1);
  });

  test("a tenant changed since it was read is not overwritten (skipped)", async () => {
    const { liveId } = await seed([oldKey]);
    const { tenants, policy } = storesUnder([newKey, oldKey]);
    const stale = await tenants.anyById(liveId);
    if (stale === undefined) throw new Error("no tenant");
    await policy.updateMfa(liveId, { totp: true });
    expect(await tenants.replaceSocial(stale, [])).toBe(false);
    expect((await tenants.anyById(liveId))?.signIn.social).toHaveLength(1);
  });
});
