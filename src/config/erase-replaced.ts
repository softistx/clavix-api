import { ObjectId } from "mongodb";
import { userKey } from "@/console/modules/user-key";
import type { TenantJanus } from "@/modules/users";
import { attributeValuesService } from "./attributes";
import { env } from "./env";
import { exclusive } from "./exclusive";
import { avatarsService } from "./media";
import { redis } from "./redis";
import { clock, reportError } from "./runtime";
import { tenantResolver, tenantsService } from "./tenancy";
import { forTenant } from "./users";

/** What a queued erase carries: ids and when the holder was replaced (ISO 8601). */
export interface EraseJob {
  tenantId: string;
  userId: string;
  replacedAt: string;
}

/** The queue surface the sign-in needs (`redis.queues.eraseReplaced`). */
export interface EraseEnqueuer {
  add(data: EraseJob): Promise<unknown>;
}

/** The queue surface the worker needs. */
export interface EraseWorkerQueue {
  work(handler: (job: { data: EraseJob }) => Promise<unknown>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/** The queue of the erasures to run; none without Redis. Replaceable by the specs. */
export const eraseReplacedQueue: { current: EraseEnqueuer | undefined } = {
  current: redis?.queues.eraseReplaced,
};

/** The janus of a tenant by id, outside a request; `null` for a tenant that is gone or purged. */
const authOfTenant = async (tenantId: string) => {
  const slug = (await tenantsService.anyById(tenantId))?.slug;
  if (slug === undefined) return null;
  const resolved = await tenantResolver.resolveHost(
    `${slug}.${env.CLAVIX_DOMAIN}`,
  );
  return resolved === null ? null : forTenant(resolved);
};

/**
 * The job: the replaced holder's attribute values (`erase`, under the user's
 * lock) and picture, as they stood at `replacedAt`: what the new holder wrote
 * or set since is kept, so a late retry never wipes it. Both are idempotent. A tenant that is gone has nothing
 * left to erase.
 */
export const createEraseReplaced =
  (
    erase: (
      tenantId: string,
      userId: string,
      writtenUntil: Date,
    ) => Promise<void>,
    authOf: (
      tenantId: string,
    ) => ReturnType<typeof authOfTenant> = authOfTenant,
  ) =>
  async ({ tenantId, userId, replacedAt }: EraseJob): Promise<void> => {
    const auth = await authOf(tenantId);
    if (auth === null) return;
    const until = new Date(replacedAt);
    await erase(tenantId, userId, until);
    await avatarsService.remove({ tenantId, userId, auth }, until);
  };

/** Runs each queued erase; a failure throws so the queue retries it with backoff. */
export function startEraseReplacedWorker(
  run: (job: EraseJob) => Promise<void>,
  queue: EraseWorkerQueue,
  log: (message: string) => void,
): void {
  queue
    .work(async ({ data }) => {
      await run(data);
    })
    .on("error", (error) => log(`erase-replaced: ${String(error)}`));
}

/**
 * The previous holder's attribute values are personal data of someone else:
 * the new holder starts with none. Under the user's lock, the one every write
 * of that user's values takes (`setUserAttributeValues`, `deleteUser`), so a
 * concurrent save cannot land after the erase and outlive it.
 */
export function eraseReplacedValues(
  tenantId: string,
  userId: string,
  writtenUntil?: Date,
): Promise<void> {
  return exclusive(userKey(tenantId, userId), async () => {
    await attributeValuesService.removeUser(
      new ObjectId(tenantId),
      userId,
      writtenUntil,
    );
  });
}

/**
 * Queues the erase of the replaced holder's values and picture, retried by the
 * worker; a queue that cannot be written is reported and fails the sign-in.
 * With no queue (no Redis, outside production) it erases now.
 */
export async function eraseOnReplace(
  tenantId: string,
  userId: string,
  auth: TenantJanus,
): Promise<void> {
  const queue = eraseReplacedQueue.current;
  const replacedAt = clock();
  if (queue === undefined) {
    await eraseReplacedValues(tenantId, userId, replacedAt);
    // The janus removal fires the event that deletes the object.
    await avatarsService.remove({ tenantId, userId, auth }, replacedAt);
    return;
  }
  try {
    await queue.add({ tenantId, userId, replacedAt: replacedAt.toISOString() });
  } catch (cause) {
    reportError(
      "sign-in: the erase of the replaced holder was not queued",
      cause,
    );
    throw cause;
  }
}
