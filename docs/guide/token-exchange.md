# Token exchange (RFC 8693)

A service or an agent holds a user's access token and needs a token for another API, acting for that user. It
exchanges the one for the other at `/token`. Served on every tenant host, for confidential clients only.

## Register the client and give it rules

```sh
bun run clients:create --tenant acme --name "Agent" --confidential --grants urn:ietf:params:oauth:grant-type:token-exchange
```

From the console: `createClient(input: { name, type: CONFIDENTIAL, grantTypes: [TOKEN_EXCHANGE] })`, then

```graphql
mutation {
  setClientTokenExchange(
    tenantId: "acme"
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
      mode
    }
  }
}
```

- `targetResources`: at most 20, each a resource of the tenant. `subjectClients`: at most 50 client ids, or
  `anySubjectClient: true` (not both). The call replaces the previous rules and is audited as `client.tokenExchange.set`.
- A public client is refused; the client need not list the grant to receive rules, but it cannot exchange without it.
- Deleting the client deletes its rules.

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

| Answer                | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `unauthorized_client` | the client does not list the grant, or is public                                  |
| `access_denied`       | no rules, `resource` not in `targetResources`, or the subject's client not listed |
| `invalid_grant`       | the subject token is unknown, expired, revoked or another tenant's                |
