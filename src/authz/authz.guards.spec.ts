import { expect, test } from "bun:test";
import { guards } from "@/console/modules";
import { ruleOf } from "~/guard-rules";
import { consolePolicy } from "./policy";

// The console's resolver guards stay (they also check what a rule cannot: a
// suspended tenant, the platform tenant, a proved e-mail). The rules are their
// coarse contract: the same permission on the same object for every root
// field, or this spec fails.

const entries = Object.entries(consolePolicy.graphql ?? {}).flatMap(
  ([type, fields]) =>
    Object.entries(fields).map(([field, entry]) => ({
      name: `${type}.${field}`,
      rule: entry.rule,
    })),
);

test("the console rules ask what each resolver guard asks, field by field", () => {
  const rules = new Map(entries.map((entry) => [entry.name, entry.rule]));
  expect([...rules.keys()].sort()).toEqual(Object.keys(guards).sort());
  for (const [name, guard] of Object.entries(guards)) {
    expect({ name, rule: rules.get(name) }).toEqual({
      name,
      rule: ruleOf(guard),
    });
  }
});
