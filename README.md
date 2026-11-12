# clavix-api

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider. The
spec is in `../spec/`; the plan is `docs/roadmap.md`. Rules for contributors:
[AGENTS.md](AGENTS.md). Moving an application from embedded janus to Clavix:
[docs/guide/migrating-from-embedded-janus.md](docs/guide/migrating-from-embedded-janus.md).

Today it serves `GET /healthz`, `health { status version }` and the e-mail code sign-in of the hosted pages (below) on `POST /graphql`.

## Run

```sh
export GITHUB_TOKEN=$(gh auth token)   # read:packages, for the @softistx packages
bun install
cp .env.example .env
bun run generate   # GraphQL types, gitignored; also run by build and verify
bun dev            # http://localhost:3000/graphql and /healthz
```

## Scripts

| Script                    | Does                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `generate`                | scalar/validation SDL, then GraphQL codegen                              |
| `dev`, `build`, `start`   | watch server; bundle into `dist/`; run the bundle                        |
| `test`                    | `bun test`                                                               |
| `typecheck`               | `bun check`                                                              |
| `lint`, `fix`, `check:ci` | Biome                                                                    |
| `db:sync`, `db:migrate`   | collections and indexes; pending migrations (deployment steps)           |
| `tenants:create`          | create a tenant (see "Tenants")                                          |
| `clients:create`          | register or update an OAuth client on a tenant (see "OAuth clients")     |
| `verify`                  | `generate`, `check:ci`, `typecheck`, `test` (what CI runs, plus `build`) |

## Environment

`.env.example` lists the variables; a malformed one stops the app at start, naming it.

| Variable                                                               | Default / rule                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                                 | 3000                                                                                                         |
| `MONGO_URI`                                                            | required; a replica set (transactions)                                                                       |
| `REDIS_URL`                                                            | required in production; unset elsewhere, the tenant cache is off                                             |
| `CLAVIX_DOMAIN`                                                        | required in production; `clavix.localhost` elsewhere                                                         |
| `CLAVIX_PUBLIC_SCHEME`                                                 | `https`; `http` is refused in production                                                                     |
| `CLAVIX_PUBLIC_PORT`                                                   | optional; set when issuers are not on the scheme's own port                                                  |
| `CLAVIX_SMTP_URL`                                                      | `smtp://` or `smtps://` URL of the mail relay; required in production; unset elsewhere, mails stay in memory |
| `CLAVIX_KEYS_MASTER_KEY`                                               | required in production (32 bytes, base64); a public development default elsewhere                            |
| `CLAVIX_CODE_IP_LIMIT` / `CLAVIX_CODE_IP_WINDOW_SECONDS`               | sign-in code requests per client address and tenant: 20 per 600 s                                            |
| `CLAVIX_CODE_TENANT_LIMIT` / `CLAVIX_CODE_TENANT_WINDOW_SECONDS`       | sign-in code requests per tenant: 200 per 3600 s                                                             |
| `CLAVIX_PASSKEY_IP_LIMIT` / `CLAVIX_PASSKEY_IP_WINDOW_SECONDS`         | `passkeySignInOptions` requests per client address and tenant: 60 per 600 s                                  |
| `CLAVIX_PASSKEY_TENANT_LIMIT` / `CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS` | `passkeySignInOptions` requests per tenant: 600 per 3600 s                                                   |
| `CLAVIX_TRUSTED_PROXIES`                                               | reverse proxies in front of the app, default 0 (see "Sign-in code limits")                                   |

## Sign-in code limits

`requestSignInCode` is limited three ways; going over any of them is `MAIL_THROTTLED` (HTTP 429,
`Retry-After` in seconds), the same answer in all three cases:

| Limit                             | Default       | Variables                                                       |
| --------------------------------- | ------------- | --------------------------------------------------------------- |
| per address (the e-mail), janus's | 5 per 10 min  | not configurable                                                |
| per client IP, per tenant         | 20 per 10 min | `CLAVIX_CODE_IP_LIMIT`, `CLAVIX_CODE_IP_WINDOW_SECONDS`         |
| per tenant, all clients           | 200 per hour  | `CLAVIX_CODE_TENANT_LIMIT`, `CLAVIX_CODE_TENANT_WINDOW_SECONDS` |

