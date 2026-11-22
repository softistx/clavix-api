import { AttributesService } from "@/modules/attributes";
import { mongo } from "./db";
import { noAttributeValues } from "./no-ops";

/**
 * The real attribute catalogue. The collection is tenant-owned: only this
 * wiring and its module reach it. The stored values are slice A2's; until they
 * ship `noAttributeValues` answers that none exist.
 */
export const attributesService = new AttributesService({
  attributes: mongo.db.userAttributes,
  scopes: mongo.db.scopes,
  values: noAttributeValues,
});
