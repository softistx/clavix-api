# MCP clients and agents

An MCP client (Claude, an IDE, a script) finds a tenant's authorization server from a 401, registers itself, then runs
the authorization-code flow with PKCE. A tenant opts in; by default nobody can register.

## Turning it on

The tenant's OAuth policy carries `agents`:

| Field               | Meaning                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dynamic`           | `off` (default): `/register` answers 400 `invalid_request`. `restricted`: RFC 7591 registration, but only for the MCP clients' known callbacks and loopback addresses, plus `redirectUris`. `open`: any valid redirect URI. |
| `redirectUris`      | Extra callbacks accepted in `restricted` mode. A URI the OAuth rules refuse is ignored.                                                                                                                                     |
| `metadataDocuments` | Accept a Client ID Metadata Document URL as a `client_id`.                                                                                                                                                                  |
| `allowHosts`        | Hosts a document may be fetched from, besides the MCP clients' own. Exact names or `*.example.com`.                                                                                                                         |

Prefer `restricted`: `open` lets anyone register a client with any callback, and the consent screen is the only gate.
The console edits it: `oauthPolicy(tenantId) { agents { dynamic redirectUris metadataDocuments allowHosts } agentsNeedPushOrProof }`
and `updateOAuthPolicy(tenantId, input: { agents: { ... } })` (`edit` on the tenant; a field left out keeps its value;
`dynamic` is `OFF`, `RESTRICTED` or `OPEN`). The service lower-cases and de-duplicates `allowHosts` (DNS names or
`*.example.com`, 50 at most), refuses a `redirectUris` entry the OAuth rules refuse (50 at most) with `BAD_USER_INPUT`,
and stores nothing then. Each change is the admin event `oauthPolicy.update` and bumps the tenant's `version`.

**The warning.** `agentsNeedPushOrProof` is `true` when agents are on (`dynamic` not `OFF`, or `metadataDocuments`) while
`par.required` or `dpop.required` holds for the whole tenant. Those two switches have no per-client exemption, so an MCP
client that does not push its requests or prove its tokens is refused. The console should show the warning; saving is
allowed.

## The flow

1. The resource server answers 401 with `WWW-Authenticate: Bearer resource_metadata="..."`.
2. The client reads the metadata, finds the issuer, and reads `/.well-known/oauth-authorization-server`, which now
   lists `registration_endpoint` (and `client_id_metadata_document_supported` when documents are on).
3. It registers:

```sh
curl -s https://acme.clavix.example/register -H 'content-type: application/json' -d '{
  "client_name": "My agent",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "token_endpoint_auth_method": "none"
}'
# 201 { "client_id": "...", "client_name": "My agent", ... }
```

4. It runs `/authorize` with `code_challenge` (S256) and the `resource`, the user approves, and `/token` exchanges the
   code. The token is bound to the resource.

An MCP server that calls downstream APIs for the user trades the agent's token for one on the API: give the
server (a confidential client) token exchange rules with `subjectAgents: true`, see
[Agents' tokens](token-exchange.md#agents-tokens).

## Refusals

| Answer                                                | Cause                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 400 `invalid_request`                                 | The tenant's policy is off                                                                                |
| 400 `invalid_redirect_uri`                            | The callback is not accepted in `restricted` mode                                                         |
| 400 `invalid_client_metadata`                         | A grant the tenant does not offer to agents: the device URN and the token exchange URN are always refused |
| 403 `access_denied`                                   | The `agents` quota is reached (free 100, pro 1000, enterprise unlimited; a per-tenant override applies)   |
| 403                                                   | The tenant is suspended                                                                                   |
| 429 `temporarily_unavailable` + `Retry-After`         | The registration throttle ([operations](../operations.md#agent-registration-throttle))                    |
| 429 `temporarily_unavailable` on `/authorize`, `/par` | Too many metadata-document fetches ([operations](../operations.md#agent-registration-throttle))           |

## Counting

Every registered client and every metadata-document client that reached `/authorize` is an agent of the tenant
(`agentClients`). Agents are not counted in the `clients` quota or meter; they have the `agents` quota and meter
(console `usage`). A metadata-document client is recorded the first time it is used. A tenant at its quota refuses a
new document client on `/authorize` and `/par` with 403 `access_denied` before the document is fetched (a client
already recorded keeps working).

The quota is checked before a registration or a first use and is best effort under concurrent calls (the throttle bounds the
overshoot). Deleting a client in the console also removes its agent record, which frees the quota.

## Managing agents in the console

`clients(tenantId, kind: [...])` lists the tenant's clients; `Client.registration` is `CONSOLE` (made in the console or
by the CLI), `DYNAMIC` (registered at `/register`) or `METADATA` (a Client ID Metadata Document). `kind` is a list
filter: `kind: [DYNAMIC, METADATA]` is the Agents list, `kind: [CONSOLE]` the others, no `kind` lists all. `totalCount`
follows the `kind` and `q` filters, whatever the cursor. A metadata-document client is read-only in the console (it is
described by its document): `client(id)` reads it, an update or a rotation answers `NOT_FOUND`.

`deleteClient` works for every kind. It removes the client, closes its grants and tokens, and removes the agent record
(the quota is freed). A metadata-document client deleted this way is read and recorded again the next time it is used.

## The document an MCP server serves (RFC 9728)

An MCP server (or any API that accepts the tokens) tells clients where to sign in with an OAuth protected resource
metadata document (RFC 9728). It is served by the resource server itself, on its own origin (RFC 9728 section 3.3), so
Clavix hosts no copy: the console builds it and shows it, ready to be served.

`Resource.metadataUrl` is where it must be served (`/.well-known/oauth-protected-resource` plus the resource URI's path, on
the URI's origin), and `Resource.protectedResourceMetadata` is the JSON text, built with `protectedResource()` from
`@softistx/janus-oauth`, so it is what janus's handler answers:

```graphql
query {
  resource(tenantId: "...", id: "...") {
    metadataUrl
    protectedResourceMetadata
  }
}
```

```json
{
  "resource": "https://api.example.com/mcp",
  "authorization_servers": ["https://acme.clavix.example"],
  "scopes_supported": ["read", "write"]
}
```

- The issuer is the tenant's (its primary custom host when it has one), the scopes are the resource's own (standard
  OpenID Connect scopes are not listed).
- When the tenant requires DPoP (`oauthPolicy.dpop.required`), the document adds `dpop_signing_alg_values_supported`
  (`ES256`, `EdDSA`) and `dpop_bound_access_tokens_required: true`. When it does not, DPoP is not announced.
- The document is computed on each read, so a scope or a policy change shows at once. The authorization detail types
  (RFC 9396) are not in it yet.

To serve it, the resource server uses the same call: `protectedResource({ resource, issuer, scopes }).metadata`, and its
401 answers `challenge()`.

## The daily clean-up

An agent that registered itself and was never authorized is useless but still counts against the `agents` quota. Once a
day (03:41 UTC, queue `agents-prune`, [operations](../operations.md#agents-clean-up)) every `DYNAMIC` agent registered more
than 7 days ago that has no standing grant (a grant not revoked) is deleted like `deleteClient` does it, with its tokens
closed, and recorded as the admin event `agent.prune` by the actor `system:agents:prune` (one per agent, identifiers
only). Agents of a metadata document are not pruned (they are recorded again when used), and only active tenants are
visited. A consent granted between the check and the deletion is revoked with the agent (a very small window).
