import { compilePolicy, definePolicy } from "@softistx/limix";
import { conditions } from "./conditions";
import { consoleRules } from "./console.rules";
import { hostedRules } from "./hosted.rules";
import { restRulesFor } from "./rest.rules";

/**
 * Clavix guards its own API with limix (ADR-0043): the rules live here, in
 * code, loaded at start-up (no remote rules). Three policies (one per schema,
 * and the routes):
 * - `hostedPolicy` and `consolePolicy`: the root fields of each schema;
 * - `restPolicyFor`: the REST routes, which depend on what the app mounts.
 * Every root field and every route has a rule: `unmatched: "deny"`, and
 * `authz.coverage.spec.ts` plus `limix-codegen --check` fail the green bar for
 * an operation with none. The resolvers' own guards stay; the rules are the
 * contract they are compared with (`authz.guards.spec.ts`).
 */
/** The hosted `/graphql` (a session cookie): its root fields. */
export const hostedPolicy = compilePolicy(
  definePolicy(
    { limix: 1, global: { unmatched: "deny" }, graphql: hostedRules },
    { conditions },
  ),
  { conditions },
);

/** The console API (a bearer token): its root fields. */
export const consolePolicy = compilePolicy(
  definePolicy(
    { limix: 1, global: { unmatched: "deny" }, graphql: consoleRules },
    { conditions },
  ),
  { conditions },
);

/** The REST routes the app mounts (the OAuth endpoints and the console are optional). */
export const restPolicyFor = (mounted: { oauth: boolean; console: boolean }) =>
  compilePolicy(
    definePolicy({
      limix: 1,
      global: { unmatched: "deny" },
      rest: restRulesFor(mounted),
    }),
  );
