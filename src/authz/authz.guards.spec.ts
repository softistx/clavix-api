import { expect, test } from "bun:test";
import type { Guard } from "@/console/guard";
import { guards } from "@/console/modules";
import { consolePolicy } from "./policy";

// The console's resolver guards stay (they also check what a rule cannot: a
// suspended tenant, the platform tenant, a proved e-mail). The rules are their
// coarse contract: the same permission on the same object for every root
// field, or this spec fails.

const PLATFORM_CONDITION = {
  view: "platformView",
  edit: "platformEdit",
  manage: "platformManage",
} as const;

// The argument a guard reads the tenant from: `tenantId`, or `id` (the tenant itself).
const argumentOf = (guard: Extract<Guard, { kind: "tenant" }>) => {
  const probe = { tenantId: "from-tenantId", id: "from-id" };
  return guard.tenant(probe) === "from-id" ? "id" : "tenantId";
};

const expected = (guard: Guard) => {
  switch (guard.kind) {
    case "signedIn":
      return { authenticated: true };
    case "platform":
      return {
        authenticated: true,
        when: [PLATFORM_CONDITION[guard.permission]],
      };
    case "tenant":
      return {
        authenticated: true,
        relations: [
          {
            require: [
              [
                {
                  relation: guard.permission,
                  type: "tenant",
                  from: `args.${argumentOf(guard)}`,
                },
              ],
            ],
            onDeny: "FORBIDDEN" as const,
          },
        ],
      };
  }
};

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
      rule: expected(guard),
    });
  }
});
