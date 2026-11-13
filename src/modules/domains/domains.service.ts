import {
  ConflictError,
  type ReadDocumentOf,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { assertWithinQuota } from "@/modules/usage/quota";
import type { TxtResolver } from "./dns";
import { normalizeDomainHost, txtNameOf } from "./domain-host";
import { DomainError } from "./domains.errors";
import type { domains } from "./domains.model";

export type DomainDoc = ReadDocumentOf<typeof domains>;

/** Days a verified domain may fail its recheck before it becomes `unverified`. */
export const RECHECK_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The TXT value to publish: random per claim, so it names this tenant's claim on this host. */
export const mintToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `clavix-verify=${Buffer.from(bytes).toString("base64url")}`;
};

export type CheckFailure = "NO_RECORD" | "MISMATCH" | "LOOKUP_FAILED";

export interface DomainStoreOptions {
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
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * The one way into the `domains` collection. A host is claimed by tenants as
 * `pending`; DNS decides who verifies it first; only a `verified` domain
 * serves anything.
 */
export class DomainStore {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(
    private readonly collection: TypedCollection<typeof domains>,
    private readonly options: DomainStoreOptions,
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
    const owner = await this.tenantOfHost(host);
    if (owner !== undefined) throw this.taken();
    assertWithinQuota("domains", await this.count(tenantId), quota);
    let created: DomainDoc;
    try {
      created = await this.collection.create({
        tenantId,
        host,
        status: "pending",
        txtToken: mintToken(),
        primary: false,
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // A concurrent add of the same host by this tenant: it is the claim.
      const raced = await this.collection.findFirst({ tenantId, host });
      if (raced === undefined) throw error;
      return raced;
    }
    // Two concurrent adds may both have passed the count: the loser backs out.
    try {
      assertWithinQuota("domains", (await this.count(tenantId)) - 1, quota);
    } catch (error) {
      await this.collection.delete(created._id);
      throw error;
    }
    return created;
  }

  /**
   * Asks DNS for `_clavix.<host>` and verifies the claim when the token is
   * there. Returns the claim as it stands and why it did not verify. A claim
   * already verified is returned as it is, without a lookup.
   */
  async verify(
    tenantId: ObjectId,
    id: string,
  ): Promise<{ domain: DomainDoc; failure: CheckFailure | null }> {
    const claim = await this.find(tenantId, id);
    if (claim === undefined) throw notFound();
    if (claim.status === "verified") return { domain: claim, failure: null };
    const failure = await this.check(claim);
    const now = this.now();
    if (failure !== null) {
      const domain = await this.collection.update(claim._id, {
        checkedAt: now,
      });
      return { domain, failure };
    }
    const verified = await this.promote(claim, now);
    return { domain: verified, failure: null };
  }

  /** Makes a verified domain the tenant's issuer host. Idempotent. */
  async setPrimary(tenantId: ObjectId, id: string): Promise<DomainDoc> {
    const claim = await this.find(tenantId, id);
    if (claim === undefined) throw notFound();
    if (claim.status !== "verified") {
      throw new DomainError(
        "DOMAIN_NOT_VERIFIED",
        "Only a verified domain can be made primary",
      );
    }
    if (claim.primary) return claim;
    const previous = await this.primaryHostOf(tenantId);
    const updated = await this.collection.update(claim._id, { primary: true });
    await this.collection.updateMany(
      { tenantId, _id: { $ne: claim._id }, primary: true },
      { primary: false },
    );
    await this.changed(tenantId, [claim.host, ...(previous ? [previous] : [])]);
    return updated;
  }

  /** Removes the claim; `false` when it was already gone. The primary stays. */
  async remove(tenantId: ObjectId, id: string): Promise<boolean> {
    const claim = await this.find(tenantId, id);
    if (claim === undefined) return false;
    if (claim.primary) {
      throw new DomainError(
        "DOMAIN_PRIMARY",
        "Make another domain primary before removing this one",
      );
    }
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
   * One pass over the verified domains: the TXT record is read again. A
   * lookup that could not be answered changes nothing. A domain that fails
   * for `RECHECK_GRACE_DAYS` becomes `unverified` (a primary one keeps its
   * flag and its issuer: nothing moves silently, the owners are told) and
   * `onUnverified` is called once for it.
   */
  async recheckAll(
    onUnverified: (domain: DomainDoc) => Promise<void> = async () => {},
  ): Promise<{ checked: number; unverified: number }> {
    const report = { checked: 0, unverified: 0 };
    const verified = await this.collection.findMany({
      filter: { status: "verified" },
      sort: { checkedAt: 1 },
    });
    for (const claim of verified) {
      const failure = await this.check(claim);
      report.checked++;
      const now = this.now();
      if (failure === "LOOKUP_FAILED") continue;
      if (failure === null) {
        if (claim.failingSince !== null) {
          await this.collection.update(claim._id, {
            failingSince: null,
            checkedAt: now,
          });
        } else {
          await this.collection.update(claim._id, { checkedAt: now });
        }
        continue;
      }
      const since = claim.failingSince ?? now;
      if (now.getTime() - since.getTime() < RECHECK_GRACE_DAYS * DAY_MS) {
        await this.collection.update(claim._id, {
          failingSince: since,
          checkedAt: now,
        });
        continue;
      }
      // Still `primary` when it was: the issuer never changes by itself, and
      // the console shows the banner. It stops serving all the same.
      const lapsed = await this.collection.update(claim._id, {
        status: "unverified",
        failingSince: since,
        checkedAt: now,
      });
      await this.changed(claim.tenantId, [claim.host]);
      report.unverified++;
      try {
        await onUnverified(lapsed);
      } catch (error) {
        this.log(
          `domains: could not tell the owners of ${claim.host}: ${String(error)}`,
        );
      }
    }
    return report;
  }

  // -- internals -----------------------------------------------------------

  private normalise(raw: string): string {
    try {
      return normalizeDomainHost(raw, this.options.platformDomain);
    } catch (error) {
      throw new DomainError("BAD_USER_INPUT", (error as Error).message);
    }
  }

  private taken() {
    return new DomainError(
      "DOMAIN_TAKEN",
      "This domain is already verified by another tenant",
    );
  }

  private async check(claim: DomainDoc): Promise<CheckFailure | null> {
    const answer = await this.options.dns.resolveTxt(txtNameOf(claim.host));
    if (answer.kind === "failed") return "LOOKUP_FAILED";
    if (answer.kind === "none" || answer.values.length === 0) {
      return "NO_RECORD";
    }
    return answer.values.some((value) => value.trim() === claim.txtToken)
      ? null
      : "MISMATCH";
  }

  // Verification: the unique index on verified hosts decides a race; the
  // winner then evicts every other pending (or lapsed) claim on the host.
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
      if (error instanceof ConflictError) throw this.taken();
      throw error;
    }
    await this.collection.deleteMany({
      host: claim.host,
      _id: { $ne: claim._id },
    });
    await this.changed(claim.tenantId, [claim.host]);
    return verified;
  }

  private async changed(tenantId: ObjectId, hosts: string[]) {
    const notify = this.options.onHostsChanged;
    if (notify === undefined) return;
    try {
      const slugHost = await this.options.slugHostOf?.(tenantId.toHexString());
      await notify([...new Set([...hosts, ...(slugHost ? [slugHost] : [])])]);
    } catch (error) {
      this.log(`domains: cache invalidation failed: ${String(error)}`);
    }
  }
}

const notFound = () => new DomainError("NOT_FOUND", "No such domain");
