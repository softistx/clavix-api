import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import {
  emptySecretResealCounts,
  type SecretBox,
  type SecretResealCounts,
} from "@/modules/sign-in-methods";
import { assertWithinQuota } from "@/modules/usage";
import { WebhookError } from "./webhooks.errors";
import type { webhookDeliveries, webhookEndpoints } from "./webhooks.model";
import { DELIVERIES_PER_ENDPOINT } from "./webhooks.model";
import {
  descriptionOf,
  endpointChanges,
  GIVE_UP_LIMIT,
  isLive,
  rolledSecrets,
  typesOf,
} from "./webhooks.rules";
import type {
  AttemptRecord,
  DeliveryEndpoint,
  EndpointInput,
  EndpointPatch,
  WebhookDeliveryDoc,
  WebhookEndpointDoc,
  WebhooksServiceOptions,
} from "./webhooks.types";
import { checkWebhookUrl, WebhookUrlError } from "./webhooks.url-policy";
import {
  attemptDoc,
  behindCount,
  clampLimit,
  contextOf,
  deliveryEndpointOf,
  MAX_LISTED,
} from "./webhooks.utils";

/**
 * A tenant's webhooks: its endpoints (D19-D21) and their delivery attempts
 * (M4 W2). Every method takes the tenant's id and reads or writes through its
 * scope, so an endpoint of A is unknown to B. A secret is returned once, by
 * `createEndpoint` and `rollSecret`, and never again; at rest it is sealed
 * with the keyring, bound to its tenant and endpoint. The attempts are the
 * last 100 per endpoint, 7 days (the collection's TTL).
 */
