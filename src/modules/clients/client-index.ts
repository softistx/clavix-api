import {
  ConflictError,
  type ReadDocumentOf,
  scopeToTenant,
  type TypedCollection,
} from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { clientIndex } from "./clients.model";

export type ClientIndexEntry = ReadDocumentOf<typeof clientIndex>;

export interface ClientIndexRecord {
  clientId: string;
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The tenant-scoped list of clients (clients.model.ts). Temporary, until
 * @softistx/janus-oauth#706 adds `listClients`: then the console lists the
 * janus store and this goes.
 */
export function createClientIndex(
  collection: TypedCollection<typeof clientIndex>,
) {
  const of = (tenantId: ObjectId) => scopeToTenant(collection, tenantId);
  return {
    /** Adds the client or replaces what the index holds of it. Idempotent. */
    async upsert(tenantId: ObjectId, record: ClientIndexRecord): Promise<void> {
      const scoped = of(tenantId);
      const patch = {
        name: record.name,
        type: record.type,
        redirectUris: [...record.redirectUris],
      };
      const existing = await scoped.findFirst({ clientId: record.clientId });
      if (existing !== undefined) {
        await scoped.update(existing._id, patch);
        return;
      }
      try {
        await scoped.create({ clientId: record.clientId, ...patch });
      } catch (error) {
        // A concurrent upsert created it: update that one.
        if (!(error instanceof ConflictError)) throw error;
        const raced = await scoped.findFirst({ clientId: record.clientId });
        if (raced !== undefined) await scoped.update(raced._id, patch);
      }
    },

    /**
     * Takes the client id for a client about to be created: `false` when the
     * tenant already lists it (the unique index decides between two callers).
     */
    async claim(
      tenantId: ObjectId,
      record: ClientIndexRecord,
    ): Promise<boolean> {
      try {
        await of(tenantId).create({
          clientId: record.clientId,
          name: record.name,
          type: record.type,
          redirectUris: [...record.redirectUris],
        });
        return true;
      } catch (error) {
        if (error instanceof ConflictError) return false;
        throw error;
      }
    },

    /** Removes the client from the index; `false` when it was not there. */
    async remove(tenantId: ObjectId, clientId: string): Promise<boolean> {
      return (await of(tenantId).hardDeleteMany({ clientId })) > 0;
    },

    /** A page of the tenant's clients by name, filtered by `q` (a part of the name or id). */
    async page(
      tenantId: ObjectId,
      options: { after?: string | null; limit: number; q?: string | undefined },
    ) {
      const q = options.q?.trim();
      const page = await of(tenantId).paginateByCursor({
        after: options.after ?? null,
        limit: options.limit,
        orderBy: "name",
        ...(q === undefined || q === ""
          ? {}
          : {
              filter: {
                $or: [
                  { name: { $regex: escapeRegex(q), $options: "i" } },
                  { clientId: { $regex: escapeRegex(q), $options: "i" } },
                ],
              },
            }),
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },
  };
}

export type ClientIndex = ReturnType<typeof createClientIndex>;
