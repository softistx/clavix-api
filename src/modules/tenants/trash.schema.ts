import { z } from "zod";

/** Days a deleted tenant stays restorable before its data is purged (ADR-0038). */
export const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1_000;

// The purge's own marks on a tenant, spread into the `tenants` schema.
// `purgeStartedAt`: the purge claimed the tenant, which can no longer be
// restored. `purgedAt`: its data is gone and the document is the tombstone
// that keeps the slug reserved.
export const trashFields = {
  purgeStartedAt: z.date().optional(),
  purgedAt: z.date().optional(),
};

/** When a tenant deleted at `deletedAt` is purged for good. */
export const purgeAtOf = (deletedAt: Date) =>
  new Date(deletedAt.getTime() + TRASH_MS);

/** The latest `deletedAt` whose trash is due at `now`. */
export const purgeCutoff = (now: Date) => new Date(now.getTime() - TRASH_MS);
