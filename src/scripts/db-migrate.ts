import { migrate, migrationStatus } from "@softistx/mongo/migrations";
import { mongo } from "@/config/db";
import { migrations } from "@/config/migrations";

// A deployment step, after `bun run db:sync` and before the new code rolls:
// applies the pending migrations (src/migrations) and prints each one's state.
// Never run from a request.
//
//   bun run db:migrate             apply what is pending
//   bun run db:migrate --dry-run   list what would run, write nothing
//   bun run db:migrate --status    print the states only
const args = Bun.argv.slice(2);
try {
  if (!args.includes("--status")) {
    const result = await migrate(mongo.db, migrations, {
      dryRun: args.includes("--dry-run"),
    });
    console.log(result);
  }
  console.table(await migrationStatus(mongo.db, migrations));
} finally {
  await mongo.close();
}
