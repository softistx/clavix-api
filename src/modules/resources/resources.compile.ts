import { z } from "zod";
import {
  DETAIL_LIMITS,
  type DetailFieldDefinition,
  type DetailTypeDefinition,
  detailTypeProblem,
} from "./resources.compile-rules";

function fieldSchema(field: DetailFieldDefinition): z.ZodType {
  switch (field.kind) {
    case "string":
      return z.string().max(field.maxLength ?? DETAIL_LIMITS.defaultMaxLength);
    case "number":
    case "integer": {
      let schema = field.kind === "integer" ? z.number().int() : z.number();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return schema;
    }
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(
        (field.values ?? []).map((v) => v.value) as [string, ...string[]],
      );
    case "string[]":
      return z
        .array(
          z.string().max(field.maxLength ?? DETAIL_LIMITS.defaultMaxLength),
        )
        .max(field.max ?? DETAIL_LIMITS.defaultItems);
  }
}

// A compiled schema's digest, read by the issuer's fingerprint: a type edited
// in the console rebuilds the issuer, though the tenant did not change.
const digests = new WeakMap<object, string>();
const compiled = new Map<string, z.ZodType>();
const MAX_COMPILED = 1000;

const digestOfDefinition = ({ type, fields, actions }: DetailTypeDefinition) =>
  // SHA-256, not a short hash: the cache is shared by every tenant, and an
  // admin controls the definition.
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ type, fields, actions: actions ?? null }))
    .digest("hex");

/** The digest of a schema `compileDetailType` made, `undefined` for any other. */
export const digestOf = (schema: object): string | undefined =>
  digests.get(schema);

/**
 * A definition as a Standard Schema janus runs on each `authorization_details`
 * entry: a `z.strictObject` with a `type` literal, the optional RFC 9396
 * `locations`, `identifier`, `datatypes` and (when the type lists any)
 * `actions`, then its own fields. Unknown keys are refused and the schema's
 * output replaces what the client sent. A definition `detailTypeProblem`
 * refuses is a programming error (it throws); a request never makes it throw.
 * The same definition gives the same schema object.
 */
export function compileDetailType(definition: DetailTypeDefinition): z.ZodType {
  const problem = detailTypeProblem(definition);
  if (problem !== null) throw new TypeError(`detail type: ${problem}`);
  const digest = digestOfDefinition(definition);
  const known = compiled.get(digest);
  if (known !== undefined) return known;
  const shape: Record<string, z.ZodType> = {
    type: z.literal(definition.type),
    locations: z.array(z.string().max(2048)).max(1).optional(),
    identifier: z.string().max(DETAIL_LIMITS.identifier).optional(),
    datatypes: z
      .array(z.string().max(DETAIL_LIMITS.value))
      .max(DETAIL_LIMITS.datatypes)
      .optional(),
  };
  if (definition.actions !== undefined && definition.actions.length > 0) {
    shape["actions"] = z
      .array(
        z.enum(definition.actions.map((a) => a.value) as [string, ...string[]]),
      )
      .min(1)
      .max(definition.actions.length)
      .optional();
  }
  for (const field of definition.fields) {
    const schema = fieldSchema(field);
    shape[field.key] = field.required === true ? schema : schema.optional();
  }
  const schema = z.strictObject(shape);
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(digest, schema);
  digests.set(schema, digest);
  return schema;
}
