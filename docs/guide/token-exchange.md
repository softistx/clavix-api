# Token exchange (RFC 8693)

A service or an agent holds a user's access token and needs a token for another API, acting for that user. It
exchanges the one for the other at `/token`. Served on every tenant host, for confidential clients only.

## Register the client and give it rules

```sh
bun run clients:create --tenant acme --name "Agent" --confidential --grants urn:ietf:params:oauth:grant-type:token-exchange
```

From the console: `createClient(input: { name, type: CONFIDENTIAL, grantTypes: [TOKEN_EXCHANGE] })`, then

```graphql
mutation ($tenantId: ID!) {
  setClientTokenExchange(
    tenantId: $tenantId
    id: "agent"
    input: {
      targetResources: ["https://api.acme.example"]
      subjectClients: ["web-app"]
    }
  ) {
    tokenExchange {
      targetResources
      subjectClients
      anySubjectClient
      subjectAgents
      mode
    }
  }
}
```

- `targetResources`: at most 20, each a resource of the tenant. `subjectClients`: at most 50 client ids, or
  `anySubjectClient: true` (not both), and `subjectAgents: true` to cover the tokens of every agent of the tenant (see
  "Agents' tokens" below). The call replaces the previous rules and is audited as `client.tokenExchange.set`.
- A public client is refused; the client need not list the grant to receive rules, but it cannot exchange without it.
- Deleting the client deletes its rules.

## Agents' tokens

An MCP server that is a confidential client can trade the token of a user's agent (an MCP client that registered
itself, see `docs/guide/mcp.md`) for a token on a downstream API. Set `subjectAgents: true` on the server's rules:

```graphql
mutation {
  setClientTokenExchange(
    tenantId: "..."
    id: "mcp-server"
    input: {
      targetResources: ["https://api.acme.example"]
      subjectAgents: true
    }
  ) {
    tokenExchange {
      subjectAgents
    }
  }
}
```

- The switch covers any client of the tenant recorded as an agent, and only those: a regular client's token stays
  `access_denied` unless it is in `subjectClients` (or `anySubjectClient` is on). Agents registered after the call
  are covered too, and an agent deleted stops being covered.
- Delegation only: the user stays the subject and `act` names the MCP server. Scopes only narrow, and the
  authorization details of the agent's token on the same resource are inherited.
- `subjectAgents` defaults to `false`; with it on, `subjectClients` may stay empty.

## Exchange

```sh
curl -s https://acme.clavix.example/token -u agent:SECRET \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token=USER_ACCESS_TOKEN \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d resource=https://api.acme.example -d scope=read
```

The answer is an access token for `resource`. Scopes only narrow the subject's. It carries `act`
(`{ "sub": "agent", "client_id": "agent" }`), shows it in introspection, has no refresh token, and dies with the
subject's grant (revoked grant, deleted subject client). The mode is always delegation.

| Answer                | Meaning                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized_client` | the client does not list the grant, or is public                                                                              |
| `access_denied`       | no rules, `resource` not in `targetResources`, or the subject's client neither listed nor an agent covered by `subjectAgents` |
| `invalid_grant`       | the subject token is unknown, expired, revoked or another tenant's                                                            |

## DPoP

The proof of the exchange request binds the new token to its key: the answer has `token_type: DPoP`. A DPoP-bound
subject token needs a proof of its own key, else `invalid_grant`, so a service cannot exchange a token bound to
another party's key. An exchanging client with `dpopBoundAccessTokens`, or a tenant that requires DPoP, must send a
proof with the request.

## Defaults

- No rules means `access_denied`: a client with the grant but no `setClientTokenExchange` exchanges nothing.
- `subjectClients` defaults to `[]`, `anySubjectClient` and `subjectAgents` to `false`. The call needs the clients
  listed, `subjectAgents: true` or `anySubjectClient: true` (never `anySubjectClient` with a list).
- An exchanged token cannot be exchanged again (`invalid_grant`): the service exchanges the user's original token
  each time.
