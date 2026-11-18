import { createHash } from "node:crypto";
import { OAuthError, type OAuthIssuers } from "@softistx/janus-oauth";
import type { AgentClientsPort } from "@/modules/agents/agent-clients.service";
import { assertWithinQuota, QuotaExceededError } from "@/modules/usage/quota";
import { isLive } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import {
  type RegisterThrottle,
  RegisterThrottledError,
} from "./register-throttle";
import { suspendedResponse } from "./tenant-state";

/** RFC 7591 bodies are small: janus reads 16 KiB at most. */
export const REGISTER_BODY_LIMIT = 16 * 1024;

const NO_STORE = { "cache-control": "no-store" } as const;

export interface RegisterRouteDeps {
  resolver: Pick<TenantResolver, "resolveRequest">;
  serverFor: OAuthIssuers["serverFor"];
  /** Per address and tenant, and per tenant; none without Redis. */
  throttle?: RegisterThrottle | undefined;
  agents: AgentClientsPort;
  /** The `agents` quota that applies to the tenant (`null`: no limit). */
  agentQuotaOf: (tenantId: string) => Promise<number | null>;
  log?: (message: string) => void;
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
  const text = await request.text();
  if (new TextEncoder().encode(text).length > REGISTER_BODY_LIMIT) {
    throw new OAuthError(
      "invalid_client_metadata",
      "the registration body is too large",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `POST /register` (RFC 7591) of a tenant's agents (M3, D7, D9, D15): refuses a
 * suspended tenant, throttles per address and per tenant, checks the `agents`
 * quota, registers through janus (`server.registerClient`: the tenant's
 * policy decides what is accepted) and records the agent. A tenant that did
 * not opt in gets janus's own 400 `invalid_request`, before any throttle or
 * count is spent. `ip` is the client address the proxy chain gave.
 */
export function createRegisterRoute({
  resolver,
  serverFor,
  throttle,
  agents,
  agentQuotaOf,
  log = (message) => console.warn(message),
}: RegisterRouteDeps) {
  return async (
    request: Request,
    ip: string | undefined,
  ): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const tenant = await resolver.resolveRequest(request);
    if (tenant === null) return new Response(null, { status: 404 });
    if (!isLive(tenant)) return suspendedResponse();
    const server = await serverFor(request);
    if (server === null) return new Response(null, { status: 404 });
    try {
      if (server.registration.dynamic === "off") {
        // janus's own refusal (`invalid_request`), nothing counted.
        await server.registerClient(undefined);
      }
      try {
        await throttle?.check({ tenantId: tenant.tenantId, ip });
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
      const body = await readBody(request);
      try {
        assertWithinQuota(
          "agents",
          await agents.count(tenant.tenantId),
          await agentQuotaOf(tenant.tenantId),
        );
      } catch (error) {
        if (!(error instanceof QuotaExceededError)) throw error;
        return Response.json(
          { error: "access_denied", error_description: error.message },
          { status: 403, headers: NO_STORE },
        );
      }
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
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(error);
      log(
        `register: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  };
}
