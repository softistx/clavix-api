// Temporary, until @softistx/mongo#393
import {
  type CursorPage,
  type CursorPaginateOptions,
  type FilterOf,
  type FindFirstOptions,
  type FindManyOptions,
  type IdOf,
  type ManyPatch,
  type NewOf,
  NotFoundError,
  objectId,
  type Patch,
  type ReadDocumentOf,
  type ReadOptions,
  type TypedCollection,
} from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { patchTouches } from "./patch-paths";

// The field every tenant-owned collection declares, first in its schema:
// `schema: z.object({ _id: id(), ...tenantField, … })`.
export const tenantField = { tenantId: objectId() };

// A collection whose documents belong to a tenant.
export type TenantOwned<Def> =
  ReadDocumentOf<Def> extends { tenantId: ObjectId } ? Def : never;

// What a caller may give when it creates or patches: everything but the
// tenant, which the scope sets and nothing may change. The omit distributes
// over `Patch`'s union, so the operator form (`$set`, `$inc`…) stays; a
// `tenantId` inside an operator, or in an object the types did not check,
// is refused at run time by `refuseTenantId`.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type ScopedNew<Def> = Omit<NewOf<Def>, "tenantId">;
type ScopedPatch<Def> = DistributiveOmit<Patch<Def>, "tenantId">;
type ScopedManyPatch<Def> = DistributiveOmit<ManyPatch<Def>, "tenantId">;

// Throws when a patch writes or removes `tenantId`. With `_id` immutable too
// (the collection refuses it), a document never leaves its tenant, so
// checking the tenant before a write by id is enough.
export function refuseTenantId(patch: unknown): void {
  if (patchTouches(patch, "tenantId")) {
    throw new TypeError(
      "A document's tenantId is immutable: a scoped write never changes it",
    );
  }
}

/**
 * One collection, seen from one tenant: every read is filtered on its
 * `tenantId`, every create stamps it, and a document of another tenant is
 * not found, by id included. A service reads and writes through this, never
 * through the collection itself, so no query builds its own tenant filter.
 */
export interface Scoped<Def> {
  readonly tenantId: ObjectId;
  findById(
    id: IdOf<Def> | string,
    options?: ReadOptions,
  ): Promise<ReadDocumentOf<Def> | undefined>;
  getById(
    id: IdOf<Def> | string,
    options?: ReadOptions,
  ): Promise<ReadDocumentOf<Def>>;
  findFirst(
    filter?: FilterOf<Def>,
    options?: FindFirstOptions<Def>,
  ): Promise<ReadDocumentOf<Def> | undefined>;
  findMany(options?: FindManyOptions<Def>): Promise<ReadDocumentOf<Def>[]>;
  count(filter?: FilterOf<Def>, options?: ReadOptions): Promise<number>;
  exists(filter: FilterOf<Def>, options?: ReadOptions): Promise<boolean>;
  paginateByCursor(
    options?: CursorPaginateOptions<Def>,
  ): Promise<CursorPage<ReadDocumentOf<Def>>>;
  create(values: ScopedNew<Def>): Promise<ReadDocumentOf<Def>>;
  // The same in one insert, each stamped with the scope's tenant; `[]`
  // sends nothing.
  createMany(values: readonly ScopedNew<Def>[]): Promise<ReadDocumentOf<Def>[]>;
  update(
    id: IdOf<Def> | string,
    patch: ScopedPatch<Def>,
  ): Promise<ReadDocumentOf<Def>>;
  delete(id: IdOf<Def> | string): Promise<ReadDocumentOf<Def>>;
  deleteMany(filter: FilterOf<Def>): Promise<number>;
  // A real delete of every document of this tenant the filter matches,
  // archived ones included, on a collection with a soft delete: what is
  // removed for good although its collection archives (the timetable's
  // untouched generated sessions). Returns how many.
  hardDeleteMany(filter: FilterOf<Def>): Promise<number>;
  // Patches every document of this tenant the filter matches: live ones,
  // or archived ones too with `withDeleted`. That one is bookkeeping on an
  // archive (who carried a link): it takes `$addToSet` and `$pull` only, a
  // TypeError otherwise, and goes through the driver, so it skips the
  // stamps (no `updatedAt`, `updatedBy`) and the lock (no `version` raised).
  // Returns how many changed.
  updateMany(
    filter: FilterOf<Def>,
    patch: ScopedManyPatch<Def>,
    options?: ReadOptions,
  ): Promise<number>;
  // Restores a soft-deleted document of this tenant; another tenant's, or
  // one that does not exist, is a NotFoundError.
  restore(id: IdOf<Def> | string): Promise<ReadDocumentOf<Def>>;
}

