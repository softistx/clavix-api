import { alxia, forwardedIp } from "@alxia/core";
import type { GraphQLContext } from "@alxia/graphql";
import type { JanusContext } from "@softistx/janus-graphql";
import { env } from "@/config/env";
import { tenantResolver } from "@/config/tenancy";
import { passkeyThrottle, signInThrottle } from "@/config/throttle";
import type { ThrottleContext } from "@/http/throttle/context";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import type { TenantJanus } from "@/users/tenant-janus";

// The base: what every resolver reads, decorated or derived here.
// The throttles of the anonymous operations (`ctx.signInThrottle`,
// `ctx.passkeyThrottle`; none: no extra limit) ride on the context, typed.
// `tenant()` is the tenant the request's host names (`null`: none, a 404 for
// the OAuth endpoints), resolved once per request, on first use.
export function createBase(
  resolver: TenantResolver = tenantResolver,
  throttles: ThrottleContext = { signInThrottle, passkeyThrottle },
) {
  // `ctx.ip`: the connection's address, or, behind CLAVIX_TRUSTED_PROXIES
  // proxies, the client X-Forwarded-For names (never believed beyond them).
  return alxia(
    env.CLAVIX_TRUSTED_PROXIES === 0
      ? {}
      : { ip: forwardedIp({ trusted: env.CLAVIX_TRUSTED_PROXIES }) },
  )
    .decorate({ env })
    .decorate(throttles)
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
export type Context = Readonly<GraphQLContext<Base, JanusContext<TenantJanus>>>;
