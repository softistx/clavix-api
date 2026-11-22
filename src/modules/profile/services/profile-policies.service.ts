import {
  ConflictError,
  OptimisticLockError,
  scopeToTenant,
} from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { ProfileField } from "../profile.model";
import { refuseCommon } from "../profile.refusals";
import type {
  ProfilePoliciesOptions,
  ProfilePolicyView,
} from "../profile.types";
import { sortedLocks } from "../rules";

const STALE =
  "The profile locks were changed meanwhile; read them and try again";

/**
 * The version a caller sees: one past the stored one, so that a stored document
 * is never at 0, the version of "nothing stored yet" (a stored `version` starts
 * at 0 too, and two first writes must not be mistaken for one write after the
 * other).
 */
const versionOf = (stored: number): number => stored + 1;

/**
 * A tenant's profile locks (user-attributes slice A4). Every method takes the
 * tenant's id and reads and writes through its scope. A write carries the
 * `version` its caller read (0 while nothing is stored, else one past the stored lock version): a stale one, and the
 * loser of two first writes racing on the unique `tenantId`, are `CONFLICT`,
 * so no write is lost silently. A write that changes nothing stores nothing.
 */
export class ProfilePoliciesService {
  constructor(private readonly options: ProfilePoliciesOptions) {}

  private own(tenantId: ObjectId) {
    return scopeToTenant(this.options.policies, tenantId);
  }

  /** The tenant's locks; `version` 0 and nothing locked while none is stored. */
  async get(tenantId: ObjectId): Promise<ProfilePolicyView> {
    const found = await this.own(tenantId).findFirst({});
    return found === undefined
      ? { tenantId, locked: [], version: 0, updatedAt: null }
      : {
          tenantId,
          locked: sortedLocks(found.locked),
          version: versionOf(found.version),
          updatedAt: found.updatedAt,
        };
  }

  /** The fields locked for the tenant's users' self-service. */
  async lockedFor(tenantId: ObjectId): Promise<ProfileField[]> {
    return (await this.get(tenantId)).locked;
  }

  /** Replaces the locked fields, at the `version` the caller read. */
  async set(
    tenantId: ObjectId,
    locked: readonly ProfileField[],
    version: number,
  ): Promise<ProfilePolicyView> {
    const wanted = sortedLocks(locked);
    const own = this.own(tenantId);
    const found = await own.findFirst({});
    try {
      if (found === undefined) {
        if (version !== 0) refuseCommon("CONFLICT", STALE);
        await own.create({ locked: wanted });
      } else {
        if (versionOf(found.version) !== version) {
          refuseCommon("CONFLICT", STALE);
        }
        const same = sortedLocks(found.locked).join() === wanted.join();
        if (!same) {
          await own.update(found._id, {
            locked: wanted,
            version: found.version,
          });
        }
      }
    } catch (error) {
      // A stale update, or two first writes on the unique `tenantId`.
      if (
        error instanceof OptimisticLockError ||
        error instanceof ConflictError
      ) {
        refuseCommon("CONFLICT", STALE);
      }
      throw error;
    }
    return this.get(tenantId);
  }
}
