# Client credentials grant

For a back end that calls an API as itself, with no user: a worker, a cron job, a service. RFC 6749 section 4.4,
served on the tenant's `/token`. The token's `sub` is the client id; it carries no refresh token, no `id_token`
and no `roles` claim.

The grant is opt-in at three levels, and all three are needed:
1. **the resource** opts in (`allowClientCredentials`, off by default). A tenant whose resources have not opted in
   answers `unsupported_grant_type`;
2. **the client** is confidential (`client_secret_basic`) and lists the grant;
3. **the client** has `allowedScopes`, the ceiling of what it may ask for, and optionally `defaultScopes`, what
   it gets when it asks for none.

## Opt a resource in

From the console, on the resource's edit section (or the API):

```graphql
mutation {
  updateResource(
    tenantId: "..."
    id: "..."
    input: { allowClientCredentials: true }
  ) {
    id
    allowClientCredentials
  }
}
```

Opting a resource in is done through the console or the `updateResource` mutation only: the `resources:create` CLI has no flag for it.

`name` is optional in `UpdateResourceInput`; an omitted field is kept. The console's own resource on the platform
tenant cannot be opted in (`BAD_USER_INPUT`). Turning it off again stops new tokens at once; tokens already issued
live until they expire.

## Register a machine client

```sh
bun run clients:create --tenant acme --name "Billing worker" --confidential \
  --grants client_credentials --allowed-scopes read,write --default-scopes read
```

From the console: `createClient(input: { name, type: CONFIDENTIAL, grantTypes: [CLIENT_CREDENTIALS],
allowedScopes: ["read", "write"], defaultScopes: ["read"] })`; `redirectUris` may be empty. The secret is shown
once. Refused at registration: a public client with the grant, a client with the grant and no allowed scope, a
default scope outside the allowed ones, and scopes on a client without the grant. `/register` and metadata
documents never offer the grant.

## Ask for a token

```sh
curl -s https://acme.clavix.example/token \
  -u "billing-worker:$SECRET" \
  -d grant_type=client_credentials \
  -d resource=https://api.acme.example/v1 \
  -d scope="read"
# { "access_token": "...", "token_type": "Bearer", "expires_in": 900, "scope": "read" }
```

`resource` is required: a request without it falls back to the tenant's default resource (userinfo), which never
opts in, so it is `invalid_target`. A scope outside `allowedScopes` is `invalid_scope`; with no `scope` the client
gets `defaultScopes`.

| Answer                   | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `unsupported_grant_type` | no resource of the tenant has opted in                           |
| `unauthorized_client`    | the client does not list the grant                               |
| `invalid_client` (401)   | wrong secret, or a public client                                 |
| `invalid_target`         | the resource is unknown, not opted in, or missing                |
| `invalid_scope`          | a scope outside `allowedScopes` (or not defined on the resource) |

## What a token reaches

A client token is a machine token. `userinfo` answers 401 `invalid_token`, and Clavix's own console never accepts
it (its authenticator reads user tokens only). Your API verifies it like any access token and tells it from a
user's by the `sub` (the client id) and the absence of `roles`; with janus, `subjectType` is `"client"`.

## Cutting a client off

Revoking a token does not stop the client from asking for another. To cut it off, delete the client, remove the
grant (`updateClient`) or rotate its secret (`clients:create --rotate-secret`).
