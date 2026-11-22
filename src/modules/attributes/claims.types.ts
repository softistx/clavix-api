import type { TypedCollection } from "@softistx/mongo";
import type { resources } from "@/modules/resources";
import type { attributeValues, userAttributes } from "./attributes.model";
import type { HeldRoleLinks } from "./attributes.types";

export interface ClaimsOptions {
  /** Read only: the values of a user. */
  values: TypedCollection<typeof attributeValues>;
  /** Read only: the catalogue the emission reads. */
  attributes: TypedCollection<typeof userAttributes>;
  /** Read only: the resource whose `uri` is a token's audience. */
  resources: TypedCollection<typeof resources>;
  /** The roles a user holds that link each role attribute. */
  roleLinks: HeldRoleLinks;
}

/** What a claim holds: native for a number and a boolean, a string otherwise, an array for a multiple choice. */
export type ClaimValue = string | number | boolean | string[];
