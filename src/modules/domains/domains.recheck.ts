import type { TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { TxtResolver } from "./dns";
import { checkClaim } from "./domains.check";
import type { DomainDoc, domains } from "./domains.model";
import type { DomainSystemEvent } from "./events";

/** Days a verified domain may fail its recheck before it becomes `unverified`. */
export const RECHECK_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DomainRecheckDeps {
  dns: TxtResolver;
  now(): Date;
  log(message: string): void;
  /** Forgets the hosts a write changed (the store's cache invalidation). */
  changed(tenantId: ObjectId, hosts: string[]): Promise<void>;
  /** Records a system event; never throws (the store swallows and logs). */
  emit(event: DomainSystemEvent): Promise<void>;
}

/**
 * The periodic recheck of the verified domains (every 6 hours, see
 * `recheck.queue.ts`). A lookup that could not be answered changes nothing. A
 * domain that fails for `RECHECK_GRACE_DAYS` becomes `unverified` (a primary
 * one keeps its flag and its issuer: nothing moves silently, the owners are
 * told) and `onUnverified` is called once for it.
 */
export class DomainRecheck {
  constructor(
    private readonly collection: TypedCollection<typeof domains>,
    private readonly deps: DomainRecheckDeps,
  ) {}

  async recheckAll(
    onUnverified: (domain: DomainDoc) => Promise<void> = async () => {},
  ): Promise<{ checked: number; unverified: number }> {
    const report = { checked: 0, unverified: 0 };
    const verified = await this.collection.findMany({
      filter: { status: "verified" },
      sort: { checkedAt: 1 },
    });
    for (const claim of verified) {
      try {
        await this.recheckOne(claim, report, onUnverified);
      } catch (error) {
        this.deps.log(
          `domains: recheck of ${claim.host} failed: ${String(error)}`,
        );
      }
    }
    return report;
  }

  private async recheckOne(
    claim: DomainDoc,
    report: { checked: number; unverified: number },
    onUnverified: (domain: DomainDoc) => Promise<void>,
  ): Promise<void> {
    const failure = await checkClaim(this.deps.dns, claim);
    report.checked++;
    const now = this.deps.now();
    if (failure === "LOOKUP_FAILED") return;
    if (failure === null) {
      if (claim.failingSince !== null) {
        await this.collection.update(claim._id, {
          failingSince: null,
          checkedAt: now,
        });
      } else {
        await this.collection.update(claim._id, { checkedAt: now });
      }
      return;
    }
    const since = claim.failingSince ?? now;
    if (now.getTime() - since.getTime() < RECHECK_GRACE_DAYS * DAY_MS) {
      await this.collection.update(claim._id, {
        failingSince: since,
        checkedAt: now,
      });
      return;
    }
    // Still `primary` when it was: the issuer never changes by itself, and
    // the console shows the banner. It stops serving all the same.
    const lapsed = await this.collection.update(claim._id, {
      status: "unverified",
      failingSince: since,
      checkedAt: now,
    });
    await this.deps.changed(claim.tenantId, [claim.host]);
    report.unverified++;
    await this.deps.emit({
      action: "domain.lapse",
      tenantId: claim.tenantId,
      domainId: claim._id,
    });
    try {
      await onUnverified(lapsed);
    } catch (error) {
      this.deps.log(
        `domains: could not tell the owners of ${claim.host}: ${String(error)}`,
      );
    }
  }
}
