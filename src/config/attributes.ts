import {
  AttributesService,
  AttributeValuesService,
} from "@/modules/attributes";
import { mongo } from "./db";
import { clock } from "./runtime";

/**
 * The values users hold for the attributes. The collections are tenant-owned:
 * only this wiring and the module reach them. Built first, since the catalogue
 * asks the values what they hold (counts, locks) and clears them on a delete.
 */
export const attributeValuesService = new AttributeValuesService({
  values: mongo.db.attributeValues,
  attributes: mongo.db.userAttributes,
});

/** The real attribute catalogue. */
export const attributesService = new AttributesService({
  attributes: mongo.db.userAttributes,
  scopes: mongo.db.scopes,
  values: attributeValuesService,
  clock,
});
