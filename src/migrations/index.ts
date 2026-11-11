import type { Migration } from "@softistx/mongo/migrations";

// The migrations `bun run db:migrate` applies, oldest first. Each is a file
// `<date>-<name>.migration.ts` in this folder, added here. Empty until step 2
// of slice 1.1 adds the platform tenant's seed.
export const migrations: readonly Migration[] = [];
