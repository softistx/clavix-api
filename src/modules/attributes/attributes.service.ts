import { isDeepStrictEqual } from "node:util";
import {
  ConflictError,
  OptimisticLockError,
  scopeToTenant,
} from "@softistx/mongo";
import { ObjectId } from "mongodb";
import {
  cleanTranslations,
  mergeTranslations,
  OIDC_SCOPES,
} from "@/modules/resources";
import { isOneOf } from "@/shared/values";
import { refuse, refuseCommon } from "./attributes.refusals";
import {
  checkBehaviour,
  cleanKey,
  cleanLabel,
  cleanOptions,
  cleanUnit,
  MAX_ATTRIBUTES,
  MAX_DESCRIPTION,
  mergedLabel,
  removedOptionKeys,
} from "./attributes.rules";
import type {
  AttributeChanges,
  AttributeDoc,
  AttributeFields,
  AttributesOptions,
  CreateAttributeInput,
  ListFilter,
  NewAttribute,
  UpdateAttributeInput,
} from "./attributes.types";
import {
  byPosition,
  fieldsOf,
  idsOf,
  positionAfter,
  positionAt,
  STEP,
} from "./attributes.utils";

const STALE = "The attribute was changed meanwhile; read it and try again";

/**
 * A tenant's attribute catalogue (user-attributes slice A1). Every method
 * takes the tenant's id and reads and writes through its scope, so an
 * attribute of another tenant is "not found". The key and the family never
 * change; a stale `version` is `CONFLICT`; the type, the options and the
 * uniqueness are locked by the values the attribute holds (`AttributeValues`).
 * Archive, restore and the permanent delete are idempotent.
 */
export class AttributesService {
  constructor(private readonly options: AttributesOptions) {}

  private own(tenantId: ObjectId) {
    return scopeToTenant(this.options.attributes, tenantId);
  }

  /** The tenant's attributes (archived or live, as asked), by position. */
  async list(tenantId: ObjectId, filter: ListFilter): Promise<AttributeDoc[]> {
    const found = await this.own(tenantId).findMany(
      filter.family === undefined ? {} : { filter: { family: filter.family } },
    );
    return byPosition(
      found.filter((item) => (item.archivedAt !== null) === filter.archived),
    );
  }

  async find(
    tenantId: ObjectId,
    attributeId: string,
  ): Promise<AttributeDoc | undefined> {
    if (!ObjectId.isValid(attributeId)) return undefined;
    return this.own(tenantId).findById(new ObjectId(attributeId));
  }

  /** How many values each attribute holds, by id (hex). */
  valueCounts(tenantId: ObjectId, found: readonly AttributeDoc[]) {
    return this.options.values.counts(tenantId, idsOf(found));
  }

  async valueCount(tenantId: ObjectId, attribute: AttributeDoc) {
    return this.options.values.count(tenantId, attribute._id);
  }

  private async get(tenantId: ObjectId, id: string): Promise<AttributeDoc> {
    const found = await this.find(tenantId, id);
    if (found === undefined) {
      return refuseCommon("NOT_FOUND", "No such attribute");
    }
    return found;
  }

  /** Creates an attribute at the end of its family; the key is held from now on, even archived. */
  async create(
    tenantId: ObjectId,
    input: CreateAttributeInput,
  ): Promise<AttributeDoc> {
    const key = cleanKey(input.key);
    const fields = {
      type: input.type,
      label: cleanLabel(input.label),
      description: cleanTranslations(
        input.description,
        MAX_DESCRIPTION,
        "a description",
      ),
      unit: cleanUnit(input.unit),
      options: cleanOptions(input.options),
      required: input.required ?? false,
      userEditable: input.userEditable ?? false,
      unique: input.unique ?? false,
      emission: await this.emissionOf(tenantId, input.emissionScope),
    };
    checkBehaviour({ ...fields, family: input.family });
    const own = this.own(tenantId);
    const all = await own.findMany();
    if (all.length >= MAX_ATTRIBUTES) this.limit();
    const created = await this.insert(tenantId, {
      ...fields,
      key,
      family: input.family,
      position: positionAfter(all.filter((a) => a.family === input.family)),
    });
    // Two creations may both have passed the count: the later one is taken back.
    if ((await own.count()) > MAX_ATTRIBUTES) {
      await own.hardDeleteMany({ _id: created._id });
      this.limit();
    }
    return created;
  }

