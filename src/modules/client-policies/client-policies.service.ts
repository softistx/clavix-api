import {
  ConflictError,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type {
  clientPolicies,
  TokenExchangeRules,
} from "./client-policies.model";

/**
 * A tenant's per-client rules. Every method takes the tenant's id and reads or
 * writes through that tenant's scope, so a rule of A is never read for B.
 */
export class ClientPoliciesService {
  constructor(
    private readonly collection: TypedCollection<typeof clientPolicies>,
  ) {}

  private scoped(tenantId: ObjectId) {
    return scopeToTenant(this.collection, tenantId);
  }

  /** The client's token exchange rules; `null` when it has none (the exchange is then refused). */
  async tokenExchange(
    tenantId: ObjectId,
    clientId: string,
  ): Promise<TokenExchangeRules | null> {
    const found = await this.scoped(tenantId).findFirst({ clientId });
    return found?.tokenExchange ?? null;
  }

  /** The token exchange rules of these clients, by client id (a client with none is absent). One read. */
  async tokenExchangeOf(
    tenantId: ObjectId,
    clientIds: readonly string[],
  ): Promise<Map<string, TokenExchangeRules>> {
    if (clientIds.length === 0) return new Map();
    const found = await this.scoped(tenantId).findMany({
      filter: { clientId: { $in: [...clientIds] } },
    });
    return new Map(
      found.flatMap((doc) =>
        doc.tokenExchange === null ? [] : [[doc.clientId, doc.tokenExchange]],
      ),
    );
  }

  /** Replaces the client's token exchange rules (created on the first write). */
  async setTokenExchange(
    tenantId: ObjectId,
    clientId: string,
    rules: TokenExchangeRules,
  ): Promise<TokenExchangeRules> {
    const scoped = this.scoped(tenantId);
    for (let attempt = 0; ; attempt++) {
      const existing = await scoped.findFirst({ clientId });
      try {
        if (existing === undefined) {
          await scoped.create({ clientId, tokenExchange: rules });
        } else {
          await scoped.update(existing._id, { tokenExchange: rules });
        }
        return rules;
      } catch (error) {
        // Two first writes raced on the unique index: the next pass updates.
        if (!(error instanceof ConflictError) || attempt >= 2) throw error;
      }
    }
  }

  /** Removes every rule of the client (it is deleted); `true` when there were some. */
  async deleteForClient(tenantId: ObjectId, clientId: string) {
    return (await this.scoped(tenantId).hardDeleteMany({ clientId })) > 0;
  }

  /**
   * Drops a deleted resource's URI from every rule of the tenant that targets
   * it, so a resource re-created under the same URI does not revive the rule.
   * Returns how many rules changed.
   */
  async removeTarget(tenantId: ObjectId, uri: string): Promise<number> {
    return this.scoped(tenantId).updateMany(
      { "tokenExchange.targetResources": uri },
      { $pull: { "tokenExchange.targetResources": uri } },
    );
  }

  /**
   * Drops a deleted client's id from every rule of the tenant that lists it as
   * a subject. A rule of `"any"` is a string and is left alone. Returns how
   * many rules changed.
   */
  async removeSubjectClient(
    tenantId: ObjectId,
    clientId: string,
  ): Promise<number> {
    return this.scoped(tenantId).updateMany(
      {
        "tokenExchange.subjectClients": { $type: "array", $eq: clientId },
      },
      { $pull: { "tokenExchange.subjectClients": clientId } },
    );
  }
}
