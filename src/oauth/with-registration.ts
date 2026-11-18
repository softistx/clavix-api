import { isMetadataClientId, type OAuthIssuers } from "@softistx/janus-oauth";
import type { AgentClientsPort } from "@/modules/agents/agent-clients.service";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import type { TenantResolver } from "@/tenancy/resolver";

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
  log?: (message: string) => void;
}

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
    log = console.warn,
  }: RegistrationOptions,
): T & { register: RegisterHandler } {
  const recordMetadata = async (request: Request, clientId: string) => {
    const tenant = await resolver.resolveRequest(request);
    if (tenant === null || !tenant.oauth.agents.metadataDocuments) return;
    if (!(await isMetadataClient(tenant, clientId))) return;
    await agents.record(tenant.tenantId, { clientId, kind: "metadata" });
  };
  return {
    ...oauth,
    register,
    handle: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/register") return register(request, undefined);
      if (path !== "/authorize" && path !== "/par")
        return oauth.handle(request);
      const clientId = await clientIdOf(request);
      const response = await oauth.handle(request);
      if (clientId !== null && isMetadataClientId(clientId)) {
        // Never fails the request: the client is stored, the record is a count.
        await recordMetadata(request, clientId).catch((error: unknown) =>
          log(
            `register: could not record metadata client ${clientId}: ${String(error)}`,
          ),
        );
      }
      return response;
    },
  };
}
