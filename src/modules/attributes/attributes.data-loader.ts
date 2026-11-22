import { oncePerRequest } from "@softistx/alxia-graphql";
import DataLoader from "dataloader";
import { ObjectId } from "mongodb";
import {
  attributesService,
  attributeValuesService,
  roleAttributesService,
} from "@/config/attributes";
import { rolesService } from "@/config/roles";
import type { ConsoleContext } from "@/console/context";
import { roleShape } from "@/modules/roles";
import { linkViews } from "./attributes.console-support";
import { distinctAttributes, sectionValueView } from "./utils";
import type { ValueDoc } from "./values.types";

/** The role sections of a page of users, by user id (see `sectionsLoader`). */
async function roleSectionsOf(
  tenant: ObjectId,
  userIds: readonly string[],
  held: ReadonlyMap<string, ValueDoc[]>,
) {
  const sections = await roleAttributesService.sectionsOf(tenant, userIds);
  const all = [...sections.values()].flat();
  const attributes = distinctAttributes(
    all.flatMap((section) => section.items.map((item) => item.attribute)),
  );
  const counts = await attributesService.valueCounts(tenant, attributes);
  const links = await linkViews(tenant, attributes);
  const members = await rolesService.memberCounts(
    tenant,
    all.map((section) => section.role),
  );
  return new Map(
    [...sections].map(([userId, own]) => [
      userId,
      own.map(({ role, items }) => ({
        role: roleShape(role, members.get(role._id.toHexString()) ?? 0),
        values: items.map(({ attribute, required }) =>
          sectionValueView(
            attribute,
            required,
            counts.get(attribute._id.toHexString()) ?? 0,
            held.get(userId),
            links.get(attribute._id.toHexString()) ?? [],
          ),
        ),
      })),
    ]),
  );
}

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
