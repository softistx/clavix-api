import type { Migration } from "@softistx/mongo/migrations";
import { clavixTenant } from "./2026-11-10-clavix-tenant.migration";
import {
  type ConsoleSeedOptions,
  consoleSeed,
} from "./2026-11-12-console.migration";
import { scopesMigration } from "./2026-11-13-scopes.migration";
import { clientGrantsMigration } from "./2026-11-15-client-grants.migration";
import { nameKeysMigration } from "./2026-11-16-name-keys.migration";
import { oauthPolicyMigration } from "./2026-11-16-oauth-policy.migration";
import { consolePushedDpopMigration } from "./2026-11-17-console-par-dpop.migration";

// The migrations `bun run db:migrate` applies, oldest first. Each is a file
// `<date>-<name>.migration.ts` in this folder, added here.
// The console seed takes what the context lacks (`config/migrations.ts` binds it).
export const migrationsOf = (
  options: ConsoleSeedOptions,
): readonly Migration[] => [
  clavixTenant,
  consoleSeed(options),
  scopesMigration,
  clientGrantsMigration,
  nameKeysMigration,
  oauthPolicyMigration,
  consolePushedDpopMigration,
];
