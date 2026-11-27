import { afterAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { attributesService, attributeValuesService } from "@/config/attributes";
import { mongo } from "@/config/db";
import {
  createEraseReplaced,
  type EraseJob,
  type EraseWorkerQueue,
  eraseOnReplace,
  eraseReplacedQueue,
  eraseReplacedValues,
  startEraseReplacedWorker,
} from "@/config/erase-replaced";
import { exclusive } from "@/config/exclusive";
import { userKey } from "@/console/modules/user-key";
import { janusOver } from "~/janus-double";

const tenant = new ObjectId();
const admin = { kind: "admin", id: "admin-1" } as const;

afterAll(async () => {
  await mongo.db.attributeValues.raw.deleteMany({ tenantId: tenant });
  await mongo.db.userAttributes.raw.deleteMany({ tenantId: tenant });
});

const count = (userId: string) =>
  mongo.db.attributeValues.raw.countDocuments({ tenantId: tenant, userId });

describe("eraseReplacedValues", () => {
  test("a save and the erase of the same user run one after the other: no value outlives the erase", async () => {
    const attribute = await attributesService.create(tenant, {
      key: "erased",
      family: "USER",
      type: "STRING",
      label: [{ locale: "en", text: "Label" }],
    });
    const change = {
      attributeId: attribute._id.toHexString(),
      value: { text: "kept" },
    };
    const save = (userId: string) =>
      exclusive(userKey(tenant.toHexString(), userId), () =>
        attributeValuesService.save(tenant, userId, [change], admin, true),
      );

    // The save is queued first, the erase right behind it: whichever the
    // scheduler starts, the erase runs after the save has landed.
    const saving = save("racer");
    const erasing = eraseReplacedValues(tenant.toHexString(), "racer");
    await Promise.all([saving, erasing]);
    expect(await count("racer")).toBe(0);
  });

  test("the erase waits for the user's lock", async () => {
    const attribute = await attributesService.create(tenant, {
      key: "waits",
      family: "USER",
      type: "STRING",
      label: [{ locale: "en", text: "Label" }],
    });
    await attributeValuesService.save(
      tenant,
      "held",
      [{ attributeId: attribute._id.toHexString(), value: { text: "v" } }],
      admin,
      true,
    );
    let release: () => void = () => {};
    const holder = exclusive(
      userKey(tenant.toHexString(), "held"),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const erasing = eraseReplacedValues(tenant.toHexString(), "held");
    // Let the event loop turn: the erase is queued behind the holder.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await count("held")).toBe(1);
    release();
    await Promise.all([holder, erasing]);
    expect(await count("held")).toBe(0);
  });

  test("another user's values are untouched", async () => {
    const attribute = await attributesService.create(tenant, {
      key: "other",
      family: "USER",
      type: "STRING",
      label: [{ locale: "en", text: "Label" }],
    });
    await attributeValuesService.save(
      tenant,
      "bystander",
      [{ attributeId: attribute._id.toHexString(), value: { text: "v" } }],
      admin,
      true,
    );
    await eraseReplacedValues(tenant.toHexString(), "someone-else");
    expect(await count("bystander")).toBe(1);
  });
});

describe("the erase of a replaced holder, queued", () => {
  const auth = janusOver();

  test("a replacement enqueues the job with ids only", async () => {
    const added: EraseJob[] = [];
    const before = eraseReplacedQueue.current;
    eraseReplacedQueue.current = {
      add: async (job) => {
        added.push(job);
      },
    };
    try {
      await eraseOnReplace("t1", "u1", auth);
    } finally {
      eraseReplacedQueue.current = before;
    }
    expect(added).toEqual([{ tenantId: "t1", userId: "u1" }]);
  });

  test("a queue that cannot be written fails the sign-in", async () => {
    const before = eraseReplacedQueue.current;
    eraseReplacedQueue.current = {
      add: async () => {
        throw new Error("redis down");
      },
    };
    try {
      await expect(eraseOnReplace("t1", "u1", auth)).rejects.toThrow(
        "redis down",
      );
    } finally {
      eraseReplacedQueue.current = before;
    }
  });

  test("the worker retries a job whose first erase failed", async () => {
    let handler: ((job: { data: EraseJob }) => Promise<unknown>) | undefined;
    const queue: EraseWorkerQueue = {
      work: (fn) => {
        handler = fn;
        return { on: () => undefined };
      },
    };
    const erased: string[] = [];
    let failures = 1;
    const run = createEraseReplaced(
      async (_tenantId, userId) => {
        if (failures-- > 0) throw new Error("mongo down");
        erased.push(userId);
      },
      async () => auth,
    );
    startEraseReplacedWorker(run, queue, () => {});
    const job = { data: { tenantId: "t1", userId: "u1" } };
    await expect(handler?.(job)).rejects.toThrow("mongo down");
    expect(erased).toEqual([]);
    // The queue gives the job back after its backoff.
    await handler?.(job);
    expect(erased).toEqual(["u1"]);
  });

  test("a tenant that is gone has nothing left to erase", async () => {
    const erased: string[] = [];
    const run = createEraseReplaced(
      async (_t, userId) => {
        erased.push(userId);
      },
      async () => null,
    );
    await run({ tenantId: "gone", userId: "u1" });
    expect(erased).toEqual([]);
  });
});
