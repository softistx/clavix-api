import { printSchemaWithDirectives } from "@graphql-tools/utils";
import { lexicographicSortSchema } from "graphql";

// Writes the two schemas the server runs, every module's SDL merged with the
// scalars and @constraint, sorted, with every directive usage kept (graphql-js
// printSchema drops them): schema.graphql (hosted API) and
// console.schema.graphql (console API) at the repository root, the committed
// contracts clavix-ui generates its clients from. With --check, writes nothing
// and exits 1 when one is stale, which `bun run verify` runs.
// Building the schemas imports the app's config, which reads its environment
// and opens MongoDB at import (src/config/db.ts). Printing never queries, so
// the check needs nothing from the machine that runs it: a placeholder URI,
// and the database module replaced by an inert stand-in. Both come
// before the imports below, hence dynamic.
Bun.env["MONGO_URI"] ??= "mongodb://localhost:27017/clavix";
const { mock } = await import("bun:test");
// Config modules read it at import (`mongo.clients.default.db(...)`); a
// resolver only reads it when a request runs, which printing never does.
const inert: object = new Proxy(() => undefined, {
  get: () => inert,
  apply: () => inert,
});
mock.module("@/config/db", () => ({ mongo: inert, mongoConfig: inert }));
const { schema } = await import("@/http/schema");
const { consoleSchema } = await import("@/console/schema");

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
