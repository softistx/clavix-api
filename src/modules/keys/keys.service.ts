import { rotateSigningKeys } from "@softistx/janus-oauth";
import { retireAfterMs, rotationPolicy } from "./keys.rules";
import type {
  EmergencyRotation,
  KeysServiceOptions,
  RotateNowOptions,
  RotationPass,
} from "./keys.types";
import { errorText } from "./keys.utils";

/**
 * The tenants' signing keys and their rotation. It hands out the per-tenant
 * stores and the JWKS (`signingKeysFor`, `jwksFor`) and runs the rotation: the
 * hourly pass over the active tenants, the first key of a new tenant, and the
 * emergency "rotate now". A tenant that fails is logged and the others go on;
 * the results say how many failed so the caller can retry.
 */
export class KeysService {
  constructor(private readonly options: KeysServiceOptions) {}

  /** A tenant's signing-key store (janus), keyed by its hex id. */
  readonly signingKeysFor: KeysServiceOptions["keys"]["signingKeysFor"] = (
    tenantId,
  ) => this.options.keys.signingKeysFor(tenantId);

  /** A tenant's public JWKS at an instant. */
  readonly jwksFor: KeysServiceOptions["keys"]["jwksFor"] = (tenantId, at) =>
    this.options.keys.jwksFor(tenantId, at);

  /** The counter of the changes to each tenant's published keys. */
  get generations() {
    return this.options.generations;
  }

  /**
   * Makes sure the tenant has a signing key (its first, or a replacement): the
   * same idempotent step as the hourly pass, so a tenant seeded by a migration
   * or created by the console signs at once.
   */
  ensureSigningKey(tenantId: string, at: Date = this.options.now()) {
    return rotateSigningKeys(this.signingKeysFor(tenantId), {
      ...rotationPolicy,
      now: at,
    });
  }

  /**
   * One rotation pass over the given (active) tenants. It also creates the
   * first key of a tenant that has none (janus's step inserts a `current` key
   * into an empty store).
   */
  async rotateAll(tenantIds: readonly string[]): Promise<RotationPass> {
    let rotated = 0;
    let failed = 0;
    for (const tenantId of tenantIds) {
      try {
        await this.ensureSigningKey(tenantId);
        rotated += 1;
      } catch (error) {
        failed += 1;
        this.options.log(
          `keys: rotation failed for tenant ${tenantId}: ${errorText(error)}`,
        );
      }
    }
    return { rotated, failed };
  }

  /**
   * "Rotate now": retires each tenant's current key (`retire`, janus's
   * emergency stop for one key) and runs the normal rotation step, which
   * promotes the published `next` key at once, or inserts a fresh `current`
   * one. Only the public port is used: nothing is deleted by hand.
   */
  async rotateNow(
    tenantIds: readonly string[],
    { dropOld = false }: RotateNowOptions = {},
  ): Promise<{ rotated: EmergencyRotation[]; failed: number }> {
    const rotated: EmergencyRotation[] = [];
    let failed = 0;
    for (const tenantId of tenantIds) {
      try {
        rotated.push(await this.emergencyRotate(tenantId, dropOld));
      } catch (error) {
        failed += 1;
        this.options.log(
          `keys: rotate failed for tenant ${tenantId}: ${errorText(error)}`,
        );
      }
    }
    return { rotated, failed };
  }

  private async emergencyRotate(
    tenantId: string,
    dropOld: boolean,
  ): Promise<EmergencyRotation> {
    const store = this.signingKeysFor(tenantId);
    const at = this.options.now();
    const current = await store.findCurrentKey(at);
    if (current !== null) {
      const publishUntil = dropOld
        ? at
        : new Date(at.getTime() + retireAfterMs);
      await store.retire(current.kid, at, publishUntil);
    }
    await rotateSigningKeys(store, { ...rotationPolicy, now: at });
    const next = await store.findCurrentKey(at);
    return {
      tenantId,
      retired: current?.kid ?? null,
      current: next?.kid ?? null,
    };
  }
}
