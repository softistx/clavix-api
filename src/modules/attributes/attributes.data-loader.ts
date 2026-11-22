import { oncePerRequest } from "@softistx/alxia-graphql";
import DataLoader from "dataloader";
import { ObjectId } from "mongodb";
import { attributesService, attributeValuesService } from "@/config/attributes";
import type { ConsoleContext } from "@/console/context";
import { roleSectionsOf } from "./attributes.console-support";
import { sectionValueView } from "./utils";

/**
 * `TenantUser.attributes` of one tenant, batched per request: the attributes,
 * their value counts, role links and the values of a page of users are read
 * once, not once per row. The general section holds the live USER attributes
 * by position, each with the user's value or none. A role section is one held
 * role that links live role attributes (by position, the link's `required`
 * shown); an archived attribute, a role no longer held or one whose link was
 * removed is left out, and the value stays stored (hidden).
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
        const roles = await roleSectionsOf(tenant, userIds, held);
        return userIds.map((userId) => ({
          general: general.map((attribute) =>
            sectionValueView(
              attribute,
              attribute.required,
              counts.get(attribute._id.toHexString()) ?? 0,
              held.get(userId),
              [],
            ),
          ),
          roles: roles.get(userId) ?? [],
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
