import { type Document, ObjectId } from "mongodb";
import type { AttributeDoc } from "../attributes.types";
import type { AttributeFilter, Condition } from "../user-filter.types";

/** The most attribute filters one list accepts. */
export const MAX_FILTERS = 5;
/** The most e-mail prefix matches that may be combined with a filter. */
export const MAX_PREFIX_IDS = 1000;
const PREFIX = "f1.";

/** The cursor of a filtered page: the last user id. */
export const cursorOf = (userId: string): string => `${PREFIX}${userId}`;

/** The user id a filtered cursor holds, `null` for a cursor this list did not mint. */
export function afterOf(cursor: string): string | null {
  if (!cursor.startsWith(PREFIX) || cursor.length === PREFIX.length) {
    return null;
  }
  return cursor.slice(PREFIX.length);
}

/** Whether the attribute can be filtered: a choice with options, or a boolean. */
export const isFilterable = (attribute: AttributeDoc): boolean =>
  attribute.type === "SELECT" ||
  attribute.type === "MULTI_SELECT" ||
  attribute.type === "BOOLEAN";

/** Why a filter cannot be applied to its attribute, `null` when it can. */
export function filterIssue(
  attribute: AttributeDoc | undefined,
  filter: AttributeFilter,
): string | null {
  if (attribute === undefined) return "No such attribute";
  if (attribute.archivedAt !== null) return "The attribute is archived";
  if (!isFilterable(attribute)) {
    return "Only a choice or a boolean attribute can filter";
  }
  const options = filter.options ?? null;
  const flag = filter.boolean ?? null;
  if (attribute.type === "BOOLEAN") {
    return flag !== null && options === null
      ? null
      : "A boolean attribute filters with boolean";
  }
  if (flag !== null || options === null || options.length === 0) {
    return "A choice attribute filters with options";
  }
  const known = new Set(attribute.options.map((option) => option.key));
  return options.every((key) => known.has(key))
    ? null
    : "An option is not one of the attribute's";
}

/** What `askedIds` and `attributeConditions` answer when a filter is refused: the message and the field it is on. */
export interface FilterRefusal {
  issue: string;
  field: string;
}

/** The ids the filters name (`null` for a string that is no id), or the refusal of too many filters. */
export function askedIds(
  asked: readonly AttributeFilter[],
): { ids: (ObjectId | null)[] } | FilterRefusal {
  if (asked.length > MAX_FILTERS) {
    return {
      issue: `At most ${MAX_FILTERS} attribute filters`,
      field: "attributes",
    };
  }
  return {
    ids: asked.map((item) =>
      ObjectId.isValid(item.attributeId)
        ? new ObjectId(item.attributeId)
        : null,
    ),
  };
}

/** The conditions of every attribute filter, or the refusal of the first one that cannot apply. */
export function attributeConditions(
  tenantId: ObjectId,
  asked: readonly AttributeFilter[],
  ids: readonly (ObjectId | null)[],
  known: ReadonlyMap<string, AttributeDoc>,
  links: readonly { attributeId: ObjectId; roleId: ObjectId }[],
): { conditions: Condition[] } | FilterRefusal {
  const conditions: Condition[] = [];
  for (const [index, item] of asked.entries()) {
    const attribute = known.get(ids[index]?.toHexString() ?? "");
    const issue = filterIssue(attribute, item);
    if (issue !== null || attribute === undefined) {
      return {
        issue: issue ?? "No such attribute",
        field: `attributes.${index}`,
      };
    }
    const linked = links
      .filter((link) => link.attributeId.equals(attribute._id))
      .map((link) => link.roleId);
    conditions.push(...filterConditions(tenantId, attribute, item, linked));
  }
  return { conditions };
}

/** The conditions of one filter: the value, and for a role attribute a held linked role. */
export function filterConditions(
  tenantId: ObjectId,
  attribute: AttributeDoc,
  filter: AttributeFilter,
  linkedRoles: readonly ObjectId[],
): Condition[] {
  const wanted =
    attribute.type === "BOOLEAN"
      ? filter.boolean === true
      : (filter.options ?? []);
  const value = valueCondition(tenantId, attribute, wanted);
  return attribute.family === "ROLE"
    ? [value, linkedCondition(tenantId, linkedRoles)]
    : [value];
}

/** The condition "the user holds this role". */
export const roleCondition = (
  tenantId: ObjectId,
  roleId: ObjectId,
): Condition => ({
  from: "roleAssignments",
  match: { tenantId, roleId },
});

/** The condition "the user's stored value matches", under the type it was written with (risk 3). */
export const valueCondition = (
  tenantId: ObjectId,
  attribute: AttributeDoc,
  wanted: readonly string[] | boolean,
): Condition => ({
  from: "attributeValues",
  match: {
    tenantId,
    attributeId: attribute._id,
    type: attribute.type,
    value: typeof wanted === "boolean" ? wanted : { $in: [...wanted] },
  },
});

/** The condition "the user holds a role that links the attribute" (a role value shows only then). */
export const linkedCondition = (
  tenantId: ObjectId,
  roleIds: readonly ObjectId[],
): Condition => ({
  from: "roleAssignments",
  match: { tenantId, roleId: { $in: [...roleIds] } },
});

/**
 * The pipeline that keeps the users satisfying every condition. It runs on any
 * collection and starts empty: each condition's users are unioned in, tagged by
 * the condition's index, grouped by user and kept when every tag is there.
 * `ids` narrows to some users (an e-mail prefix); the facet answers the page
 * after `after` (one more than `limit`) and the total of all the matches.
 */
export function matchPipeline(
  conditions: readonly Condition[],
  options: {
    ids: readonly string[] | null;
    after: string | null;
    limit: number;
  },
): Document[] {
  const narrowed: Document[] =
    options.ids === null
      ? []
      : [{ $match: { _id: { $in: [...options.ids] } } }];
  const after: Document[] =
    options.after === null ? [] : [{ $match: { _id: { $gt: options.after } } }];
  return [
    { $match: { _id: null } },
    ...conditions.map((condition, tag) => ({
      $unionWith: {
        coll: condition.from,
        pipeline: [
          { $match: condition.match },
          { $project: { _id: 0, userId: 1, tag: { $literal: tag } } },
        ],
      },
    })),
    { $group: { _id: "$userId", tags: { $addToSet: "$tag" } } },
    { $match: { tags: { $size: conditions.length } } },
    ...narrowed,
    {
      $facet: {
        total: [{ $count: "n" }],
        page: [...after, { $sort: { _id: 1 } }, { $limit: options.limit + 1 }],
      },
    },
  ];
}
