# clavix-api

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider. The
spec is in `../spec/`; the plan is `docs/roadmap.md`. Rules for contributors:
[AGENTS.md](AGENTS.md).

Today it is a skeleton: `GET /healthz`, and `health { status version }` on `POST /graphql`.

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
| `clients:create`          | register or update an OAuth client on a tenant (see "OAuth clients")     |
| `verify`                  | `generate`, `check:ci`, `typecheck`, `test` (what CI runs, plus `build`) |

## Environment

`.env.example` lists the variables; a malformed one stops the app at start, naming it.

| Variable                 | Default / rule                                                                    |
| ------------------------ | --------------------------------------------------------------------------------- |
| `PORT`                   | 3000                                                                              |
| `MONGO_URI`              | required; a replica set (transactions)                                            |
| `REDIS_URL`              | required in production; unset elsewhere, the tenant cache is off                  |
| `CLAVIX_DOMAIN`          | required in production; `clavix.localhost` elsewhere                              |
| `CLAVIX_PUBLIC_SCHEME`   | `https`; `http` is refused in production                                          |
| `CLAVIX_PUBLIC_PORT`     | optional; set when issuers are not on the scheme's own port                       |
| `CLAVIX_KEYS_MASTER_KEY` | required in production (32 bytes, base64); a public development default elsewhere |

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
- **Lifetime**: 14 days, sliding (renewed once a day). The 30-day absolute cap is not enforced
  yet: janus has no such option.
- **Passkey relying party** (assumed, not answered): the tenant's own host. `rpIdOf(tenant)` is
  `<slug>.<CLAVIX_DOMAIN>` and `originOf(tenant)` its origin (`src/users/rp.ts`).
- `authFor` and `claimsFor` (`src/config/users.ts`) are the OAuth issuers' ports, wired in
  `src/server.ts`. Sign-in itself (e-mail code, passkeys, consent) comes with slices E1 and E2, and no `/authorize`
  succeeds before a tenant has a resource (M2). `__Host-` cookies need https (Chrome accepts `localhost`).

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