  private limit(): never {
    return refuse(
      "ATTRIBUTE_LIMIT",
      `a tenant has at most ${MAX_ATTRIBUTES} attributes`,
    );
  }

  private async insert(
    tenantId: ObjectId,
    values: NewAttribute,
  ): Promise<AttributeDoc> {
    try {
      return await this.own(tenantId).create(values);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      return refuse(
        "ATTRIBUTE_KEY_TAKEN",
        `the key "${values.key}" is already used by an attribute (archived ones keep theirs)`,
        "key",
      );
    }
  }

  /** The emission of a scope name: it must name a scope of the tenant (a standard OpenID Connect one counts). */
  private async emissionOf(
    tenantId: ObjectId,
    scope: string | null | undefined,
  ): Promise<{ scope: string } | null> {
    if (scope === undefined || scope === null) return null;
    const name = scope.trim();
    const known =
      isOneOf(OIDC_SCOPES, name) ||
      (await scopeToTenant(this.options.scopes, tenantId).exists({ name }));
    if (!known) {
      refuse(
        "ATTRIBUTE_SCOPE_UNKNOWN",
        `"${name}" is not a scope of this tenant`,
        "emissionScope",
      );
    }
    return { scope: name };
  }

  /** Changes an attribute at the `version` the caller read; nothing is written when nothing changes. */
  async update(
    tenantId: ObjectId,
    id: string,
    version: number,
    input: UpdateAttributeInput,
  ): Promise<AttributeDoc> {
    const found = await this.get(tenantId, id);
    if (found.archivedAt !== null) this.archived();
    if (found.version !== version) refuseCommon("CONFLICT", STALE);
    const fields = await this.nextFields(tenantId, found, input);
    if (isDeepStrictEqual(fields, fieldsOf(found))) {
      return found;
    }
    await this.checkLocks(tenantId, found, fields);
    const written = await this.write(tenantId, found, fields);
    if (fields.type !== found.type)
      await this.keepTypeLock(tenantId, found, written);
    if (fields.unique !== found.unique)
      return this.keepUnique(tenantId, found, written);
    return written;
  }

  private archived(): never {
    return refuse(
      "ATTRIBUTE_ARCHIVED",
      "an archived attribute cannot be changed; restore it first",
    );
  }

  /** The settings the attribute would have after `input`, checked among themselves. */
  private async nextFields(
    tenantId: ObjectId,
    found: AttributeDoc,
    input: UpdateAttributeInput,
  ) {
    const fields = {
      type: input.type ?? found.type,
      label: mergedLabel(found.label, input.label),
      description: mergeTranslations(
        found.description,
        input.description,
        MAX_DESCRIPTION,
        "a description",
      ),
      unit: input.unit === undefined ? found.unit : cleanUnit(input.unit),
      options:
        input.options === undefined
          ? found.options
          : cleanOptions(input.options),
      required: input.required ?? found.required,
      userEditable: input.userEditable ?? found.userEditable,
      unique: input.unique ?? found.unique,
      emission:
        input.emissionScope === undefined
          ? found.emission
          : await this.emissionOf(tenantId, input.emissionScope),
    };
    checkBehaviour({ ...fields, family: found.family });
    return fields;
  }

  /** What the stored values forbid: another type, a removed option in use, a `unique` they already break. */
  private async checkLocks(
    tenantId: ObjectId,
    found: AttributeDoc,
    next: AttributeFields,
  ): Promise<void> {
    const { values } = this.options;
    if (
      next.type !== found.type &&
      (await values.count(tenantId, found._id)) > 0
    ) {
      refuse(
        "ATTRIBUTE_TYPE_LOCKED",
        "the type cannot change while users hold a value",
        "type",
      );
    }
    const removed = removedOptionKeys(found.options, next.options);
    if (
      removed.length > 0 &&
      (await values.countOptions(tenantId, found._id, removed)) > 0
    ) {
      refuse(
        "ATTRIBUTE_OPTION_IN_USE",
        "an option that users hold cannot be removed",
        "options",
      );
    }
    if (
      next.unique &&
      !found.unique &&
      (await values.countDuplicates(tenantId, found._id)) > 0
    ) {
      refuse(
        "ATTRIBUTE_NOT_UNIQUE",
        "the stored values are not unique",
        "unique",
      );
    }
  }

