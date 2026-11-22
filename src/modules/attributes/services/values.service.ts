import { ConflictError, scopeToTenant } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import { refuse, refuseCommon } from "../attributes.refusals";
import type { AttributeDoc, AttributeValues } from "../attributes.types";
import { canonicalValue, isEmpty, MAX_CHANGES, uniqueKeyOf } from "../rules";
import { byPosition, byUser, isRequired, matches } from "../utils";
import type {
  ExportedValue,
  PlannedWrite,
  SaveSection,
  ValueActor,
  ValueChange,
  ValueDoc,
  ValuesOptions,
} from "../values.types";

const GENERAL = { family: "USER" } as const satisfies SaveSection;
const TAKEN = "another user already holds this value";

/**
 * The values users hold for the tenant's attributes (user-attributes slice A2),
 * and what the catalogue asks of them (`AttributeValues`). Every method takes
 * the tenant's id and reads and writes through its scope. A save is checked
 * whole before it writes (a bad value writes nothing), a clear removes the
 * document, and `uniqueKey` is kept only for a `unique` attribute. The caller
 * holds the user's lock (`ctx.exclusive(userKey(...))`).
 */
export class AttributeValuesService implements AttributeValues {
  constructor(private readonly options: ValuesOptions) {}

  private own(tenantId: ObjectId) {
    return scopeToTenant(this.options.values, tenantId);
  }

  private catalogue(tenantId: ObjectId) {
    return scopeToTenant(this.options.attributes, tenantId);
  }

  // What the catalogue asks of the values.

  count(tenantId: ObjectId, attributeId: ObjectId): Promise<number> {
    return this.own(tenantId).count({ attributeId });
  }

