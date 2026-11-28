import { compilePolicy, parseRules } from "@softistx/limix";
import type { LimixGraxiaOptions } from "@softistx/limix-graxia";
import { conditions } from "@/authz/conditions";
import { CONSOLE_SCOPE, platformCondition } from "@/authz/console.helpers";
import { consoleRules } from "@/authz/console.rules";
import { consoleLimix } from "@/authz/options";
import type { Guard, Guards } from "@/console/guard";

// The argument a guard reads the tenant from: `tenantId`, or `id` (the tenant itself).
const argumentOf = (guard: Extract<Guard, { kind: "tenant" }>) => {
  const probe = { tenantId: "from-tenantId", id: "from-id" };
  // A guard lowercases the id it reads.
  const read = guard.tenant(probe).toLowerCase();
  if (read === "from-id") return "id";
  if (read === "from-tenantid") return "tenantId";
  throw new Error(`a tenant guard reads neither tenantId nor id: ${read}`);
};

// Every console rule also asks the scope the token carries.
const floor = { authenticated: true, permissions: [[CONSOLE_SCOPE]] };

/** The rule a console resolver guard stands for: the same permission on the same object. */
export const ruleOf = (guard: Guard) => {
  switch (guard.kind) {
    case "signedIn":
      return floor;
    case "platform":
      return { ...floor, when: [platformCondition[guard.permission]] };
    case "tenant":
      return {
        ...floor,
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

/**
 * The console's limix options with the rules of a spec's extra fields added,
 * each worded from its guard (`ruleOf`): a spec that serves extra root fields
 * (`createConsoleSchema({ guards })`) keeps limix on, like production.
 */
export const consoleLimixWith = (extra: Guards): LimixGraxiaOptions<object> => {
  const graphql: Record<string, Record<string, unknown>> = {
    Query: { ...consoleRules.Query },
    Mutation: { ...consoleRules.Mutation },
  };
  for (const [name, guard] of Object.entries(extra)) {
    const [type = "", field = ""] = name.split(".");
    graphql[type] = { ...graphql[type], [field]: ruleOf(guard) };
  }
  return {
    ...consoleLimix,
    policy: compilePolicy(
      parseRules({ limix: 1, global: { unmatched: "deny" }, graphql }),
      { conditions },
    ),
  };
};
