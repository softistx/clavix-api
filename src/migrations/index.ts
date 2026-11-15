import type { Migration } from "@softistx/mongo/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import { consoleSeed } from "./2026-11-12-console.migration";
import { scopesMigration } from "./2026-11-13-scopes.migration";
import { clientGrantsMigration } from "./2026-11-15-client-grants.migration";

// The migrations `bun run db:migrate` applies, oldest first. Each is a file
// `<date>-<name>.migration.ts` in this folder, added here.
export const migrations: readonly Migration[] = [
  clavixTenant,
  consoleSeed,
  scopesMigration,
  clientGrantsMigration,
];
