import { telemetry } from "@/config/telemetry";
import type { Context } from "@/http/context";
import { type ResolvedTenant, resolvedTenant } from "@/tenancy/resolved-tenant";
import { quietThrottles } from "~/ports";

/** A resolved tenant a spec stands in with: every other field has its default (a live "t1" tenant named "acme"). */
export const tenantStandIn = (
  fields: Partial<ResolvedTenant> = {},
): ResolvedTenant =>
  resolvedTenant.parse({
    tenantId: "t1",
    slug: "acme",
    name: "Acme",
    signUp: false,
    issuer: "https://acme.example",
    slugIssuer: "https://acme.example",
    partition: "p1",
    version: 1,
    oauth: {},
    signIn: {},
    ...fields,
  });

/** What a spec chooses of a context; every other member is quiet. */
export interface ContextParts {
  request?: Request;
  ip?: string;
  /** The tenant the host names; `null` for none. */
  tenant?: ResolvedTenant | null;
  janus?: Partial<Context["janus"]>;
  throttles?: Partial<typeof quietThrottles>;
  headers?: Headers;
}

/** A resolver context for a spec that calls a service directly: complete, the members the spec names laid over quiet ones. */
export function contextOf(parts: ContextParts = {}): Context {
  const request = parts.request ?? new Request("https://acme.example/graphql");
  return {
    signal: new AbortController().signal,
    request,
    url: new URL(request.url),
    server: undefined,
    ip: parts.ip ?? "198.51.100.9",
    error: undefined,
    route: undefined,
    pathParams: {},
    set: {
      headers: parts.headers ?? new Headers(),
      cookies: new Bun.CookieMap(),
    },
    span: undefined,
    telemetry,
    tenant: async () =>
      parts.tenant === undefined ? tenantStandIn() : parts.tenant,
    janus: {
      user: async () => null,
      session: async () => null,
      ...parts.janus,
    },
    ...quietThrottles,
    ...parts.throttles,
  };
}
