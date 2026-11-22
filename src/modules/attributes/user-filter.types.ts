import type { TypedCollection } from "@softistx/mongo";
import type { Document } from "mongodb";
import type {
  attributeValues,
  roleAttributes,
  userAttributes,
} from "./attributes.model";

export interface UserFilterOptions {
  /** Read only: the attributes a filter names. */
  attributes: TypedCollection<typeof userAttributes>;
  /** Read only: the values the filters match. */
  values: TypedCollection<typeof attributeValues>;
  /** Read only: the links of a role attribute, whose value shows only while a linked role is held. */
  links: TypedCollection<typeof roleAttributes>;
}

/** One attribute filter: the chosen option keys (any of them) or a boolean, never both. */
export interface AttributeFilter {
  attributeId: string;
  options?: readonly string[] | null | undefined;
  boolean?: boolean | null | undefined;
}

/** What the users list is narrowed to; every condition must hold (AND). */
export interface UserFilter {
  roleId?: string | null | undefined;
  attributes?: readonly AttributeFilter[] | null | undefined;
}

/** One condition as a `$match` over a collection, tagged by its index. */
export interface Condition {
  from: "attributeValues" | "roleAssignments";
  match: Document;
}

/** A page of matching user ids in id order (creation order), with the count of all the matches. */
export interface UserIdPage {
  userIds: string[];
  nextCursor: string | null;
  totalCount: number;
}