export class WebhooksService {
  private readonly now: () => Date;
  private readonly mint: () => string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly endpoints: TypedCollection<typeof webhookEndpoints>,
    private readonly deliveries: TypedCollection<typeof webhookDeliveries>,
    private readonly box: SecretBox,
    private readonly options: WebhooksServiceOptions,
  ) {
    this.now = options.now;
    this.mint = options.mint;
    this.log = options.log;
  }

  private scoped(tenantId: string) {
    return scopeToTenant(this.endpoints, new ObjectId(tenantId));
  }

  private scopedAttempts(tenantId: string) {
    return scopeToTenant(this.deliveries, new ObjectId(tenantId));
  }

  countEndpoints(tenantId: string): Promise<number> {
    return this.scoped(tenantId).count();
  }

  async listEndpoints(tenantId: string): Promise<WebhookEndpointDoc[]> {
    return this.scoped(tenantId).findMany({ sort: { createdAt: 1 } });
  }

  findEndpoint(
    tenantId: string,
    id: string,
  ): Promise<WebhookEndpointDoc | undefined> {
    if (!ObjectId.isValid(id)) return Promise.resolve(undefined);
    return this.scoped(tenantId).findById(id);
  }

  private async getEndpoint(tenantId: string, id: string) {
    const found = await this.findEndpoint(tenantId, id);
    if (found === undefined) {
      throw new WebhookError("NOT_FOUND", "No such webhook endpoint");
    }
    return found;
  }

  /** Whether `url` is still allowed (shape and address); a `BAD_USER_INPUT` when it is not. */
  async checkAddress(url: string): Promise<void> {
    try {
      await checkWebhookUrl(url, this.options.policy);
    } catch (error) {
      if (error instanceof WebhookUrlError) {
        throw new WebhookError("BAD_USER_INPUT", error.message, "url");
      }
      throw error;
    }
  }

  /**
   * Creates an endpoint and its first secret, returned here once. The quota
   * check and the insert are not atomic: the caller holds a lock per tenant.
   */
  async createEndpoint(
    tenantId: string,
    input: EndpointInput,
    quota: number | null,
  ): Promise<{ endpoint: WebhookEndpointDoc; secret: string }> {
    await this.checkAddress(input.url);
    const types = typesOf(input.types);
    const description = descriptionOf(input.description) ?? "";
    const scoped = this.scoped(tenantId);
    assertWithinQuota("webhooks", await scoped.count(), quota);
    const _id = new ObjectId();
    const secret = this.mint();
    const endpoint = await scoped.create({
      _id,
      url: new URL(input.url).href,
      description,
      types,
      enabled: true,
      secrets: [this.sealed(tenantId, _id, secret, this.now(), null)],
      consecutiveGiveUps: 0,
      disabledReason: null,
    });
    return { endpoint, secret };
  }

  async updateEndpoint(
    tenantId: string,
    id: string,
    patch: EndpointPatch,
  ): Promise<WebhookEndpointDoc> {
    const current = await this.getEndpoint(tenantId, id);
    if (patch.url !== undefined && patch.url !== current.url) {
      await this.checkAddress(patch.url);
    }
    const set = endpointChanges(current, patch);
    // Switching on re-checks the address too: the host may have moved since.
    if (set.enabled === true && set.url === undefined) {
      await this.checkAddress(current.url);
    }
    if (Object.keys(set).length === 0) return current;
    return this.scoped(tenantId).update(current._id, set);
  }

  async deleteEndpoint(tenantId: string, id: string): Promise<void> {
    const current = await this.getEndpoint(tenantId, id);
    await this.scoped(tenantId).delete(current._id);
  }

  /**
   * A new secret, returned once. `keepPrevious` leaves the current one signing
   * for 24 hours (both signatures are sent, D19); without it every older
   * secret is dropped at once ("expire now").
   */
  async rollSecret(
    tenantId: string,
    id: string,
    keepPrevious: boolean,
  ): Promise<{ endpoint: WebhookEndpointDoc; secret: string }> {
    const current = await this.getEndpoint(tenantId, id);
    const now = this.now();
    const secret = this.mint();
    const fresh = this.sealed(tenantId, current._id, secret, now, null);
    const secrets = rolledSecrets(fresh, current.secrets, keepPrevious, now);
    const endpoint = await this.scoped(tenantId).update(current._id, {
      secrets,
    });
    return { endpoint, secret };
  }

  private sealed(
    tenantId: string,
    endpointId: ObjectId,
    secret: string,
    createdAt: Date,
    expiresAt: Date | null,
  ) {
    return {
      sid: crypto.randomUUID().slice(0, 8),
      sealed: this.box.seal(
        secret,
        contextOf(tenantId, endpointId.toHexString()),
      ),
      createdAt,
      expiresAt,
    };
  }

  /** The tenant's endpoints as `webhooks()` takes them: secrets opened, the expired ones left out. */
  async deliveryEndpoints(tenantId: string): Promise<DeliveryEndpoint[]> {
    const now = this.now();
    const found: DeliveryEndpoint[] = [];
    for (const doc of await this.scoped(tenantId).findMany({})) {
      // No secret to sign with (the key left the keyring): never sent unsigned,
      // and left out, so what waits for it is given up as `endpointRemoved`.
      const endpoint = deliveryEndpointOf(
        doc,
        this.openSecrets(tenantId, doc, now),
      );
      if (endpoint !== undefined) found.push(endpoint);
    }
    return found;
  }

  private openSecrets(tenantId: string, doc: WebhookEndpointDoc, now: Date) {
    const id = doc._id.toHexString();
    const opened: string[] = [];
    for (const entry of doc.secrets.filter((secret) => isLive(secret, now))) {
      try {
        opened.push(this.box.open(entry.sealed, contextOf(tenantId, id)));
      } catch {
        this.log(`webhooks: a secret of endpoint ${id} could not be opened`);
      }
    }
    return opened;
  }

  /**
   * Seals the tenant's endpoint secrets again under the keyring's first key
   * (`keys:reseal`, a master-key rotation), the rolled ones included. Each
   * envelope is replaced only if it is still the one read, so a roll made
   * meanwhile is never overwritten (`skipped`: run again). One no key opens
   * is left as it is and logged by endpoint id (`unreadable`).
   */
  async resealSecrets(tenantId: string): Promise<SecretResealCounts> {
    const counts = emptySecretResealCounts();
    for (const doc of await this.scoped(tenantId).findMany({})) {
      for (const entry of doc.secrets) {
        counts.scanned += 1;
        await this.resealEntry(tenantId, doc, entry, counts);
      }
    }
    for (const doc of await this.scoped(tenantId).findMany({})) {
      counts.behind += behindCount(doc.secrets, this.box.kid);
    }
    return counts;
  }

  private async resealEntry(
    tenantId: string,
    doc: WebhookEndpointDoc,
    entry: WebhookEndpointDoc["secrets"][number],
    counts: SecretResealCounts,
  ): Promise<void> {
    if (entry.sealed.kid === this.box.kid) {
      counts.current += 1;
      return;
    }
    const id = doc._id.toHexString();
    let sealed: ReturnType<SecretBox["reseal"]>;
    try {
      sealed = this.box.reseal(entry.sealed, contextOf(tenantId, id));
    } catch {
      counts.unreadable += 1;
      this.log(
        `webhooks: a secret of endpoint ${id} could not be sealed again`,
      );
      return;
    }
    const written = await this.scoped(tenantId).updateMany(
      {
        _id: doc._id,
        secrets: {
          $elemMatch: { sid: entry.sid, "sealed.ct": entry.sealed.ct },
        },
      },
      { $set: { "secrets.$.sealed": sealed } },
    );
    if (written > 0) counts.resealed += 1;
    else counts.skipped += 1;
  }

  /** A delivery got a 2xx: the run of given-up deliveries ends (D20). */
  async recordDelivered(tenantId: string, id: string): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await this.scoped(tenantId).updateMany(
      { _id: new ObjectId(id), consecutiveGiveUps: { $gt: 0 } },
      { consecutiveGiveUps: 0 },
    );
  }

  /**
   * A delivery was given up after its last retry. At `GIVE_UP_LIMIT` in a row
   * the endpoint is switched off (D20); `true` for the one call that did it,
   * so the notice goes out once.
   */
  async recordGiveUp(tenantId: string, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const scoped = this.scoped(tenantId);
    const _id = new ObjectId(id);
    if ((await scoped.count({ _id })) === 0) return false;
    await scoped.updateMany({ _id }, { $inc: { consecutiveGiveUps: 1 } });
    const switched = await scoped.updateMany(
      { _id, enabled: true, consecutiveGiveUps: { $gte: GIVE_UP_LIMIT } },
      { enabled: false, disabledReason: "givenUp" },
    );
    return switched > 0;
  }

  /** Drops the tenant's rolled secrets whose 24 hours are over; how many endpoints changed. */
  async pruneExpiredSecrets(tenantId: string, now = this.now()) {
    return this.scoped(tenantId).updateMany(
      { "secrets.expiresAt": { $lte: now } },
      { $pull: { secrets: { expiresAt: { $lte: now } } } },
    );
  }

  /** Stores one attempt, then drops the endpoint's attempts past the newest 100. */
  async recordAttempt(tenantId: string, attempt: AttemptRecord): Promise<void> {
    const scoped = this.scopedAttempts(tenantId);
    await scoped.create(attemptDoc(attempt, this.now()));
    const filter = { endpointId: attempt.endpointId };
    if ((await scoped.count(filter)) <= DELIVERIES_PER_ENDPOINT) return;
    const newest = await scoped.findMany({
      filter,
      sort: { _id: -1 },
      limit: DELIVERIES_PER_ENDPOINT,
    });
    const oldestKept = newest.at(-1);
    if (oldestKept === undefined) return;
    await scoped.deleteMany({ ...filter, _id: { $lt: oldestKept._id } });
  }

  /** The endpoint's attempts, newest first. */
  async listAttempts(
    tenantId: string,
    endpointId: string,
    limit = MAX_LISTED,
  ): Promise<WebhookDeliveryDoc[]> {
    return this.scopedAttempts(tenantId).findMany({
      filter: { endpointId },
      sort: { _id: -1 },
      limit: clampLimit(limit),
    });
  }

  /** An endpoint was deleted: its attempts go with it. */
  async deleteAttempts(tenantId: string, endpointId: string): Promise<void> {
    await this.scopedAttempts(tenantId).deleteMany({ endpointId });
  }
}
