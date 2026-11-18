import { z } from "zod";
import type { FieldKind } from "./detail-types.model";

// What the compiler reads of a stored detail type (D1): a bounded list of
// fields, never a free JSON Schema (no `pattern`, so no ReDoS, and nothing
// the consent page cannot show).
export interface DetailFieldDefinition {
  key: string;
  kind: FieldKind;
  required?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
  values?: readonly { value: string }[] | undefined;
}

export interface DetailTypeDefinition {
  type: string;
  fields: readonly DetailFieldDefinition[];
  actions?: readonly { value: string }[] | undefined;
}

/** The bounds of a definition and of the details it accepts. */
export const DETAIL_LIMITS = {
  /** Characters of a type name (janus's own limit). */
  type: 64,
  /** Fields of one type. */
  fields: 16,
  /** Characters of a field key. */
  key: 64,
  /** Values of an `enum` field, and actions of a type. */
  values: 50,
  /** Characters of an enum value or an action. */
  value: 100,
  /** The longest `maxLength` a string field may allow, and its default. */
  maxLength: 1024,
  defaultMaxLength: 256,
  /** The most items a `string[]` field may allow, and its default. */
  items: 64,
  defaultItems: 16,
  /** `identifier` (RFC 9396) and `datatypes`. */
  identifier: 256,
  datatypes: 16,
} as const;

// RFC 9396 common fields: the compiler owns them, a field cannot reuse a name.
export const RESERVED_KEYS = [
  "type",
  "locations",
  "actions",
  "identifier",
  "datatypes",
  "privileges",
] as const;

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function boundProblem(field: DetailFieldDefinition): string | null {
  const { kind, min, max, maxLength, key } = field;
  const numeric = kind === "number" || kind === "integer";
  const where = `field "${key}"`;
  if (min !== undefined && !numeric) return `${where}: min is for numbers`;
  if (min !== undefined && !isNumber(min))
    return `${where}: min is not a number`;
  if (max !== undefined && !isNumber(max))
    return `${where}: max is not a number`;
  if (max !== undefined && kind !== "string[]" && !numeric) {
    return `${where}: max is for numbers and lists`;
  }
  if (kind === "integer") {
    for (const bound of [min, max]) {
      if (bound !== undefined && !Number.isSafeInteger(bound)) {
        return `${where}: an integer's bounds are integers`;
      }
    }
  }
  if (kind === "string[]") {
    if (
      max !== undefined &&
      !(Number.isInteger(max) && max >= 1 && max <= DETAIL_LIMITS.items)
    ) {
      return `${where}: a list holds 1 to ${DETAIL_LIMITS.items} items`;
    }
  } else if (min !== undefined && max !== undefined && min > max) {
    return `${where}: min is above max`;
  }
  if (maxLength !== undefined) {
    if (kind !== "string" && kind !== "string[]") {
      return `${where}: maxLength is for text`;
    }
    if (
      !(
        Number.isInteger(maxLength) &&
        maxLength >= 1 &&
        maxLength <= DETAIL_LIMITS.maxLength
      )
    ) {
      return `${where}: maxLength is 1 to ${DETAIL_LIMITS.maxLength}`;
    }
  }
  return null;
}

function valuesProblem(
  what: string,
  values: readonly { value: string }[] | undefined,
): string | null {
  if (values === undefined) return `${what} needs at least one value`;
  if (values.length === 0 || values.length > DETAIL_LIMITS.values) {
    return `${what} has 1 to ${DETAIL_LIMITS.values} values`;
  }
  const seen = new Set<string>();
  for (const { value } of values) {
    if (value.length === 0 || value.length > DETAIL_LIMITS.value) {
      return `${what}: a value is 1 to ${DETAIL_LIMITS.value} characters`;
    }
    if (seen.has(value)) return `${what}: "${value}" is listed twice`;
    seen.add(value);
  }
  return null;
}

/** Why a definition cannot be compiled, or `null` when it can. */
export function detailTypeProblem(
  definition: DetailTypeDefinition,
): string | null {
  const { type, fields, actions } = definition;
  if (
    type.length === 0 ||
    type.length > DETAIL_LIMITS.type ||
    !TYPE_NAME.test(type)
  ) {
    return `a type name is 1 to ${DETAIL_LIMITS.type} letters, digits, "_", ".", ":" or "-", starting with a letter`;
  }
  if (fields.length > DETAIL_LIMITS.fields) {
    return `a type has at most ${DETAIL_LIMITS.fields} fields`;
  }
  const keys = new Set<string>();
  for (const field of fields) {
    const { key } = field;
    if (key.length > DETAIL_LIMITS.key || !FIELD_KEY.test(key)) {
      return `a field key is a letter then letters, digits or "_", at most ${DETAIL_LIMITS.key} characters`;
    }
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      return `field "${key}": the name is reserved (RFC 9396)`;
    }
    if (keys.has(key)) return `field "${key}" is listed twice`;
    keys.add(key);
    const problem =
      (field.kind === "enum"
        ? valuesProblem(`field "${key}"`, field.values)
        : null) ?? boundProblem(field);
    if (problem !== null) return problem;
  }
  // No actions (absent or empty): the type takes none.
  return actions === undefined || actions.length === 0
    ? null
    : valuesProblem("actions", actions);
}

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
