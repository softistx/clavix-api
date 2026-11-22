import { migrate, migrationStatus } from "@softistx/mongo/migrations";
import { closeMongo, connectMongo, mongo } from "@/config/db";
import { migrationsWith } from "@/config/migrations";

// A deployment step, after `bun run db:sync` and before the new code rolls:
// applies the pending migrations (src/migrations) and prints each one's state.
// Never run from a request.
//
//   bun run db:migrate             apply what is pending
//   bun run db:migrate --dry-run   list what would run, write nothing
//   bun run db:migrate --status    print the states only
const args = Bun.argv.slice(2);
const migrations = migrationsWith((clientSecret) =>
  console.log(
    `console client secret (shown once, stored hashed): ${clientSecret}`,
  ),
);
try {
  await connectMongo();
  if (!args.includes("--status")) {
    const result = await migrate(mongo.db, migrations, {
      dryRun: args.includes("--dry-run"),
    });
    console.log(result);
  }
  console.table(await migrationStatus(mongo.db, migrations));
} finally {
  await closeMongo();
}