  private async write(
    tenantId: ObjectId,
    found: AttributeDoc,
    fields: AttributeChanges,
  ): Promise<AttributeDoc> {
    try {
      return await this.own(tenantId).update(found._id, {
        ...fields,
        version: found.version,
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) refuseCommon("CONFLICT", STALE);
      throw error;
    }
  }

  /**
   * A value may have been written between the count and the write, under the
   * old type: when one holds another type than the new one, the type goes
   * back (risk 3) and the call is refused.
   */
  private async keepTypeLock(
    tenantId: ObjectId,
    before: AttributeDoc,
    written: AttributeDoc,
  ): Promise<void> {
    const other = await this.options.values.countOtherType(
      tenantId,
      written._id,
      written.type,
    );
    if (other === 0) return;
    await this.write(tenantId, written, fieldsOf(before));
    refuse(
      "ATTRIBUTE_TYPE_LOCKED",
      "the type cannot change while users hold a value",
      "type",
    );
  }

  /**
   * Writes the unique keys of the stored values for the new flag. Two values
   * that collide put the flag back (a value was written between the check and
   * now) and the call is refused.
   */
  private async keepUnique(
    tenantId: ObjectId,
    before: AttributeDoc,
    written: AttributeDoc,
  ): Promise<AttributeDoc> {
    const done = await this.options.values.setUnique(
      tenantId,
      written._id,
      written.unique,
    );
    if (done) return written;
    await this.write(tenantId, written, fieldsOf(before));
    return refuse(
      "ATTRIBUTE_NOT_UNIQUE",
      "the stored values are not unique",
      "unique",
    );
  }

  /** Puts the attribute at `position` (0-based) among the live ones of its family; one document is written. */
  async move(
    tenantId: ObjectId,
    id: string,
    position: number,
  ): Promise<AttributeDoc> {
    const found = await this.get(tenantId, id);
    if (found.archivedAt !== null) this.archived();
    const others = (
      await this.list(tenantId, { family: found.family, archived: false })
    ).filter((item) => !item._id.equals(found._id));
    const at =
      positionAt(others, position) ??
      (await this.renumber(tenantId, others, position));
    if (at === found.position) return found;
    return this.write(tenantId, found, { position: at });
  }

  /** Numbers the family afresh (`STEP` apart) and answers the position of the slot `index`. */
  private async renumber(
    tenantId: ObjectId,
    others: readonly AttributeDoc[],
    index: number,
  ): Promise<number> {
    const slot = Math.min(Math.max(index, 0), others.length);
    for (const [i, item] of others.entries()) {
      const place = (i < slot ? i + 1 : i + 2) * STEP;
      if (item.position !== place) {
        await this.write(tenantId, item, { position: place });
      }
    }
    return (slot + 1) * STEP;
  }

  /** Hides the attribute from the lists and from tokens; its key and values stay. Idempotent. */
  async archive(tenantId: ObjectId, id: string): Promise<AttributeDoc> {
    const found = await this.get(tenantId, id);
    if (found.archivedAt !== null) return found;
    return this.write(tenantId, found, { archivedAt: this.options.clock() });
  }

  /** Brings an archived attribute back. Idempotent. */
  async restore(tenantId: ObjectId, id: string): Promise<AttributeDoc> {
    const found = await this.get(tenantId, id);
    if (found.archivedAt === null) return found;
    return this.write(tenantId, found, { archivedAt: null });
  }

  /**
   * Deletes an archived attribute and every value it holds, and frees its key.
   * `confirmKey` must be the attribute's key. True also when it is already gone.
   */
  async delete(
    tenantId: ObjectId,
    id: string,
    confirmKey: string,
  ): Promise<boolean> {
    const found = await this.find(tenantId, id);
    if (found === undefined) return true;
    if (found.archivedAt === null) {
      refuse(
        "ATTRIBUTE_NOT_ARCHIVED",
        "archive the attribute before deleting it for good",
      );
    }
    if (confirmKey !== found.key) {
      refuse(
        "ATTRIBUTE_DELETE_UNCONFIRMED",
        "confirmKey must be the attribute's key",
        "confirmKey",
      );
    }
    // Values first: a repeat after a failure finds the attribute and finishes.
    await this.options.values.removeAll(tenantId, found._id);
    await this.own(tenantId).hardDeleteMany({ _id: found._id });
    return true;
  }
}