  async counts(
    tenantId: ObjectId,
    attributeIds: readonly ObjectId[],
  ): Promise<Map<string, number>> {
    const counted = new Map(attributeIds.map((id) => [id.toHexString(), 0]));
    if (attributeIds.length === 0) return counted;
    // Grouped on the server; the tenant is in the match, as a scope would put it.
    const grouped = await this.options.values.raw
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { tenantId, attributeId: { $in: [...attributeIds] } } },
        { $group: { _id: "$attributeId", n: { $sum: 1 } } },
      ])
      .toArray();
    for (const { _id, n } of grouped) counted.set(_id.toHexString(), n);
    return counted;
  }

  countOtherType(
    tenantId: ObjectId,
    attributeId: ObjectId,
    type: AttributeDoc["type"],
  ): Promise<number> {
    return this.options.values.raw.countDocuments({
      tenantId,
      attributeId,
      type: { $ne: type },
    });
  }

  countOptions(
    tenantId: ObjectId,
    attributeId: ObjectId,
    keys: readonly string[],
  ): Promise<number> {
    // A single choice is stored as a one-element list: `$in` matches both.
    return this.options.values.raw.countDocuments({
      tenantId,
      attributeId,
      value: { $in: [...keys] },
    });
  }

  async countDuplicates(
    tenantId: ObjectId,
    attributeId: ObjectId,
  ): Promise<number> {
    const found = await this.own(tenantId).findMany({
      filter: { attributeId },
    });
    const seen = new Set<string>();
    let duplicates = 0;
    for (const doc of found) {
      const key = uniqueKeyOf(doc.type, doc.value);
      if (key === null) continue;
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
    }
    return duplicates;
  }

  async setUnique(
    tenantId: ObjectId,
    attributeId: ObjectId,
    unique: boolean,
  ): Promise<boolean> {
    const own = this.own(tenantId);
    const found = await own.findMany({ filter: { attributeId } });
    const done: ValueDoc[] = [];
    try {
      for (const doc of found) {
        const uniqueKey = unique ? uniqueKeyOf(doc.type, doc.value) : null;
        if (uniqueKey === doc.uniqueKey) continue;
        await own.update(doc._id, { uniqueKey });
        done.push(doc);
      }
      return true;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      for (const doc of done)
        await own.update(doc._id, { uniqueKey: doc.uniqueKey });
      return false;
    }
  }

  async removeAll(tenantId: ObjectId, attributeId: ObjectId): Promise<void> {
    await this.own(tenantId).hardDeleteMany({ attributeId });
  }

  // A user's values.

  /** The stored values of the users, by user id. */
  async ofUsers(
    tenantId: ObjectId,
    userIds: readonly string[],
  ): Promise<Map<string, ValueDoc[]>> {
    if (userIds.length === 0) return new Map();
    const found = await this.own(tenantId).findMany({
      filter: { userId: { $in: [...userIds] } },
    });
    return byUser(found);
  }

  /** The live USER-family attributes of the tenant, by position: the general section. */
  async general(tenantId: ObjectId): Promise<AttributeDoc[]> {
    const found = await this.catalogue(tenantId).findMany({
      filter: { family: "USER" },
    });
    return byPosition(found.filter((a) => a.archivedAt === null));
  }

  /** The users, among `userIds`, who lack a value of a required attribute of the general section. */
  async incomplete(
    tenantId: ObjectId,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    const required = (await this.general(tenantId)).filter((a) => a.required);
    if (required.length === 0) return new Set();
    const held = await this.ofUsers(tenantId, userIds);
    return new Set(
      userIds.filter((userId) => {
        const values = held.get(userId) ?? [];
        return !required.every((a) =>
          values.some(
            (v) =>
              v.attributeId.equals(a._id) && matches(v, a) && !isEmpty(v.value),
          ),
        );
      }),
    );
  }

  /**
   * Sets and clears values of one section for a user (the general one, or a
   * role's, whose links the caller read under the user's lock) and returns
   * every value the user holds afterwards. `enforceRequired` (the console's
   * saves) refuses a clear of a required attribute (the link's flag in a role
   * section); self-service never sets it. Nothing is written when any change
   * is refused.
   */
  async save(
    tenantId: ObjectId,
    userId: string,
    changes: readonly ValueChange[],
    actor: ValueActor,
    enforceRequired: boolean,
    section: SaveSection = GENERAL,
  ): Promise<ValueDoc[]> {
    if (changes.length > MAX_CHANGES)
      refuseCommon(
        "BAD_USER_INPUT",
        `Set at most ${MAX_CHANGES} values at once`,
        "values",
      );
    const stored = await this.own(tenantId).findMany({ filter: { userId } });
    const planned = await this.plan(
      tenantId,
      userId,
      changes,
      stored,
      enforceRequired,
      section,
    );
    await this.apply(tenantId, userId, planned, actor);
    return this.own(tenantId).findMany({ filter: { userId } });
  }

  /** Every change checked against the catalogue, the stored values and the other users' unique values. */
  private async plan(
    tenantId: ObjectId,
    userId: string,
    changes: readonly ValueChange[],
    stored: readonly ValueDoc[],
    enforceRequired: boolean,
    section: SaveSection,
  ): Promise<PlannedWrite[]> {
    const planned: PlannedWrite[] = [];
    const seen = new Set<string>();
    for (const [index, change] of changes.entries()) {
      const attribute = await this.target(
        tenantId,
        change.attributeId,
        index,
        section,
      );
      if (seen.has(change.attributeId))
        refuse(
          "ATTRIBUTE_VALUE_INVALID",
          "an attribute is set twice",
          `values.${index}`,
        );
      seen.add(change.attributeId);
      const held = stored.find((v) => v.attributeId.equals(attribute._id));
      if (change.value === null) {
        if (enforceRequired && isRequired(attribute, section))
          refuse(
            "ATTRIBUTE_REQUIRED",
            `"${attribute.key}" is required and cannot be cleared`,
            `values.${index}`,
          );
        planned.push({ index, attribute, stored: held, next: null });
        continue;
      }
      const value = canonicalValue(attribute, change.value, index);
      const uniqueKey = attribute.unique
        ? uniqueKeyOf(attribute.type, value)
        : null;
      await this.checkFree(tenantId, userId, attribute, uniqueKey, index);
      planned.push({
        index,
        attribute,
        stored: held,
        next: { value, uniqueKey },
      });
    }
    return planned;
  }

  /** The attribute a change names: a live one of the tenant, of the section's family and, for a role's, linked to the role. */
  private async target(
    tenantId: ObjectId,
    attributeId: string,
    index: number,
    section: SaveSection,
  ): Promise<AttributeDoc> {
    const field = `values.${index}`;
    const found = ObjectId.isValid(attributeId)
      ? await this.catalogue(tenantId).findById(attributeId)
      : undefined;
    if (found === undefined)
      return refuseCommon("NOT_FOUND", "attribute not found", field);
    if (found.archivedAt !== null)
      return refuse("ATTRIBUTE_ARCHIVED", "the attribute is archived", field);
    if (found.family !== section.family)
      return refuse(
        "ATTRIBUTE_FAMILY_MISMATCH",
        section.family === "USER"
          ? "the attribute is not a general one"
          : "the attribute is not a role one",
        field,
      );
    if (section.family === "ROLE" && !section.links.has(attributeId))
      return refuse(
        "ATTRIBUTE_FAMILY_MISMATCH",
        "the attribute is not linked to this role",
        field,
      );
    return found;
  }

  /** A friendly refusal before the unique index's: another user holds this key. */
  private async checkFree(
    tenantId: ObjectId,
    userId: string,
    attribute: AttributeDoc,
    uniqueKey: string | null,
    index: number,
  ): Promise<void> {
    if (uniqueKey === null) return;
    const holder = await this.own(tenantId).findFirst({
      attributeId: attribute._id,
      uniqueKey,
    });
    if (holder !== undefined && holder.userId !== userId)
      refuse("ATTRIBUTE_VALUE_TAKEN", TAKEN, `values.${index}`);
  }

  /** Writes the plan; a unique key taken in between puts back what was written and is refused. */
  private async apply(
    tenantId: ObjectId,
    userId: string,
    planned: readonly PlannedWrite[],
    actor: ValueActor,
  ): Promise<void> {
    const done: PlannedWrite[] = [];
    try {
      for (const write of planned) {
        await this.write(tenantId, userId, write, actor);
        done.push(write);
      }
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      for (const write of done.reverse())
        await this.restore(tenantId, userId, write);
      const failed = planned[done.length];
      return refuse(
        "ATTRIBUTE_VALUE_TAKEN",
        TAKEN,
        `values.${failed?.index ?? 0}`,
      );
    }
  }

  private async write(
    tenantId: ObjectId,
    userId: string,
    { attribute, stored, next }: PlannedWrite,
    actor: ValueActor,
  ): Promise<void> {
    const own = this.own(tenantId);
    if (next === null) {
      if (stored !== undefined) await own.delete(stored._id);
      return;
    }
    const fields = { type: attribute.type, ...next, updatedBy: actor };
    if (stored === undefined)
      await own.create({ userId, attributeId: attribute._id, ...fields });
    else await own.update(stored._id, fields);
  }

  /** Puts one written change back: the value it replaced, or no value. */
  private async restore(
    tenantId: ObjectId,
    userId: string,
    { attribute, stored }: PlannedWrite,
  ): Promise<void> {
    const own = this.own(tenantId);
    const now = await own.findFirst({ userId, attributeId: attribute._id });
    if (stored === undefined) {
      if (now !== undefined) await own.delete(now._id);
      return;
    }
    const { type, value, uniqueKey, updatedBy } = stored;
    if (now === undefined)
      await own.create({
        userId,
        attributeId: attribute._id,
        type,
        value,
        uniqueKey,
        updatedBy,
      });
    else await own.update(now._id, { type, value, uniqueKey, updatedBy });
  }

  /** Removes every value of a deleted user (or of a replaced account); returns how many. */
  removeUser(tenantId: ObjectId, userId: string): Promise<number> {
    return this.own(tenantId).hardDeleteMany({ userId });
  }

  /**
   * What the user's export holds of the values: every value stored, the ones
   * the user does not see (an archived attribute, a changed type) flagged
   * `hidden`, each with its attribute's key and label.
   */
  async personalDataOf(
    tenantId: ObjectId,
    userId: string,
  ): Promise<ExportedValue[]> {
    const stored = await this.own(tenantId).findMany({ filter: { userId } });
    const catalogue = new Map(
      (await this.catalogue(tenantId).findMany({})).map((a) => [
        a._id.toHexString(),
        a,
      ]),
    );
    const linking = await this.options.roleLinks.heldBy(tenantId, userId);
    return stored.flatMap((doc) => {
      const attribute = catalogue.get(doc.attributeId.toHexString());
      if (attribute === undefined) return [];
      const roles = (linking.get(doc.attributeId.toHexString()) ?? []).map(
        (role) => role.name,
      );
      // A role attribute shows while a held role links it; a user one always.
      const unseen = attribute.family === "ROLE" && roles.length === 0;
      return [
        {
          key: attribute.key,
          label: attribute.label,
          hidden:
            attribute.archivedAt !== null || unseen || !matches(doc, attribute),
          roles: attribute.family === "ROLE" ? roles : [],
          type: doc.type,
          value: doc.value,
          updatedAt: doc.updatedAt,
        },
      ];
    });
  }
}
