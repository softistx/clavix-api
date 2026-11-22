import { printSchemaWithDirectives } from "@graphql-tools/utils";
import { lexicographicSortSchema } from "graphql";
import { consoleSchema } from "@/console/schema";
import { schema } from "@/http/schema";

// Writes the two schemas the server runs, every module's SDL merged with the
// scalars and @constraint, sorted, with every directive usage kept (graphql-js
// printSchema drops them): schema.graphql (hosted API) and
// console.schema.graphql (console API) at the repository root, the committed
// contracts clavix-ui generates its clients from. With --check, writes nothing
// and exits 1 when one is stale, which `bun run verify` runs. Importing the
// schemas wires the config but opens no connection (src/config/db.ts), so it
// needs no database.

const targets = [
  { path: `${import.meta.dir}/../../schema.graphql`, schema },
  {
    path: `${import.meta.dir}/../../console.schema.graphql`,
    schema: consoleSchema,
  },
];

const check = process.argv.includes("--check");
let stale = false;

for (const target of targets) {
  const printed = `${printSchemaWithDirectives(lexicographicSortSchema(target.schema))}\n`;
  const name = target.path.split("/").pop();
  if (check) {
    const file = Bun.file(target.path);
    const current = (await file.exists()) ? await file.text() : "";
    if (current !== printed) {
      console.error(
        `${name} is stale: run \`bun run schema:print\` and commit it`,
      );
      stale = true;
    }
  } else {
    await Bun.write(target.path, printed);
  }
}

if (stale) process.exit(1);
