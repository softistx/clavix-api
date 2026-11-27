import { scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { refuseCommon } from "../attributes.refusals";
import type {
  Condition,
  UserFilter,
  UserFilterOptions,
  UserIdPage,
} from "../user-filter.types";
import {
  askedIds,
  attributeConditions,
  cursorOf,
  matchPipeline,
  roleCondition,
} from "../utils";

/**
 * Which users match the role and attribute filters of the console's user list
 * (user-attributes slice A8). Every method takes the tenant's id and reads
 * through its scope; the users themselves stay in janus, so this answers user
 * ids (in creation order, a cursor of its own) and the total of all matches.
 */
export class UserFilterService {
  constructor(private readonly options: UserFilterOptions) {}

  /** Checks the filters and turns them into conditions; a refused filter is `BAD_USER_INPUT`. */
  private async conditions(
    tenantId: ObjectId,
    filter: UserFilter,
  ): Promise<Condition[]> {
    const asked = filter.attributes ?? [];
    const parsed = askedIds(asked);
    if ("issue" in parsed) {
      return refuseCommon("BAD_USER_INPUT", parsed.issue, parsed.field);
    }
    const known = new Map(
      (
        await scopeToTenant(this.options.attributes, tenantId).findMany({
          filter: { _id: { $in: parsed.ids.filter((id) => id !== null) } },
        })
      ).map((attribute) => [attribute._id.toHexString(), attribute]),
    );
    const links = await scopeToTenant(this.options.links, tenantId).findMany({
      filter: { attributeId: { $in: [...known.values()].map((a) => a._id) } },
    });
    const built = attributeConditions(
      tenantId,
      asked,
      parsed.ids,
      known,
      links,
    );
    if ("issue" in built) {
      return refuseCommon("BAD_USER_INPUT", built.issue, built.field);
    }
    const { conditions } = built;
    if (filter.roleId !== null && filter.roleId !== undefined) {
      if (!ObjectId.isValid(filter.roleId)) {
        return refuseCommon("BAD_USER_INPUT", "roleId is not an id", "roleId");
      }
      conditions.unshift(roleCondition(tenantId, new ObjectId(filter.roleId)));
    }
    return conditions;
  }

  /**
   * The user ids matching every filter, after `after`, at most `limit`, and the
   * count of all the matches. `ids` narrows to some users first (an e-mail
   * prefix's). No filter at all is not asked here.
   */
  async page(
    tenantId: ObjectId,
    filter: UserFilter,
    paging: {
      ids: readonly string[] | null;
      after: string | null;
      limit: number;
    },
  ): Promise<UserIdPage> {
    const conditions = await this.conditions(tenantId, filter);
    if (conditions.length === 0) {
      return refuseCommon(
        "BAD_USER_INPUT",
        "Give a role or an attribute filter",
      );
    }
    const [facet] = await this.options.values.raw
      .aggregate<{ total: { n: number }[]; page: { _id: string }[] }>(
        matchPipeline(conditions, paging),
        { allowDiskUse: true },
      )
      .toArray();
    const found = (facet?.page ?? []).map((row) => row._id);
    const userIds = found.slice(0, paging.limit);
    const last = userIds.at(-1);
    return {
      userIds,
      nextCursor:
        found.length > paging.limit && last !== undefined
          ? cursorOf(last)
          : null,
      totalCount: facet?.total[0]?.n ?? 0,
    };
  }
}
