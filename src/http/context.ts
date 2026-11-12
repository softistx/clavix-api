import { alxia } from "@alxia/core";
import type { GraphQLContext } from "@alxia/graphql";
import { env } from "../config/env";
import { tenantResolver } from "../config/tenancy";
import type { ResolvedTenant } from "../tenancy/resolved-tenant";
import type { TenantResolver } from "../tenancy/resolver";

// The base: what every resolver reads, decorated or derived here.
// `tenant()` is the tenant the request's host names (`null`: none, a 404 for
// the OAuth endpoints), resolved once per request, on first use.
export function createBase(resolver: TenantResolver = tenantResolver) {
  return alxia()
    .decorate({ env })
    .derive(({ request }) => {
      let tenant: Promise<ResolvedTenant | null> | undefined;
      return {
        tenant: () => {
          tenant ??= resolver.resolveRequest(request);
          return tenant;
        },
      };
    });
}

export type Base = ReturnType<typeof createBase>;

// A resolver's context: Yoga's and the base's. The generated `Resolvers` takes
// it (codegen.ts: `contextType`).
export type Context = Readonly<GraphQLContext<Base>>;
