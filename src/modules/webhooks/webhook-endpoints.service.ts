import { mintWebhookSecret } from "@softistx/janus-webhooks";
import {
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods/secrets";
import { assertWithinQuota } from "@/modules/usage/quota";
import { isWebhookEventType } from "./events";
import { checkWebhookUrl, type UrlPolicy, WebhookUrlError } from "./url-policy";
import type {
  DisabledReason,
  webhookEndpoints,
} from "./webhook-endpoints.model";
import { WebhookError } from "./webhooks.errors";

export type WebhookEndpointDoc = ReadDocumentOf<typeof webhookEndpoints>;

/** What a rolled secret keeps signing for (D19). */
export const ROLL_OVERLAP_MS = 24 * 60 * 60 * 1000;
/** Given-up deliveries in a row after which an endpoint is switched off (D20). */
export const GIVE_UP_LIMIT = 5;
/** The secrets an endpoint keeps at most: the current one and the last rolled ones. */
const MAX_SECRETS = 3;

/** What `webhooks()` gets for one endpoint (its `WebhookEndpoint`, with the secrets opened). */
export interface DeliveryEndpoint {
  id: string;
  url: string;
  secrets: [string, ...string[]];
  types?: string[];
  disabled: boolean;
}

export interface EndpointInput {
  url: string;
  description?: string | undefined;
  types?: readonly string[] | undefined;
}

export interface EndpointServiceOptions {
  policy: UrlPolicy;
  now?: () => Date;
  /** Mints a `whsec_` secret; a spec fixes it. */
  mint?: () => string;
  log?: (message: string) => void;
}

const contextOf = (tenantId: string, endpointId: string) =>
  `${tenantId}:${endpointId}`;

function typesOf(types: readonly string[] | undefined): string[] {
  const unique = [...new Set(types ?? [])];
  const unknown = unique.find((type) => !isWebhookEventType(type));
  if (unknown !== undefined) {
    throw new WebhookError(
      "BAD_USER_INPUT",
      `Unknown event type "${unknown}"`,
      "types",
    );
  }
  return unique;
}

function descriptionOf(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const trimmed = description.trim();
  if (trimmed.length > 200) {
    throw new WebhookError(
      "BAD_USER_INPUT",
      "The description is longer than 200 characters",
      "description",
    );
  }
  return trimmed;
}

/**
 * A tenant's webhook endpoints (D19-D21). Every method takes the tenant's id
 * and reads or writes through its scope, so an endpoint of A is unknown to B.
 * The secret is returned once, by `create` and `roll`, and never again; at
 * rest it is sealed with the keyring, bound to its tenant and endpoint.
 */
export class WebhookEndpointsService {
  private readonly now: () => Date;
  private readonly mint: () => string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly collection: TypedCollection<typeof webhookEndpoints>,
    private readonly box: SecretBox,
    private readonly options: EndpointServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.mint = options.mint ?? mintWebhookSecret;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  private scoped(tenantId: string) {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  count(tenantId: string): Promise<number> {
    return this.scoped(tenantId).count();
  }

  async list(tenantId: string): Promise<WebhookEndpointDoc[]> {
    return this.scoped(tenantId).findMany({ sort: { createdAt: 1 } });
  }

  find(tenantId: string, id: string): Promise<WebhookEndpointDoc | undefined> {
    if (!ObjectId.isValid(id)) return Promise.resolve(undefined);
    return this.scoped(tenantId).findById(id);
  }

  private async get(tenantId: string, id: string) {
    const found = await this.find(tenantId, id);
    if (found === undefined) {
      throw new WebhookError("NOT_FOUND", "No such webhook endpoint");
    }
    return found;
  }

  /** Whether `url` is still allowed (shape and address); a `BAD_USER_INPUT` when it is not. */
  checkAddress(url: string): Promise<void> {
    return this.checkUrl(url);
  }

  private async checkUrl(url: string) {
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
  async create(
    tenantId: string,
    input: EndpointInput,
    quota: number | null,
  ): Promise<{ endpoint: WebhookEndpointDoc; secret: string }> {
    await this.checkUrl(input.url);
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

  async update(
    tenantId: string,
    id: string,
    patch: {
      url?: string | undefined;
      description?: string | undefined;
      types?: readonly string[] | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<WebhookEndpointDoc> {
    const current = await this.get(tenantId, id);
    const set: {
      url?: string;
      description?: string;
      types?: string[];
      enabled?: boolean;
      disabledReason?: DisabledReason | null;
      consecutiveGiveUps?: number;
    } = {};
    if (patch.url !== undefined && patch.url !== current.url) {
      await this.checkUrl(patch.url);
      set.url = new URL(patch.url).href;
    }
    const description = descriptionOf(patch.description);
    if (description !== undefined) set.description = description;
    if (patch.types !== undefined) set.types = typesOf(patch.types);
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
      set.enabled = patch.enabled;
      // Switching on by hand clears what the auto-disable left (D20).
      set.disabledReason = patch.enabled ? null : "manual";
      if (patch.enabled) set.consecutiveGiveUps = 0;
    }
    // Switching on re-checks the address too: the host may have moved since.
    if (set.enabled === true && set.url === undefined) {
      await this.checkUrl(current.url);
    }
    if (Object.keys(set).length === 0) return current;
    return this.scoped(tenantId).update(current._id, set);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const current = await this.get(tenantId, id);
    await this.scoped(tenantId).delete(current._id);
  }

  /**
   * A new secret, returned once. `keepPrevious` leaves the current one signing
   * for 24 hours (both signatures are sent, D19); without it every older
   * secret is dropped at once ("expire now").
   */
  async roll(
    tenantId: string,
    id: string,
    keepPrevious: boolean,
  ): Promise<{ endpoint: WebhookEndpointDoc; secret: string }> {
    const current = await this.get(tenantId, id);
    const now = this.now();
    const until = new Date(now.getTime() + ROLL_OVERLAP_MS);
    const secret = this.mint();
    const kept = keepPrevious
      ? current.secrets
          .filter((entry) => entry.expiresAt === null || entry.expiresAt > now)
          .map((entry) =>
            entry.expiresAt === null || entry.expiresAt > until
              ? { ...entry, expiresAt: until }
              : entry,
          )
      : [];
    const secrets = [
      this.sealed(tenantId, current._id, secret, now, null),
      ...kept,
    ].slice(0, MAX_SECRETS);
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
      const id = doc._id.toHexString();
      const secrets: string[] = [];
      for (const entry of doc.secrets) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
        try {
          secrets.push(this.box.open(entry.sealed, contextOf(tenantId, id)));
        } catch {
          this.log(`webhooks: a secret of endpoint ${id} could not be opened`);
        }
      }
      const [first, ...rest] = secrets;
      // No secret to sign with (the key left the keyring): never sent unsigned,
      // and left out, so what waits for it is given up as `endpointRemoved`.
      if (first === undefined) continue;
      found.push({
        id,
        url: doc.url,
        secrets: [first, ...rest],
        ...(doc.types.length === 0 ? {} : { types: doc.types }),
        disabled: !doc.enabled,
      });
    }
    return found;
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
}