// Patches archived documents too, through the driver: `$addToSet` and
// `$pull` only, so a stale write cannot overwrite what an archive carried.
async function bookkeep<Def>(
  c: TypedCollection<Def>,
  filter: FilterOf<Def>,
  patch: object,
): Promise<number> {
  const operators = Object.keys(patch);
  if (
    operators.length === 0 ||
    operators.some((op) => op !== "$addToSet" && op !== "$pull")
  ) {
    throw new TypeError(
      "updateMany with withDeleted takes $addToSet and $pull only",
    );
  }
  const result = await c.raw.updateMany(filter as never, patch as never, {
    ...(c.session && { session: c.session }),
  });
  return result.modifiedCount;
}

export function scoped<Def>(
  collection: TypedCollection<TenantOwned<Def>>,
  tenantId: ObjectId,
): Scoped<Def> {
  // The casts below are the scope's one seam: `tenantId` is a field of every
  // TenantOwned document, which the generic filter types cannot see.
  const c = collection as unknown as TypedCollection<Def>;
  const within = (filter: FilterOf<Def> = {} as FilterOf<Def>) =>
    ({ ...filter, tenantId }) as FilterOf<Def>;
  const byId = (id: IdOf<Def> | string) =>
    within({ _id: id } as unknown as FilterOf<Def>);

  // The document `id` names, in this tenant, or a NotFoundError: a write by
  // id checks the tenant first, since the collection's own by-id writes do
  // not filter. A restore looks among the archived too.
  const owned = async (id: IdOf<Def> | string, options?: ReadOptions) => {
    const found = await c.findFirst(byId(id), options);
    if (!found) {
      throw new NotFoundError(
        `No document ${String(id)} in tenant ${tenantId.toHexString()}`,
      );
    }
    return found;
  };

  return {
    tenantId,
    findById: (id, options) => c.findFirst(byId(id), options),
    getById: owned,
    findFirst: (filter, options) => c.findFirst(within(filter), options),
    findMany: (options = {}) =>
      c.findMany({ ...options, filter: within(options.filter) }),
    count: (filter, options) => c.count(within(filter), options),
    exists: (filter, options) => c.exists(within(filter), options),
    // The cursor is bound to the tenant: another tenant's is `InvalidCursorError`.
    paginateByCursor: (options = {}) =>
      c.paginateByCursor({
        ...options,
        filter: within(options.filter),
        scope: String(tenantId),
      }),
    create: (values) => c.create({ ...values, tenantId } as NewOf<Def>),
    createMany: (values) =>
      c.createMany(values.map((v) => ({ ...v, tenantId }) as NewOf<Def>)),
    update: async (id, patch) => {
      refuseTenantId(patch);
      await owned(id);
      // Checked above: the patch leaves `tenantId` alone.
      return c.update(id, patch as Patch<Def>);
    },
    delete: async (id) => {
      await owned(id);
      return c.delete(id);
    },
    deleteMany: (filter) => c.deleteMany(within(filter)),
    hardDeleteMany: (filter) => c.hardDeleteMany(within(filter)),
    updateMany: async (filter, patch, options = {}) => {
      refuseTenantId(patch);
      if (!options.withDeleted) {
        return c.updateMany(within(filter), patch as ManyPatch<Def>);
      }
      return bookkeep(c, within(filter), patch);
    },
    restore: async (id) => {
      await owned(id, { withDeleted: true });
      return c.restore(id);
    },
  };
}
