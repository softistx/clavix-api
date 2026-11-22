import { oncePerRequest } from "@softistx/alxia-graphql";
import DataLoader from "dataloader";
import { ObjectId } from "mongodb";
import { attributesService, attributeValuesService } from "@/config/attributes";
import type { ConsoleContext } from "@/console/context";
import { attributeValueView } from "./values.utils";

/**
 * `TenantUser.attributes` of one tenant, batched per request: the general
 * section's attributes, their value counts and the values of a page of users
 * are read once, not once per row. The sections of a user hold the live USER
 * attributes by position (hidden ones, archived or of another family, are
 * left out), each with the user's value or none.
 */
export const sectionsLoader = (ctx: ConsoleContext, tenantId: string) =>
  oncePerRequest(
    ctx,
    `attributes.sections:${tenantId}`,
    () =>
      new DataLoader(async (userIds: readonly string[]) => {
        const tenant = new ObjectId(tenantId);
        const general = await attributeValuesService.general(tenant);
        const counts = await attributesService.valueCounts(tenant, general);
        const held = await attributeValuesService.ofUsers(tenant, userIds);
        return userIds.map((userId) => ({
          general: general.map((attribute) =>
            attributeValueView(
              attribute,
              counts.get(attribute._id.toHexString()) ?? 0,
              held
                .get(userId)
                ?.find((v) => v.attributeId.equals(attribute._id)),
            ),
          ),
          roles: [],
        }));
      }),
  );

/** `TenantUser.attributesComplete` of one tenant, batched per request. */
export const completeLoader = (ctx: ConsoleContext, tenantId: string) =>
  oncePerRequest(
    ctx,
    `attributes.complete:${tenantId}`,
    () =>
      new DataLoader(async (userIds: readonly string[]) => {
        const missing = await attributeValuesService.incomplete(
          new ObjectId(tenantId),
          userIds,
        );
        return userIds.map((userId) => !missing.has(userId));
      }),
  );
