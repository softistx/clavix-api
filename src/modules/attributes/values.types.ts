import type { ReadDocumentOf, TypedCollection } from "@softistx/mongo";
import type {
  AttributeType,
  attributeValues,
  StoredValue,
  userAttributes,
} from "./attributes.model";
import type { AttributeDoc, HeldRoleLinks } from "./attributes.types";

export type ValueDoc = ReadDocumentOf<typeof attributeValues>;

/** Who writes a value: an administrator of the console, or the user themselves (slice A7). */
export interface ValueActor {
  kind: "admin" | "user";
  id: string;
}

/**
 * A value as a caller sends it: exactly the field of the attribute's type
 * (`text` for STRING and TEXT, `color`, `number`, `date` as "YYYY-MM-DD",
 * `dateTime`, `time`, `options` for SELECT and MULTI_SELECT, `boolean`).
 */
export interface ValueInput {
  text?: string | null | undefined;
  color?: string | null | undefined;
  number?: number | null | undefined;
  boolean?: boolean | null | undefined;
  date?: string | null | undefined;
  dateTime?: Date | string | null | undefined;
  time?: string | null | undefined;
  options?: readonly string[] | null | undefined;
}

/** One change of a save: a value to set, or `null` to clear it. */
export interface ValueChange {
  attributeId: string;
  value: ValueInput | null;
}

export interface ValuesOptions {
  values: TypedCollection<typeof attributeValues>;
  /** Read only: a write reads the attribute it sets. */
  attributes: TypedCollection<typeof userAttributes>;
  /** Read only: the export hides a role attribute no held role links. */
  roleLinks: HeldRoleLinks;
}

/**
 * The section a save is about: the general one (attributes of family USER), or
 * a role's, with the role's links (attribute id in hex, its `required`).
 */
export type SaveSection =
  | { family: "USER" }
  | { family: "ROLE"; links: ReadonlyMap<string, boolean> };

/** What the console shows of one attribute for a user: the typed field that holds the value, the others null. */
export interface ShownValue {
  attributeId: string;
  text: string | null;
  color: string | null;
  number: number | null;
  boolean: boolean | null;
  date: string | null;
  dateTime: Date | null;
  time: string | null;
  options: string[] | null;
}

/** One value of a user's data export. */
export interface ExportedValue {
  key: string;
  label: ReadonlyArray<{ locale: string; text: string }>;
  hidden: boolean;
  roles: string[];
  type: AttributeType;
  value: StoredValue;
  updatedAt: Date;
}

/** A change of a save, checked: what to write for one attribute (`next` null clears it). */
export interface PlannedWrite {
  index: number;
  attribute: AttributeDoc;
  stored: ValueDoc | undefined;
  next: { value: StoredValue; uniqueKey: string | null } | null;
}
