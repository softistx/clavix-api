import { createHash } from "node:crypto";
import { OAuthError, type OAuthIssuers } from "@softistx/janus-oauth";
import type { Exclusive } from "@/console/exclusive";
import type { AgentClientsPort } from "@/modules/agents";
import { isLive, type ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import {
  agentsQuotaKey,
  agentsQuotaRefusal,
  lockUnavailable,
} from "./agents-quota";
import {
  type RegisterThrottle,
  RegisterThrottledError,
} from "./register-throttle";
import { suspendedResponse } from "./tenant-state";

/** RFC 7591 bodies are small: janus reads 16 KiB at most. */
export const REGISTER_BODY_LIMIT = 16 * 1024;

type ServerOf = Awaited<ReturnType<OAuthIssuers["serverFor"]>>;

const NO_STORE = { "cache-control": "no-store" } as const;

export interface RegisterRouteDeps {
  resolver: Pick<TenantResolver, "resolveRequest">;
  serverFor: OAuthIssuers["serverFor"];
  /** Per address and tenant, and per tenant (`noThrottle` without Redis). */
  throttle: RegisterThrottle;
  agents: AgentClientsPort;
  /** The `agents` quota that applies to the tenant (`null`: no limit). */
  agentQuotaOf: (tenantId: string) => Promise<number | null>;
  /**
   * Runs the count, the registration and the record of a tenant one at a
   * time (the console's `exclusive`, Redis-backed in production).
   */
  exclusive: Exclusive;
  log: (message: string) => void;
}

const oauthError = (error: OAuthError) =>
  Response.json(error.toJSON(), { status: error.status, headers: NO_STORE });

/** A short digest of the address and the tenant: enough to spot one source, never the address. */
export const ipDigestOf = (tenantId: string, ip: string | undefined) =>
  ip === undefined
    ? null
    : createHash("sha256")
        .update(`${tenantId}/${ip}`)
        .digest("hex")
        .slice(0, 16);

/**
 * The body, parsed: JSON, at most 16 KiB. `undefined` is not JSON (janus then
 * answers `invalid_client_metadata` for a body that is not an object).
 */
async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    // Never more than the limit in memory, whatever `Content-Length` said.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REGISTER_BODY_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new OAuthError(
          "invalid_client_metadata",
          "the registration body is too large",
        );
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    const body: unknown = JSON.parse(text);
    return body;
  } catch {
    return undefined;
  }
}

/** A declared `Content-Length` over the limit: 413, before anything is read. */
function tooLarge(request: Request): Response | null {
  const declared = Number(request.headers.get("content-length"));
  if (!(declared > REGISTER_BODY_LIMIT)) return null;
  return Response.json(
    {
      error: "invalid_client_metadata",
      error_description: "the registration body is too large",
    },
    { status: 413, headers: NO_STORE },
  );
}

/** Method, declared size, tenant, live, and dynamic registration on: a refusal is the response. */
async function guardRequest(
  { resolver, serverFor }: RegisterRouteDeps,
  request: Request,
): Promise<
  | { response: Response }
  | { tenant: ResolvedTenant; server: NonNullable<ServerOf> }
> {
  if (request.method !== "POST") {
    return {
      response: new Response(null, { status: 405, headers: { allow: "POST" } }),
    };
  }
  const oversized = tooLarge(request);
  if (oversized !== null) return { response: oversized };
  const tenant = await resolver.resolveRequest(request);
  if (tenant === null) return { response: new Response(null, { status: 404 }) };
  if (!isLive(tenant)) return { response: suspendedResponse() };
  const server = await serverFor(request);
  if (server === null) return { response: new Response(null, { status: 404 }) };
  return { tenant, server };
}

/** The per-address and per-tenant limit: a refusal is the 429 response. */
async function throttleRegistration(
  { throttle }: RegisterRouteDeps,
  tenant: ResolvedTenant,
  ip: string | undefined,
): Promise<Response | null> {
  try {
    await throttle.check({ tenantId: tenant.tenantId, ip });
    return null;
  } catch (error) {
    if (!(error instanceof RegisterThrottledError)) throw error;
    return Response.json(
      {
        error: "temporarily_unavailable",
        error_description: "Too many registrations; retry later",
      },
      {
        status: 429,
        headers: { ...NO_STORE, "retry-after": String(error.retryAfter) },
      },
    );
  }
}

/** The quota check, the registration and the record, to run under the tenant's lock. */
async function registerAgent(
  { agents, agentQuotaOf }: RegisterRouteDeps,
  server: NonNullable<ServerOf>,
  tenant: ResolvedTenant,
  ip: string | undefined,
  body: unknown,
): Promise<Response> {
  const over = await agentsQuotaRefusal(
    { count: (id) => agents.count(id), quotaOf: agentQuotaOf },
    tenant.tenantId,
  );
  if (over !== null) return over;
  const registered = await server.registerClient(body);
  try {
    await agents.record(tenant.tenantId, {
      clientId: registered.client_id,
      kind: "dynamic",
      ipDigest: ipDigestOf(tenant.tenantId, ip),
    });
  } catch (error) {
    // An unrecorded agent would escape the quota and the clean-up job.
    await server.deleteClient(registered.client_id).catch(() => undefined);
    throw error;
  }
  return Response.json(registered, { status: 201, headers: NO_STORE });
}

/** What a failed registration answers: janus's refusal, the lock's, or the error rethrown. */
function registrationFailure(
  { log }: RegisterRouteDeps,
  error: unknown,
): Response {
  if (error instanceof OAuthError) return oauthError(error);
  const unavailable = lockUnavailable(error);
  if (unavailable !== null) return unavailable;
  log(`register: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}

/** The throttle, the body and the exclusive section, once the request is accepted. */
async function registerChecked(
  deps: RegisterRouteDeps,
  request: Request,
  ip: string | undefined,
  { tenant, server }: { tenant: ResolvedTenant; server: NonNullable<ServerOf> },
): Promise<Response> {
  if (server.registration.dynamic === "off") {
    // janus's own refusal (`invalid_request`), nothing counted.
    await server.registerClient(undefined);
  }
  const throttled = await throttleRegistration(deps, tenant, ip);
  if (throttled !== null) return throttled;
  const body = await readBody(request);
  // The count, the registration and the record under one lock per
  // tenant: concurrent registrations cannot all pass a quota of N.
  return deps.exclusive(agentsQuotaKey(tenant.tenantId), () =>
    registerAgent(deps, server, tenant, ip, body),
  );
}

/**
 * `POST /register` (RFC 7591) of a tenant's agents (M3, D7, D9, D15): refuses a
 * suspended tenant, throttles per address and per tenant, checks the `agents`
 * quota, registers through janus (`server.registerClient`: the tenant's
 * policy decides what is accepted) and records the agent. A tenant that did
 * not opt in gets janus's own 400 `invalid_request`, before any throttle or
 * count is spent. `ip` is the client address the proxy chain gave.
 */
export function createRegisterRoute(deps: RegisterRouteDeps) {
  return async (
    request: Request,
    ip: string | undefined,
  ): Promise<Response> => {
    const guarded = await guardRequest(deps, request);
    if ("response" in guarded) return guarded.response;
    try {
      return await registerChecked(deps, request, ip, guarded);
    } catch (error) {
      return registrationFailure(deps, error);
    }
  };
}
