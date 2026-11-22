import { ObjectId } from "mongodb";
import {
  AttributeClaimsService,
  AttributesService,
  AttributeValuesService,
  RoleAttributesService,
} from "@/modules/attributes";
import type { AttributesFor } from "@/oauth/ports";
import { mongo } from "./db";
import { clock } from "./runtime";

/**
 * The links between role attributes and roles. Built first: the values and the
 * catalogue ask it which roles link an attribute, and clear its links on a
 * delete; `config/roles.ts` hands it to the roles for their delete cascade.
 * The roles and their assignments are read only here.
 */
export const roleAttributesService = new RoleAttributesService({
  links: mongo.db.roleAttributes,
  attributes: mongo.db.userAttributes,
  roles: mongo.db.roles,
  assignments: mongo.db.roleAssignments,
});

/**
 * The values users hold for the attributes. The collections are tenant-owned:
 * only this wiring and the module reach them. Built first, since the catalogue
 * asks the values what they hold (counts, locks) and clears them on a delete.
 */
export const attributeValuesService = new AttributeValuesService({
  values: mongo.db.attributeValues,
  attributes: mongo.db.userAttributes,
  roleLinks: roleAttributesService,
});

/** The real attribute catalogue. */
export const attributesService = new AttributesService({
  attributes: mongo.db.userAttributes,
  scopes: mongo.db.scopes,
  values: attributeValuesService,
  roleLinks: roleAttributesService,
  clock,
});

/** The attribute claims of the access tokens (slice A6). */
export const attributeClaimsService = new AttributeClaimsService({
  values: mongo.db.attributeValues,
  attributes: mongo.db.userAttributes,
  resources: mongo.db.resources,
  roleLinks: roleAttributesService,
});

export const attributesFor: AttributesFor =
  (tenant) => (userId, scopes, audience) =>
    attributeClaimsService.claimsFor(
      new ObjectId(tenant.tenantId),
      userId,
      scopes,
      audience,
    );
