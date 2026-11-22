import { ObjectId } from "mongodb";
import { attributesService, roleAttributesService } from "@/config/attributes";
import { rolesService } from "@/config/roles";
import type { ConsoleContext } from "@/console/context";
import { liveTenant, tenantIdOf } from "@/console/modules/ids";
import type {
  AttributeValueSetInput,
  CreateUserAttributeInput,
  UpdateUserAttributeInput,
} from "@/generated/console/resolvers";
import { roleShape } from "@/modules/roles";
import type {
  AttributeDoc,
  CreateAttributeInput,
  UpdateAttributeInput,
} from "./attributes.types";
import {
  distinctAttributes,
  type RoleLinkView,
  sectionValueView,
  shape,
} from "./utils";
import type { SaveSection, ValueChange, ValueDoc } from "./values.types";

/** The tenant of the call (suspended included; the guard refuses its writes): the id as an ObjectId. */
export async function tenantOf(ctx: ConsoleContext, given: string) {
  const hex = tenantIdOf(given);
  await liveTenant(ctx.directory, hex);
  return { hex, id: new ObjectId(hex) };
}

/**
 * The roles each role attribute is linked to, by attribute id (hex), as the
 * console shows them: one query for the links and their roles, one grouped
 * count for the roles' members.
 */
export async function linkViews(
  tenantId: ObjectId,
  found: readonly AttributeDoc[],
): Promise<Map<string, RoleLinkView[]>> {
  const linked = await roleAttributesService.linksOf(tenantId, found);
  const roles = new Map(
    [...linked.values()]
      .flat()
      .map((link) => [link.role._id.toHexString(), link.role]),
  );
  const counts = await rolesService.memberCounts(tenantId, [...roles.values()]);
  return new Map(
    [...linked].map(([attributeId, links]) => [
      attributeId,
      links.map(({ role, required }) => ({
        role: roleShape(role, counts.get(role._id.toHexString()) ?? 0),
        required,
      })),
    ]),
  );
}

/** Several attributes at once: their value counts and role links come from one query each. */
export async function shapes(tenantId: ObjectId, found: AttributeDoc[]) {
  const counts = await attributesService.valueCounts(tenantId, found);
  const links = await linkViews(tenantId, found);
  return found.map((attribute) =>
    shape(
      attribute,
      counts.get(attribute._id.toHexString()) ?? 0,
      links.get(attribute._id.toHexString()) ?? [],
    ),
  );
}

export async function shapeOne(tenantId: ObjectId, attribute: AttributeDoc) {
  const links = await linkViews(tenantId, [attribute]);
  return shape(
    attribute,
    await attributesService.valueCount(tenantId, attribute),
    links.get(attribute._id.toHexString()) ?? [],
  );
}

const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

/** A creation as the service takes it: a field left out is `undefined`, never `null` (except `unit` and `emissionScope`, which clear). */
export const createInput = (
  input: CreateUserAttributeInput,
): CreateAttributeInput => ({
  key: input.key,
  family: input.family,
  type: input.type,
  label: input.label,
  description: orUndefined(input.description),
  unit: input.unit,
  options: orUndefined(input.options),
  required: orUndefined(input.required),
  userEditable: orUndefined(input.userEditable),
  unique: orUndefined(input.unique),
  emissionScope: input.emissionScope,
});

/** An update as the service takes it: only `unit` and `emissionScope` keep `null` (they clear). */
export const updateInput = (
  input: UpdateUserAttributeInput,
): UpdateAttributeInput => ({
  type: orUndefined(input.type),
  label: orUndefined(input.label),
  description: orUndefined(input.description),
  unit: input.unit,
  options: orUndefined(input.options),
  required: orUndefined(input.required),
  userEditable: orUndefined(input.userEditable),
  unique: orUndefined(input.unique),
  emissionScope: input.emissionScope,
});

/** The changes of a `setUserAttributeValues` call, as the values service takes them. */
export const changesOf = (
  values: readonly {
    attributeId: string;
    value?: AttributeValueSetInput | null | undefined;
  }[],
): ValueChange[] =>
  values.map(({ attributeId, value }) => ({
    attributeId,
    value: value ?? null,
  }));

/**
 * The section a save is about: the general one, or a role's, checked held
 * (`ATTRIBUTE_ROLE_NOT_HELD`) with the role's links. Called under the user's lock.
 */
export async function sectionOf(
  tenantId: ObjectId,
  userId: string,
  roleId: string | null | undefined,
): Promise<SaveSection> {
  if (roleId === null || roleId === undefined) return { family: "USER" };
  return {
    family: "ROLE",
    links: await roleAttributesService.linksHeld(tenantId, userId, roleId),
  };
}

/** The role sections of a page of users, by user id (see `sectionsLoader`). */
export async function roleSectionsOf(
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
