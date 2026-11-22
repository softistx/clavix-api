import type { NewOf, ReadDocumentOf, TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { scopes } from "@/modules/resources";
import type { Translation } from "@/shared/translations";
import type {
  AttributeFamily,
  AttributeType,
  userAttributes,
} from "./attributes.model";

export type AttributeDoc = ReadDocumentOf<typeof userAttributes>;

/**
 * What the catalogue asks of the stored values (slice A2 owns them): how many
 * exist, so that a type, an option or a uniqueness can be locked or refused,
 * and the removal that goes with a permanent delete. Required and bound in
 * `src/config/attributes.ts`; until A2 it is `noAttributeValues` (no value
 * exists, so every count is 0).
 */
export interface AttributeValues {
  /** How many users hold a value of the attribute. */
  count(tenantId: ObjectId, attributeId: ObjectId): Promise<number>;
  /** The same for several attributes at once, by attribute id (hex); an attribute with no value counts 0. */
  counts(
    tenantId: ObjectId,
    attributeIds: readonly ObjectId[],
  ): Promise<Map<string, number>>;
  /** The values of the attribute stored under another type than `type`. */
  countOtherType(
    tenantId: ObjectId,
    attributeId: ObjectId,
    type: AttributeType,
  ): Promise<number>;
  /** The values that hold one of these option keys. */
  countOptions(
    tenantId: ObjectId,
    attributeId: ObjectId,
    keys: readonly string[],
  ): Promise<number>;
  /** The values that another user's value of the attribute already equals (what a `unique` flag would refuse). */
  countDuplicates(tenantId: ObjectId, attributeId: ObjectId): Promise<number>;
  /** Removes every value of the attribute (its permanent delete). Idempotent. */
  removeAll(tenantId: ObjectId, attributeId: ObjectId): Promise<void>;
}

export interface AttributesOptions {
  attributes: TypedCollection<typeof userAttributes>;
  /** Read only: an emission names a scope of the tenant. */
  scopes: TypedCollection<typeof scopes>;
  values: AttributeValues;
  /** The process's clock, passed in (never read from the system here). */
  clock: () => Date;
}

/** A text as a caller sends it: the locales it sets. */
export type Texts = readonly Translation[];

export interface OptionDraft {
  key: string;
  label: Texts;
}

export interface CreateAttributeInput {
  key: string;
  family: AttributeFamily;
  type: AttributeType;
  label: Texts;
  description?: Texts | undefined;
  unit?: string | null | undefined;
  options?: readonly OptionDraft[] | undefined;
  required?: boolean | undefined;
  userEditable?: boolean | undefined;
  unique?: boolean | undefined;
  emissionScope?: string | null | undefined;
}

/** The key and the family never change; a field left out keeps its value, `null` clears a nullable one. */
export interface UpdateAttributeInput {
  type?: AttributeType | undefined;
  label?: Texts | undefined;
  description?: Texts | undefined;
  unit?: string | null | undefined;
  options?: readonly OptionDraft[] | undefined;
  required?: boolean | undefined;
  userEditable?: boolean | undefined;
  unique?: boolean | undefined;
  emissionScope?: string | null | undefined;
}

export interface ListFilter {
  family?: AttributeFamily | undefined;
  archived: boolean;
}

/** What a creation stores. */
export type NewAttribute = Omit<NewOf<typeof userAttributes>, "tenantId">;

/** The settings of an attribute that an update can change. */
export type AttributeFields = Pick<
  AttributeDoc,
  | "type"
  | "label"
  | "description"
  | "unit"
  | "options"
  | "required"
  | "userEditable"
  | "unique"
  | "emission"
>;

/** What a write may set: the settings, the position and the archive date. */
export type AttributeChanges = Partial<
  AttributeFields & Pick<AttributeDoc, "position" | "archivedAt">
>;
