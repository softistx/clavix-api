import { ConflictError, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { assertWithinQuota } from "@/modules/usage/usage.rules";
import { checkClaim } from "./domains.check";
import type { TxtResolver } from "./domains.dns";
import {
  badDomainInput,
  domainIsPrimary,
  domainNotFound,
  domainNotVerified,
  domainTaken,
  verifyCooldown,
} from "./domains.errors";
import type { DomainSystemEvent } from "./domains.events";
import type { DomainDoc, domains } from "./domains.model";
import {
  type CheckFailure,
  cooldownSeconds,
  hostsToForget,
  normalizeDomainHost,
  recheckOutcome,
  resolvingHosts,
} from "./domains.rules";
import { mintToken } from "./domains.utils";

export type { CheckFailure, DomainDoc };

export interface DomainsServiceOptions {
  dns: TxtResolver;
  /** The platform apex (`CLAVIX_DOMAIN`): its hosts cannot be claimed. */
  platformDomain: string;
  /**
   * After a write that changes what a host resolves to: the hosts to forget
   * (the claimed host, and the tenant's other hosts when its issuer moved).
   * Errors are logged and swallowed.
   */
  onHostsChanged?: (hosts: string[]) => void | Promise<void>;
  /** The slug host of a tenant, for the cache invalidation of its issuer. */
  slugHostOf?: (tenantId: string) => Promise<string | undefined>;
  /**
   * Records what the platform did to a claim by itself (a lapse, an eviction)
   * as an admin event. A failure is logged and never fails the write.
   */
  record?: (event: DomainSystemEvent) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

/** What one recheck pass did: the claims looked at and the ones that lapsed. */
export interface RecheckReport {
  checked: number;
  unverified: number;
}

/**
 * The one way into the `domains` collection. A host is claimed by tenants as
 * `pending`; DNS decides who verifies it first; only a `verified` domain
 * serves anything. It also runs the periodic recheck of the verified domains
 * (every 6 hours, see `domains.recheck-queue.ts`).
 */
export class DomainsService {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(
    private readonly collection: TypedCollection<typeof domains>,
    private readonly options: DomainsServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
  }

  // -- reads ---------------------------------------------------------------

  async list(tenantId: ObjectId): Promise<DomainDoc[]> {
    return this.collection.findMany({
      filter: { tenantId },
      sort: { createdAt: -1 },
    });
  }

  /** The tenant's own claim `id`, or `undefined` (also for another tenant's id). */
  async find(tenantId: ObjectId, id: string): Promise<DomainDoc | undefined> {
    if (!ObjectId.isValid(id)) return undefined;
    return this.collection.findFirst({ _id: new ObjectId(id), tenantId });
  }

  /** How many claims the tenant holds, pending ones included: the quota's count. */
  count(tenantId: ObjectId): Promise<number> {
    return this.collection.count({ tenantId });
  }

  /**
   * The tenant a host serves, or `undefined`: a verified domain, or the
   * primary domain of a tenant whose recheck lapsed (its issuer must not move
   * silently, so it keeps resolving; `verifiedHost` is stricter).
   */
  async tenantOfHost(host: string): Promise<ObjectId | undefined> {
    const verified = await this.collection.findFirst({
      host,
      status: "verified",
    });
    if (verified !== undefined) return verified.tenantId;
    const lapsed = await this.collection.findFirst({
      host,
      status: "unverified",
      primary: true,
    });
    return lapsed?.tenantId;
  }

  /** The verified domain of `host`, if any: the only kind a certificate is issued for. */
  verifiedHost(host: string): Promise<DomainDoc | undefined> {
    return this.collection.findFirst({ host, status: "verified" });
  }

  /** The tenant's primary host, or `undefined`: the slug host is the issuer. */
  async primaryHostOf(tenantId: ObjectId): Promise<string | undefined> {
    const found = await this.collection.findFirst({ tenantId, primary: true });
    return found?.host;
  }

  /** The tenant's verified hosts. */
  async verifiedHostsOf(tenantId: ObjectId): Promise<string[]> {
    const found = await this.collection.findMany({
      filter: { tenantId, status: "verified" },
    });
    return found.map((d) => d.host);
  }

  /**
   * Every host that resolves to the tenant through `tenantOfHost`: its
   * verified hosts, and its primary host even when its recheck lapsed. What a
   * tenant write drops from the resolver's cache.
   */
  async resolvingHostsOf(tenantId: ObjectId): Promise<string[]> {
    return resolvingHosts(
      await this.verifiedHostsOf(tenantId),
      await this.primaryHostOf(tenantId),
    );
  }

  // -- writes --------------------------------------------------------------

  /**
   * Claims `rawHost` for the tenant. Idempotent (the same host returns the
   * existing claim). `quota` is the plan's `domains` quota (`null`: no limit).
   */
  async add(
    tenantId: ObjectId,
    rawHost: string,
    quota: number | null,
  ): Promise<DomainDoc> {
    const host = this.normalise(rawHost);
    const existing = await this.collection.findFirst({ tenantId, host });
    if (existing !== undefined) return existing;
    // A host another tenant verified is not claimable (it is theirs).
    if ((await this.tenantOfHost(host)) !== undefined) throw domainTaken();
    assertWithinQuota("domains", await this.count(tenantId), quota);
    const created = await this.createClaim(tenantId, host);
    if (created.raced) return created.claim;
    // Two concurrent adds may both have passed the count: the loser backs out.
    try {
      assertWithinQuota("domains", (await this.count(tenantId)) - 1, quota);
    } catch (error) {
      await this.collection.delete(created.claim._id);
      throw error;
    }
    return created.claim;
  }

  /**
   * Asks DNS for `_clavix.<host>` and verifies the claim when the token is
   * there. Returns the claim as it stands and why it did not verify. A claim
   * already verified is returned as it is, without a lookup. A claim checked
   * less than `VERIFY_COOLDOWN_SECONDS` ago is refused (`VERIFY_COOLDOWN`,
   * `retryAfter`) without a lookup: the console cannot be used to hammer DNS.
   */
  async verify(
    tenantId: ObjectId,
    id: string,
  ): Promise<{ domain: DomainDoc; failure: CheckFailure | null }> {
    const claim = await this.find(tenantId, id);
    if (claim === undefined) throw domainNotFound();
    if (claim.status === "verified") return { domain: claim, failure: null };
    const now = this.now();
    const wait = cooldownSeconds(claim.checkedAt, now);
    if (wait > 0) throw verifyCooldown(wait);
    const failure = await checkClaim(this.options.dns, claim);
    if (failure !== null) {
      const domain = await this.collection.update(claim._id, {
        checkedAt: now,
      });
      return { domain, failure };
    }
    return { domain: await this.promote(claim, now), failure: null };
  }

  /** Makes a verified domain the tenant's issuer host. Idempotent. */
  async setPrimary(tenantId: ObjectId, id: string): Promise<DomainDoc> {
    const claim = await this.find(tenantId, id);
    if (claim === undefined) throw domainNotFound();
    if (claim.status !== "verified") throw domainNotVerified();
    if (claim.primary) return claim;
    const previous = await this.primaryHostOf(tenantId);
    const updated = await this.collection.update(claim._id, { primary: true });
    await this.collection.updateMany(
      { tenantId, _id: { $ne: claim._id }, primary: true },
      { primary: false },
    );
    // Every verified host's cached issuer followed the old primary.
    await this.changed(tenantId, [
      ...(await this.verifiedHostsOf(tenantId)),
      ...(previous ? [previous] : []),
    ]);
    return updated;
  }

  /** Removes the claim; `false` when it was already gone. The primary stays. */
  async remove(tenantId: ObjectId, id: string): Promise<boolean> {
    const claim = await this.find(tenantId, id);
    if (claim === undefined) return false;
    if (claim.primary) throw domainIsPrimary();
    await this.collection.delete(claim._id);
    await this.changed(tenantId, [claim.host]);
    return true;
  }

  /** Every claim of a purged tenant. */
  async deleteOwnedBy(tenantId: ObjectId): Promise<number> {
    const claims = await this.collection.findMany({ filter: { tenantId } });
    if (claims.length === 0) return 0;
    const count = await this.collection.deleteMany({ tenantId });
    await this.changed(
      tenantId,
      claims.map((c) => c.host),
    );
    return count;
  }

  // -- recheck -------------------------------------------------------------

  /**
   * One recheck pass over the verified domains. A lookup that could not be
   * answered changes nothing. A domain that fails for `RECHECK_GRACE_DAYS`
   * becomes `unverified` (a primary one keeps its flag and its issuer: nothing
   * moves silently, the owners are told) and `onUnverified` is called once
   * for it.
   */
  async recheckAll(
    onUnverified: (domain: DomainDoc) => Promise<void> = async () => {},
  ): Promise<RecheckReport> {
    const report = { checked: 0, unverified: 0 };
    const verified = await this.collection.findMany({
      filter: { status: "verified" },
      sort: { checkedAt: 1 },
    });
    for (const claim of verified) {
      try {
        await this.recheckOne(claim, report, onUnverified);
      } catch (error) {
        this.log(`domains: recheck of ${claim.host} failed: ${String(error)}`);
      }
    }
    return report;
  }

  // -- internals -----------------------------------------------------------

  private async recheckOne(
    claim: DomainDoc,
    report: RecheckReport,
    onUnverified: (domain: DomainDoc) => Promise<void>,
  ): Promise<void> {
    const failure = await checkClaim(this.options.dns, claim);
    report.checked++;
    const now = this.now();
    const outcome = recheckOutcome(failure, claim, now);
    if (outcome.kind === "skip") return;
    if (outcome.kind === "fresh") {
      await this.collection.update(
        claim._id,
        outcome.clearFailing
          ? { failingSince: null, checkedAt: now }
          : { checkedAt: now },
      );
      return;
    }
    if (outcome.kind === "failing") {
      await this.collection.update(claim._id, {
        failingSince: outcome.since,
        checkedAt: now,
      });
      return;
    }
    await this.lapse(claim, outcome.since, now, onUnverified);
    report.unverified++;
  }

  /**
   * Still `primary` when it was: the issuer never changes by itself, and the
   * console shows the banner. It stops serving all the same.
   */
  private async lapse(
    claim: DomainDoc,
    since: Date,
    now: Date,
    onUnverified: (domain: DomainDoc) => Promise<void>,
  ): Promise<void> {
    const lapsed = await this.collection.update(claim._id, {
      status: "unverified",
      failingSince: since,
      checkedAt: now,
    });
    await this.changed(claim.tenantId, [claim.host]);
    await this.emit({
      action: "domain.lapse",
      tenantId: claim.tenantId,
      domainId: claim._id,
    });
    try {
      await onUnverified(lapsed);
    } catch (error) {
      this.log(
        `domains: could not tell the owners of ${claim.host}: ${String(error)}`,
      );
    }
  }

  /** Inserts the pending claim; `raced` when a concurrent add of the same host won. */
  private async createClaim(
    tenantId: ObjectId,
    host: string,
  ): Promise<{ claim: DomainDoc; raced: boolean }> {
    try {
      const claim = await this.collection.create({
        tenantId,
        host,
        status: "pending",
        txtToken: mintToken(),
        primary: false,
      });
      return { claim, raced: false };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // A concurrent add of the same host by this tenant: it is the claim.
      const raced = await this.collection.findFirst({ tenantId, host });
      if (raced === undefined) throw error;
      return { claim: raced, raced: true };
    }
  }

  /**
   * Verification: the unique index on verified hosts decides a race; the
   * winner then evicts every other pending (or lapsed) claim on the host.
   */
  private async promote(claim: DomainDoc, now: Date): Promise<DomainDoc> {
    let verified: DomainDoc;
    try {
      verified = await this.collection.update(claim._id, {
        status: "verified",
        verifiedAt: now,
        checkedAt: now,
        failingSince: null,
      });
    } catch (error) {
      if (error instanceof ConflictError) throw domainTaken();
      throw error;
    }
    await this.evictLosers(claim);
    await this.changed(claim.tenantId, [claim.host]);
    return verified;
  }

  private async evictLosers(winner: DomainDoc): Promise<void> {
    const others = { host: winner.host, _id: { $ne: winner._id } };
    const evicted = await this.collection.findMany({ filter: others });
    await this.collection.deleteMany(others);
    // A lapsed primary evicted here moves its tenant's issuer back to the
    // slug host: that tenant's cached entries must go too.
    for (const loser of evicted) {
      if (loser.primary) await this.changed(loser.tenantId, [winner.host]);
      await this.emit({
        action: "domain.evict",
        tenantId: loser.tenantId,
        domainId: loser._id,
      });
    }
  }

  private normalise(raw: string): string {
    try {
      return normalizeDomainHost(raw, this.options.platformDomain);
    } catch (error) {
      throw badDomainInput((error as Error).message);
    }
  }

  private async emit(event: DomainSystemEvent) {
    try {
      await this.options.record?.(event);
    } catch (error) {
      this.log(
        `domains: could not record the ${event.action} event: ${String(error)}`,
      );
    }
  }

  private async changed(tenantId: ObjectId, hosts: string[]) {
    const notify = this.options.onHostsChanged;
    if (notify === undefined) return;
    try {
      const slugHost = await this.options.slugHostOf?.(tenantId.toHexString());
      await notify(hostsToForget(hosts, slugHost));
    } catch (error) {
      this.log(`domains: cache invalidation failed: ${String(error)}`);
    }
  }
}
