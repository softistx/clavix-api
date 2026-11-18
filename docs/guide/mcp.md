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
The console does not expose the policy yet (a later slice). Until then an operator sets it on the tenant document, for example in `mongosh`: `db.tenants.updateOne({ slug: "acme" }, { $set: { "oauth.agents.dynamic": "restricted" }, $inc: { version: 1 } })` (the `version` bump lets the API rebuild the tenant's server once its cached entry expires).

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

## Refusals

| Answer                                        | Cause                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 400 `invalid_request`                         | The tenant's policy is off                                                                                |
| 400 `invalid_redirect_uri`                    | The callback is not accepted in `restricted` mode                                                         |
| 400 `invalid_client_metadata`                 | A grant the tenant does not offer to agents: the device URN and the token exchange URN are always refused |
| 403 `access_denied`                           | The `agents` quota is reached (free 100, pro 1000, enterprise unlimited; a per-tenant override applies)   |
| 403                                           | The tenant is suspended                                                                                   |
| 429 `temporarily_unavailable` + `Retry-After` | The registration throttle ([operations](../operations.md#agent-registration-throttle))                    |

## Counting

Every registered client and every metadata-document client that reached `/authorize` is an agent of the tenant
(`agentClients`). Agents are not counted in the `clients` quota or meter; they have the `agents` quota and meter
(console `usage`). A metadata-document client is recorded the first time it is used. A tenant at its quota refuses a
new document client on `/authorize` and `/par` with 403 `access_denied` before the document is fetched (a client
already recorded keeps working).

The quota is checked before a registration or a first use and is best effort under concurrent calls (the throttle bounds the
overshoot). Deleting a client in the console also removes its agent record, which frees the quota.
