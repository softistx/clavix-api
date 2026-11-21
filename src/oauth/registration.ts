import {
  MCP_CLIENT_REDIRECT_URIS,
  MCP_METADATA_DOCUMENT_HOSTS,
  type OAuthMetadataDocumentOptions,
  type OAuthRegistration,
  redirectUriProblem,
} from "@softistx/janus-oauth";
import type { AgentsPolicy } from "@/modules/oauth-policy";
import { unique } from "@/shared/values";

/**
 * The transport of the Client ID Metadata Documents fetch. Production uses
 * janus's own (the global `fetch` and the system resolver); a spec injects
 * both so that none touches the network.
 */
export type MetadataTransport = Pick<
  OAuthMetadataDocumentOptions,
  "fetch" | "resolve"
>;

/** The ports a metadata document may be served on (`allowPorts`): the standard HTTPS port. */
export const DEFAULT_METADATA_PORTS: readonly number[] = [443];

/**
 * janus's `registration` for a tenant's agents policy (M3, D7 and D8).
 * `restricted` is the MCP clients' redirect URIs plus the tenant's own list;
 * `open` any valid redirect URI. Documents are fetched only from the MCP hosts
 * plus the tenant's `allowHosts`, never from any host. A redirect URI of the
 * list that janus's rules refuse is left out (it would be a `TypeError` that
 * takes the tenant's whole OAuth server down).
 */
export function registrationOf(
  agents: AgentsPolicy,
  transport: MetadataTransport = {},
  ports: readonly number[] = DEFAULT_METADATA_PORTS,
): OAuthRegistration {
  const dynamic =
    agents.dynamic === "off"
      ? ("off" as const)
      : agents.dynamic === "open"
        ? ("open" as const)
        : {
            redirectUris: unique([
              ...MCP_CLIENT_REDIRECT_URIS,
              ...agents.redirectUris.filter(
                (uri) => redirectUriProblem(uri) === null,
              ),
            ]),
          };
  return {
    dynamic,
    metadataDocuments: agents.metadataDocuments
      ? {
          allowHosts: unique([
            ...MCP_METADATA_DOCUMENT_HOSTS,
            ...agents.allowHosts,
          ]),
          // The document's URL names the port the server connects to, and an
          // anonymous caller chose it (janus-oauth 0.26): the HTTPS port only.
          allowPorts: [...ports],
          ...transport,
        }
      : false,
  };
}
