import { isMetadataClientId, type OAuthIssuers } from "@softistx/janus-oauth";
import type { Exclusive } from "@/console/exclusive";
import type { AgentClientsPort } from "@/modules/agents";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";
import {
  agentsQuotaKey,
  agentsQuotaRefusal,
  lockUnavailable,
} from "./agents-quota";
import {
  type MetadataThrottle,
  MetadataThrottledError,
} from "./register-throttle";

/** The `/register` handler (`createRegisterRoute`). */
export type RegisterHandler = (
  request: Request,
  ip: string | undefined,
) => Promise<Response>;

export interface RegistrationOptions {
  resolver: Pick<TenantResolver, "resolveRequest">;
  register: RegisterHandler;
  agents: AgentClientsPort;
  /** Whether janus stored this client from a metadata document (`source: "metadata"`) in the tenant's partition. */
  isMetadataClient: (
    tenant: ResolvedTenant,
    clientId: string,
  ) => Promise<boolean>;
  /** Limits the document fetch per address and tenant; none without Redis. */
  throttle?: MetadataThrottle | undefined;
  /** The `agents` quota that applies to the tenant (`null`: no limit). */
  agentQuotaOf: (tenantId: string) => Promise<number | null>;
  /** Serializes a tenant's new agents (count, fetch, record); see `agentsQuotaKey`. */
  exclusive?: Exclusive | undefined;
  log?: (message: string) => void;
}

const NO_STORE = { "cache-control": "no-store" } as const;

/** The `client_id` of an authorization request (query) or a pushed one (form body). */
async function clientIdOf(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  if (request.method === "GET") return url.searchParams.get("client_id");
  if (url.pathname !== "/par" || request.method !== "POST") return null;
  try {
    const form = await request.clone().formData();
    const id = form.get("client_id");
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Wraps the issuers: `/register` is Clavix's own route, never janus's (it adds
 * the throttle, the `agents` quota and the agent record), as `handle` and as
 * `register(request, ip)` for the mount, which knows the client address. A
 * client that a Client ID Metadata Document describes is recorded as an agent
 * (`kind: "metadata"`) the first time `/authorize` or `/par` stored it (D8,
 * D15); it is idempotent, so a later use records nothing.
 */
export function withRegistration<
  T extends Pick<OAuthIssuers, "handle"> &
    Partial<Pick<OAuthIssuers, "serverFor">>,
>(
  oauth: T,
  {
    resolver,
    register,
    agents,
    isMetadataClient,
    throttle,
    agentQuotaOf,
    exclusive = (_key, work) => work(),
    log = console.warn,
  }: RegistrationOptions,
): Omit<T, "handle"> & {
  register: RegisterHandler;
  handle: (request: Request, ip?: string | undefined) => Promise<Response>;
} {
  /** The fetch limits, before janus fetches a document: a refusal is the response. */
  const throttleMetadata = async (
    tenant: ResolvedTenant,
    ip: string | undefined,
  ): Promise<Response | null> => {
    try {
      await throttle?.check({ tenantId: tenant.tenantId, ip });
      return null;
    } catch (error) {
      if (!(error instanceof MetadataThrottledError)) throw error;
      return Response.json(
        {
          error: "temporarily_unavailable",
          error_description: "Too many client metadata fetches; retry later",
        },
        {
          status: 429,
          headers: { ...NO_STORE, "retry-after": String(error.retryAfter) },
        },
      );
    }
  };
  const recordMetadata = async (tenant: ResolvedTenant, clientId: string) => {
    if (!(await isMetadataClient(tenant, clientId))) return;
    await agents.record(tenant.tenantId, { clientId, kind: "metadata" });
  };
  /** Records the client; never fails the request: the client is stored, the record is a count. */
  const recordSafely = (tenant: ResolvedTenant, clientId: string) =>
    recordMetadata(tenant, clientId).catch((error: unknown) =>
      log(
        `register: could not record metadata client ${clientId}: ${String(error)}`,
      ),
    );
  /**
   * `/authorize` or `/par` of a metadata-document client. A client not yet
   * recorded is a new agent: the quota check, janus's fetch and the record
   * run under the tenant's agents lock, so concurrent first uses cannot all
   * pass a quota of N.
   */
  const handleMetadata = async (
    request: Request,
    clientId: string,
    ip: string | undefined,
  ): Promise<Response> => {
    const tenant = await resolver.resolveRequest(request);
    if (tenant === null || !tenant.oauth.agents.metadataDocuments) {
      return oauth.handle(request);
    }
    const throttled = await throttleMetadata(tenant, ip);
    if (throttled !== null) return throttled;
    if (await agents.has(tenant.tenantId, clientId)) {
      const response = await oauth.handle(request);
      await recordSafely(tenant, clientId);
      return response;
    }
    return exclusive(agentsQuotaKey(tenant.tenantId), async () => {
      // Recorded by a request that held the lock before this one: not new.
      const over = (await agents.has(tenant.tenantId, clientId))
        ? null
        : await agentsQuotaRefusal(
            { count: (id) => agents.count(id), quotaOf: agentQuotaOf },
            tenant.tenantId,
          );
      if (over !== null) return over;
      const response = await oauth.handle(request);
      await recordSafely(tenant, clientId);
      return response;
    });
  };
  return {
    ...oauth,
    register,
    handle: async (request: Request, ip?: string | undefined) => {
      const path = new URL(request.url).pathname;
      if (path === "/register") return register(request, undefined);
      if (path !== "/authorize" && path !== "/par")
        return oauth.handle(request);
      const clientId = await clientIdOf(request);
      if (clientId === null || !isMetadataClientId(clientId)) {
        return oauth.handle(request);
      }
      try {
        return await handleMetadata(request, clientId, ip);
      } catch (error) {
        const unavailable = lockUnavailable(error);
        if (unavailable === null) throw error;
        return unavailable;
      }
    },
  };
}
