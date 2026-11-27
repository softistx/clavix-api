import { scopeToTenant } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { ClaimsOptions, ClaimValue } from "../claims.types";
import { claimsOf, claimTable, roleApplies } from "../utils";

/**
 * The attribute claims of a token (user-attributes slice A6), read on every
 * issue and refresh, so a role taken away or an attribute archived leaves the
 * next token. A claim needs all three: the attribute is live and its emission
 * scope is among the token's; the user has a value of its current type; and,
 * for a role attribute, a held role that links it applies to the audience.
 * Every method takes the tenant's id and reads through its scope.
 */
export class AttributeClaimsService {
  constructor(private readonly options: ClaimsOptions) {}

  /**
   * The claims of the user for a token of these scopes. `audience` is the
   * token's resource, `null` for a token with none (the ID token, userinfo):
   * only tenant-wide roles count then.
   */
  async claimsFor(
    tenantId: ObjectId,
    userId: string,
    scopes: readonly string[],
    audience: string | null,
  ): Promise<Record<string, ClaimValue>> {
    if (scopes.length === 0) return {};
    const emitted = await scopeToTenant(
      this.options.attributes,
      tenantId,
    ).findMany({
      filter: { archivedAt: null, "emission.scope": { $in: [...scopes] } },
    });
    if (emitted.length === 0) return {};
    const values = await scopeToTenant(this.options.values, tenantId).findMany({
      filter: {
        userId,
        attributeId: { $in: emitted.map((attribute) => attribute._id) },
      },
    });
    if (values.length === 0) return {};
    const applying = await this.applying(tenantId, userId, audience);
    return claimsOf(emitted, values, applying);
  }

  /**
   * The scope table of the tenant's live attributes: each emission scope to
   * the claim keys it releases. Read on every discovery, userinfo and ID
   * token, so a new or archived attribute shows at once (discovery itself is
   * cached for a minute by the public documents).
   */
  async scopeClaims(
    tenantId: ObjectId,
  ): Promise<Record<string, readonly string[]>> {
    const emitting = await scopeToTenant(
      this.options.attributes,
      tenantId,
    ).findMany({
      filter: { archivedAt: null, emission: { $ne: null } },
    });
    return claimTable(emitting);
  }

  /** The ids (hex) of the attributes a role the user holds links and that applies to the audience. */
  private async applying(
    tenantId: ObjectId,
    userId: string,
    audience: string | null,
  ): Promise<Set<string>> {
    const held = await this.options.roleLinks.heldBy(tenantId, userId);
    if (held.size === 0) return new Set();
    const resource =
      audience === null
        ? undefined
        : await scopeToTenant(this.options.resources, tenantId).findFirst({
            uri: audience,
          });
    const resourceId = resource?._id ?? null;
    return new Set(
      [...held]
        .filter(([, roles]) => roleApplies(roles, resourceId))
        .map(([id]) => id),
    );
  }
}