They stop anyone sending codes to many addresses through the shared no-reply sender (#59). The `CLAVIX_CODE_*` values are whole numbers of at least 1;
`CLAVIX_TRUSTED_PROXIES` a whole number of at least 0.
- They use `@softistx/redis` rate limits (GCRA: the bucket starts full and refills evenly over the
  window), under the `clavix` prefix: `clavix:signin-ip:<tenantId>/<ip>`, `clavix:signin-tenant:<tenantId>`.
  Keys carry the tenant id, so a tenant's traffic never spends another's budget, and one address has
  one bucket per tenant. The IP is counted first: a refused address does not spend the tenant's budget.
- **The anonymous `passkeySignInOptions` follows the same rules** with its own buckets and variables (see "Passkey sign-in and registration").
- **They need `REDIS_URL`** (required in production). Without it (development) only janus's per-address
  limit applies. If Redis is down or slow (250 ms), the request is let through and a warning is logged;
  janus's per-address limit still holds.
- **Client IP and the trusted-proxy assumption.** The IP is `ctx.ip`. By default it is the connection's
  address, which behind a reverse proxy is the proxy: set `CLAVIX_TRUSTED_PROXIES` to the number of
  proxies in front of the app (`1` for one load balancer). The client is then the entry that many
  places from the right of `X-Forwarded-For` (what the proxies appended; what the client wrote left of
  them is never read). Only set it when every request reaches the app through those proxies, or a
  client could pick its own address. A request with no known address shares one `unknown` bucket.

## Signing keys

Each tenant has its own signing keys (ADR-0010), kept in the `oauthSigningKeys` collection by
`@softistx/janus-oauth-mongo`: the private JWK is encrypted with `CLAVIX_KEYS_MASTER_KEY`
(AES-256-GCM) and the store of a tenant, partitioned by its id, cannot read another's. Janus signs;
Clavix adds no `jose`.
- `signingKeysFor(tenantId)` and `jwksFor(tenantId)` (`src/config/keys.ts`; `tenantId` is the
  tenant's id in hex, `partitionOf`) give the OAuth endpoints the `SigningKeyStore` and the public JWKS.
- A tenant gets its first key when it is created (`TenantsService.create`). If that call fails it is
  logged and the tenant stands; the hourly job creates the key within the hour.
- Any deployment that holds real tenants (staging included) must set `CLAVIX_KEYS_MASTER_KEY`: the
  default is public. A tenant with no key yet has an empty JWKS: the OAuth endpoints treat it as transient.
- `CLAVIX_KEYS_MASTER_KEY` is generated with `openssl rand -base64 32`.
- Rotation: ES256 keys sign for 90 days; the next key is published 48 h before it takes over and
  a retired key stays published 24 h (`src/keys/policy.ts`). An hourly `key-rotation` job on
  `@softistx/redis` (cron `0 * * * *`) runs the step over every active tenant, and the server runs
  one pass at start, which also gives the seeded `clavix` tenant its key. Without `REDIS_URL`
  (development) only the pass at start runs.
- **Losing the master key** makes the stored keys unreadable (signing fails; the JWKS still
  serves, and each hourly pass logs a failure per tenant). Keep it in a secret manager, apart from
  the database. To recover, drop the tenants' `oauthSigningKeys` documents and let the rotation
  create new keys: tokens signed by the lost keys stop verifying once the JWKS no longer lists
  them. Changing the master key is the same; there is no re-encryption in place.
- `bun run db:sync` creates the collection's indexes (one `current` and one `next` key per tenant).

## Tenants

Until the console exists (M2), a tenant is created by script, through the same `TenantsService` the
platform uses (slug rules, reserved slugs, the tenant's first signing key). The script prints the
tenant as JSON, with its issuer, `https://<slug>.<CLAVIX_DOMAIN>`.

```sh
bun run tenants:create --slug acme --name "Acme"
bun run tenants:create --slug acme --name "Acme" --sign-up   # open sign-up for unknown e-mails
```

| Flag        | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `--slug`    | required; 2 to 63 characters, lowercase letters, digits and inner hyphens; never changes |
| `--name`    | required; the display name                                                               |
| `--sign-up` | open sign-up; default is closed (invitation only)                                        |
- **Idempotent**: re-running with the same values creates nothing (`created: false`). An existing
  slug with another name, or a `--sign-up` that differs from its setting, is refused, not edited.
  Bad input exits 1 with the usage; `--help` prints it.
- **Refused**: an invalid or reserved slug (`console`, `www`, `api`, ...) and the slug of a deleted
  tenant, which stays reserved for good.
- The first signing key is made at creation; if that fails (logged), the hourly rotation job makes it.
- Then register its clients with `clients:create`.

## OAuth clients

Until the console exists (M2), a client is registered on a tenant by script. Clients are per tenant:
they live in the tenant's partition of the janus collections, so a client of `acme` is unknown to
`globex` (its `/authorize` answers `invalid_client`).

```sh
bun run clients:create --tenant acme --name "Back office" \
  --redirect-uri https://office.example.com/callback --confidential
bun run clients:create --tenant acme --name "Web app" \
  --redirect-uri https://app.example.com/callback          # a public client, PKCE only
```

| Flag                   | Meaning                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `--tenant <slug>`      | required; an unknown slug or a suspended tenant is refused                                     |
| `--name <name>`        | required                                                                                       |
| `--redirect-uri <uri>` | required, repeatable; exact match, janus's rules (HTTPS, no fragment, loopback `http` allowed) |
| `--confidential`       | `client_secret_basic`; default is a public client (`none`, PKCE `S256`)                        |
| `--client-id <id>`     | the client's id in the tenant (`a-z0-9-`); default: the name as `a-z0-9-`                      |
| `--grants <a,b>`       | `authorization_code,refresh_token` (the default and all there is: see below)                   |
| `--rotate-secret`      | a new secret for an existing confidential client                                               |
- **Idempotent on the client id**: a re-run replaces the name and the redirect URIs of the client
  and creates nothing new. The output (JSON) says `created: true | false`.
- **A confidential client's secret is printed once**, in `clientSecret`; janus keeps only its
  SHA-256. A re-run prints `clientSecret: null` and keeps the secret; `--rotate-secret` mints another.
- **A client keeps its type**: re-running a confidential client without `--confidential` is
  refused (the secret is never dropped silently); a public client re-run with `--confidential`
  becomes confidential and gets a secret.
- The output also carries `issuer`, `tenant`, `redirectUris` and `type`. `--help` prints the
  usage; bad input prints the message and the usage and exits 1.
- **Grants**: janus-oauth 0.8 has no per-client grant list; every client may use the authorization
  code and refresh grants. `--grants` refuses any other (device code, token exchange, client
  credentials) until janus offers them per client.

## OpenID Connect

Each tenant host is its own OpenID Provider (ADR-0003), served by `@softistx/janus-oidc`:

| Path                                | What                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `/.well-known/openid-configuration` | discovery: the issuer, endpoints, `jwks_uri`, supported scopes and algorithms  |
| `/jwks.json`                        | the tenant's public signing keys (verifies access tokens and id_tokens)        |
| `/userinfo`                         | `sub` and the claims the token's scopes release (`profile`, `email`, ...)      |
| `/introspect`                       | RFC 7662, for a confidential client of the same tenant (`client_secret_basic`) |

A client that asks for `openid` gets an `id_token` (`iss`, `sub`, `aud`, `exp`, `iat`,
`auth_time`, `nonce`, `at_hash`) signed with the tenant's current key. A request with no
`resource` is for the tenant's userinfo. Introspection answers only for tokens of the tenant's
own resources. A tenant with no signing key yet answers 503 `temporarily_unavailable`. The
claims come from the users of the tenant (see "Users per tenant").

## Users per tenant

Each tenant has its own user pool (ADR-0008): one `@softistx/janus` instance per tenant
(`createJanusIssuers`, `src/users`), built on its first request and rebuilt when the tenant's
`version` moves, over its partition of the janus user stores (`partitioned*` collections,
partition = the tenant's id in hex; `bun run db:sync` creates them). The same e-mail is two users in
two tenants, and a user id, a session or a token of one tenant is unknown to another. An unknown
or suspended host has no instance.
- **Session cookie**: `__Host-clavix-session`, host-only (no `Domain`), `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`: a browser never sends one tenant's session to another host.
- **Lifetime**: 14 days, sliding (renewed once a day), and never more than 30 days after sign-in
  (`session.absolute`): past it the session is anonymous however recently it was used.
- **Passkey relying party** (assumed, not answered): the tenant's own host. `rpIdOf(tenant)` is
  `<slug>.<CLAVIX_DOMAIN>` and `originOf(tenant)` its origin (`src/users/rp.ts`).
- `authFor` and `claimsFor` (`src/config/users.ts`) are the OAuth issuers' ports, wired in
  `src/server.ts`. Consent and passkeys are below, and no `/authorize`
  succeeds before a tenant has a resource (M2). `__Host-` cookies need https (Chrome accepts `localhost`).

## Consent (the hosted page's API)

`/authorize` redirects a user to `/consent?request_id=<id>` on the tenant's host: a page of clavix-ui,
which calls `POST /graphql` (the same API as the e-mail code sign-in) with the tenant's session cookie
(`__Host-clavix-session`, same host: send the request with credentials). Served by
`src/modules/consent` (janus-oauth's `oauthResolvers`; the OAuth server and the signed-in user are both
the request host's tenant's, so a request id or a session of another tenant is `NOT_FOUND` /
`UNAUTHENTICATED`).

```graphql
query Consent($id: ID!) {
  oauthRequest(id: $id) {
    id
    client {
      id
      name
      url
      host
    } # show id and host, not only the self-declared name
    redirectHost # and the host the user is sent back to
    resource
    redirectUri
    expiresAt
    scopes {
      name
      label
    }
  }
  connectedApps {
    id
    client {
      id
      name
    }
    scopes {
      label
    }
    createdAt
  }
}
mutation Allow($id: ID!, $scopes: [String!]) {
  # scopes: a subset, omit for all
  approveOAuthRequest(id: $id, scopes: $scopes) {
    redirectTo
    grantId
  }
}
mutation Refuse($id: ID!) {
  denyOAuthRequest(id: $id) {
    redirectTo
  } # redirectTo carries error=access_denied
}
mutation Revoke($id: ID!) {
  revokeConnectedApp(id: $id)
}
```

The page sends the user agent to `redirectTo` (the client's redirect URI with `code` or the error,
`state` and `iss`). Errors carry `extensions.code`: `UNAUTHENTICATED` (401: sign in with the e-mail
code, then come back to `/consent`), `NOT_FOUND` (404: unknown, decided, lapsed or another tenant's
request, a host with no tenant, or a consent request that is not same-origin JSON, see "Same origin on /graphql"), `BAD_USER_INPUT` (a
scope not asked for), `STEP_UP_REQUIRED` (403).
- **Freshness**: `approveOAuthRequest` needs a session that proved who it is in the last 5 minutes
  (janus-oauth's default `freshWithin`). An older one is `STEP_UP_REQUIRED`: the page signs the user in
  again with a new e-mail code (`requestSignInCode`, `verifySignInCode`), then repeats the mutation;
  the request stays pending. `denyOAuthRequest` and the read do not ask. janus's `auth.stepUp.*`
  mutations are not exposed.
- **Same origin, JSON only**: this holds for every `/graphql` operation, not only consent (see "Same
  origin on /graphql" below).
- **`auth_time`** of the id_token is the session's sign-in time (`authenticatedAt`). **No `amr` or
  `acr`**: janus-oauth's resolvers pass none (`approve` takes them, the GraphQL surface does not), and
  M1 needs neither.

## E-mail code sign-in

The hosted pages call the GraphQL API on the tenant's own host (`https://<slug>.<CLAVIX_DOMAIN>/graphql`):

```graphql
mutation {
  requestSignInCode(email: "ada@example.com") {
    challenge
    expiresAt
  }
}
mutation {
  verifySignInCode(challenge: "...", code: "123456") {
    user {
      id
      email
    }
    expiresAt
  }
}
query {
  currentUser {
    id
    email
    name
    emailVerified
  }
}
mutation {
  signOut
}
```

A 6-digit code is mailed from `no-reply@<CLAVIX_DOMAIN>` (valid 10 minutes, 5 attempts, 5 mails per
address per 10 minutes). `verifySignInCode` sets the `__Host-clavix-session` cookie; a wrong, spent
or foreign code is always `CODE_INVALID` (401). A tenant with `signUp: false` (the default, and
`clavix`) answers an unknown address exactly like a known one and creates and sends nothing: users
come in by invitation. `requestSignInCode.expiresAt` is the challenge's expiry, `verifySignInCode.expiresAt` the session's. The hosted pages (a BFF) keep the challenge and send it back with the code. `signOut` clears the cookie. An unknown host is `NOT_FOUND`; `MAIL_THROTTLED` is HTTP 429. Without `CLAVIX_SMTP_URL` (development, tests) mails are kept in memory.

## Passkey sign-in and registration

Passwordless sign-in with a passkey, on the same `/graphql` of the tenant's host (every operation
below goes through the same-origin guard). janus passkeys are the **first factor** here
(`passkeys.firstFactor`, `@softistx/janus-passkeys` 0.2): no password and no TOTP. The relying party
is the tenant's own host (`rpIdOf`) and the only origin `originOf`, so a passkey belongs to one
tenant for good, and is unknown to every other one. WebAuthn options and responses travel as
**JSON text** (`String`); in the browser, parse the options with
`PublicKeyCredential.parseRequestOptionsFromJSON` / `parseCreationOptionsFromJSON` and send
`JSON.stringify(credential.toJSON())`.

```graphql
type PasskeySignInChallenge {
  options: String!
  challenge: String!
  expiresAt: DateTime!
}
type PasskeyRegistration {
  options: String!
  challenge: String!
  expiresAt: DateTime!
}
type Passkey {
  id: ID!
  name: String!
  transports: [String!]!
  backupEligible: Boolean!
  backedUp: Boolean!
  createdAt: DateTime!
  lastUsedAt: DateTime
}
extend type Query {
  myPasskeys: [Passkey!]!
}
extend type Mutation {
  passkeySignInOptions: PasskeySignInChallenge!
  signInWithPasskey(challenge: String!, response: String!): SignedIn! # sets the cookie
  passkeyRegistrationOptions: PasskeyRegistration!
  registerPasskey(
    challenge: String!
    response: String!
    name: String!
  ): Passkey!
  removePasskey(id: ID!): Boolean!
}
```

- **Sign in** (anonymous): `passkeySignInOptions`, `navigator.credentials.get({ publicKey })`
  (discoverable credential, so no e-mail is asked), then `signInWithPasskey`. The session cookie
  is set as after `verifySignInCode`, and the response is `Cache-Control: no-store`. The challenge
  lasts 5 minutes and is **spent by the first try**, right or wrong: ask for new options. Keep it
  in the hosted page's server session, not in a URL.
- **Register** (signed in, e-mail verified): `passkeyRegistrationOptions`,
  `navigator.credentials.create({ publicKey })`, then `registerPasskey` with a name of 1 to 100
  characters. The registration challenge lasts 5 minutes too, and a new `passkeyRegistrationOptions`
  spends the user's earlier one. Signing in with an e-mailed code verifies the e-mail; a user whose e-mail is not yet
  verified gets `EMAIL_UNVERIFIED` (403). The session must have signed in within 10 minutes
  (`STEP_UP_REQUIRED`, 403: sign in again with a code). Up to 10 passkeys per user.
- **List and remove**: `myPasskeys` (never the public key or the counter), `removePasskey(id)`
  (`true` when this call removed it, `false` for an id that is not the caller's; same freshness).
  A removed passkey no longer signs in. Registering and removing mail nothing yet.
- **Errors**: `PASSKEY_THROTTLED` (429, `Retry-After`) when `passkeySignInOptions` is over its rate limit
  (below); `PASSKEY_INVALID` (401) for every refusal of `signInWithPasskey`: unknown credential,
  another tenant's passkey, wrong rpId or origin, a user not verified on the device, a wrong user
  handle, an unknown, spent or expired challenge, a malformed response, an inactive user. One
  code and one message: it does not say whether the credential or the user exists. At
  registration, janus's own codes pass through: `PASSKEY_INVALID` (400, the response did not
  verify, the challenge is spent), `PASSKEY_TAKEN` (409), `PASSKEY_LIMIT` (409),
  `EMAIL_UNVERIFIED` (403), `STEP_UP_REQUIRED` (403), `TOKEN_*` for a bad challenge.
  `UNAUTHENTICATED` (401) when the operation needs a session and has none.
- **Over http** (development): janus refuses `http` origins, so every passkey operation answers
  `NOT_FOUND`; test passkeys over https.
- **Rate limit**: `passkeySignInOptions` is anonymous and stores a token per call, so it is limited
  like `requestSignInCode`, with its own buckets and variables: per client IP and tenant
  (60 per 10 min, `CLAVIX_PASSKEY_IP_LIMIT`, `CLAVIX_PASSKEY_IP_WINDOW_SECONDS`) and per tenant
  (600 per hour, `CLAVIX_PASSKEY_TENANT_LIMIT`, `CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS`), whole numbers
  of at least 1. Going over either is `PASSKEY_THROTTLED` (HTTP 429, `Retry-After` in seconds). The
  rules of "Sign-in code limits" apply: `@softistx/redis` GCRA limits keyed by tenant id
  (`clavix:passkey-ip:<tenantId>/<ip>`, `clavix:passkey-tenant:<tenantId>`), the address counted
  first, `CLAVIX_TRUSTED_PROXIES` for the client IP, and no limit without `REDIS_URL`; Redis down or
  slow: the request goes through and a warning is logged.
- **Not yet**: the `amr`/`acr` claims stay unset.

## Same origin on /graphql

The cookie is the credential and a sibling tenant host is same-site (`SameSite=Lax` does not stop it),
so one Yoga plugin (`useSameOriginJson`, `src/http/same-origin.ts`) guards every `/graphql` request
before anything is parsed or run: a foreign `Origin`, `Origin: null`, or a POST other than
`application/json` (a CORS "simple" form post) is refused, and the answer carries no CORS header. The
`Origin` host is compared with the request host (not the scheme, so it holds behind a TLS-terminating
proxy); a request with no `Origin` (not a browser) passes, since the cookie is `__Host-`.

| Refused operation                                                                                          | Answer                                  |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| consent (`oauthRequest`, `approveOAuthRequest`, `denyOAuthRequest`, `connectedApps`, `revokeConnectedApp`) | HTTP 404, `extensions.code` `NOT_FOUND` |
| any other (`signOut`, `requestSignInCode`, `verifySignInCode`, `currentUser`, ...)                         | HTTP 403, `extensions.code` `FORBIDDEN` |

A request that mixes consent and other root fields gets the 403. A refused request is neither executed nor mailed. Both answers are `{ "errors": [...] }` JSON.

## Shutdown

On `SIGTERM` or `SIGINT` the server finishes the requests in flight, then waits up to 10 seconds for
the sign-in code mails still being handed to the relay (`drain` in `src/modules/auth/outbox.ts`, an
`onStop` hook in `src/server.ts`), so a code is not lost; a mail still in flight after that is dropped
and logged (the visitor asks again).

## How a host maps to a tenant

A request belongs to the tenant whose slug is the one label before `CLAVIX_DOMAIN`:
`acme.clavix.example` is tenant `acme`, with issuer `https://acme.clavix.example`
(`CLAVIX_PUBLIC_SCHEME`, and `:CLAVIX_PUBLIC_PORT` when set). The host is the URL's, that is
the `Host` header; `X-Forwarded-Host` is ignored. It is lowercased, its port and trailing dot
removed. No tenant (`null`, a 404 for the OAuth endpoints) for an IP, the apex itself, more
than one label before it, a reserved label (`www`, `console`, `api`, ...), an unknown slug, a
suspended or deleted tenant. A slug is reserved for good: deleting a tenant does not free its slug, and creating a tenant with it fails like any duplicate. In a resolver, `await tenant()` of the context gives
`{ tenantId, slug, issuer, partition, version }`, resolved once per request.

Resolved hosts are cached in Redis (`tenant-host`, 60 s; 30 s for "no tenant"); creating,
suspending, reactivating or deleting a tenant drops its host (the delete is retried once),
and a resolution that raced a write re-reads the tenant and drops what it just stored. A
suspension therefore takes effect within 60 s at worst, even when Redis was down during the
write. A Redis failure is logged and MongoDB is read, so the API runs, slower, without Redis.

Operating the cache:
- Give Redis a `maxmemory` and an eviction policy (`allkeys-lru`, or `volatile-ttl` since
  every entry carries a TTL), so that the cache cannot grow without bound.
- Null entries are bounded by the valid-slug shape, not by the tenants that exist: a client
  sweeping `<random>.CLAVIX_DOMAIN` writes one 30 s entry per host. Put a rate limit per
  client IP at the edge (reverse proxy or CDN) on the wildcard host.

The Redis spec (`src/tenancy/tenant-cache.spec.ts`) starts a real Redis through
`@softistx/redis/testing`, compiled from source on its first run (about two minutes, then
cached in `node_modules/.cache/redis-memory-server` unless `REDISMS_DOWNLOAD_DIR` is set, which
moves the cache there: CI sets it to a per-runner folder under `~/.cache/nxgt/`, so the path above
is the local default only; needs `make` and a C compiler).
