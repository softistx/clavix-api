import { ObjectId } from "mongodb";
import { attributesService } from "@/config/attributes";
import type { ConsoleContext } from "@/console/context";
import { liveTenant, tenantIdOf } from "@/console/modules/ids";
import type {
  AttributeValueSetInput,
  CreateUserAttributeInput,
  UpdateUserAttributeInput,
} from "@/generated/console/resolvers";
import type {
  AttributeDoc,
  CreateAttributeInput,
  UpdateAttributeInput,
} from "./attributes.types";
import { shape } from "./attributes.utils";
import type { ValueChange } from "./values.types";

/** The tenant of the call (suspended included; the guard refuses its writes): the id as an ObjectId. */
export async function tenantOf(ctx: ConsoleContext, given: string) {
  const hex = tenantIdOf(given);
  await liveTenant(ctx.directory, hex);
  return { hex, id: new ObjectId(hex) };
}

/** Several attributes at once: their value counts come from one query. */
export async function shapes(tenantId: ObjectId, found: AttributeDoc[]) {
  const counts = await attributesService.valueCounts(tenantId, found);
  return found.map((attribute) =>
    shape(attribute, counts.get(attribute._id.toHexString()) ?? 0),
  );
}

export const shapeOne = async (tenantId: ObjectId, attribute: AttributeDoc) =>
  shape(attribute, await attributesService.valueCount(tenantId, attribute));

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
