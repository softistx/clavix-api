import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { coverage } from "@softistx/limix/coverage";
import { alxiaOperations, checkRoutes } from "@softistx/limix-alxia";
import { graphqlOperations } from "@softistx/limix-graxia";
import { createConsoleDeps } from "@/config/console";
import { createTestApp } from "~/app";
import { consolePolicy, hostedPolicy, restPolicyFor } from "./policy";

// A rule for every operation, and no rule for none: what `unmatched: "deny"`
// would refuse at run time fails the green bar here, with its name.
const sdl = (file: string) => readFileSync(file, "utf8");

const names = (report: ReturnType<typeof coverage>, status: string) =>
  report.operations
    .filter((entry) => entry.status === status)
    .map((entry) => entry.label);

test("every root field of the hosted schema has a rule, and no rule is stale", () => {
  const report = coverage(
    hostedPolicy,
    graphqlOperations(sdl("schema.graphql")),
  );
  expect(names(report, "uncovered")).toEqual([]);
  expect(report.stale).toEqual([]);
});

test("every root field of the console schema has a rule, and no rule is stale", () => {
  const report = coverage(
    consolePolicy,
    graphqlOperations(sdl("console.schema.graphql")),
  );
  expect(names(report, "uncovered")).toEqual([]);
  expect(report.stale).toEqual([]);
});

test("every route of the app, with the OAuth endpoints and the console mounted, has a rule and every rule a route", () => {
  const handle = async () => new Response(null, { status: 204 });
  const app = createTestApp({
    oauth: { handle },
    console: createConsoleDeps({ serverFor: async () => null }),
  });
  const policy = restPolicyFor({ oauth: true, console: true });
  const report = coverage(policy, alxiaOperations(app));
  expect(names(report, "uncovered")).toEqual([]);
  expect(report.stale).toEqual([]);
  expect(checkRoutes(policy, app)).toEqual([]);
});

test("without the OAuth endpoints and the console, the rules of the base routes fit", () => {
  const app = createTestApp();
  const policy = restPolicyFor({ oauth: false, console: false });
  expect(checkRoutes(policy, app)).toEqual([]);
  expect(names(coverage(policy, alxiaOperations(app)), "uncovered")).toEqual(
    [],
  );
});
