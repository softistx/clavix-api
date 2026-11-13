# clavix-api

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider: one issuer per
tenant at `https://<slug>.<CLAVIX_DOMAIN>`, with its own users, clients, resources and signing keys.
The product spec lives with the project's planning folder, outside this repository.

Today it serves:
- the OAuth 2.1 / OpenID Connect endpoints of each tenant (authorization code with PKCE, refresh,
  JWT access tokens, discovery, userinfo, introspection, JWKS);
- on `POST /graphql`, `GET /healthz` and `health { status version }`, the e-mail code sign-in, the
  passkey sign-in and registration, and the consent API of the hosted pages;
- on `POST /console/graphql`, the console API (`me`, tenants with plans, quotas, usage, suspension and
  trash, a tenant's clients, resources, scopes and branding), behind a bearer token;
- scripts that create tenants, OAuth clients and API resources. Emptying the trash after 30 days is not
  scheduled yet (clavix-api#112); the console's refusals are in `docs/troubleshooting.md`.

## Documentation

| Page                                                                                       | What is in it                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| This README                                                                                | run, environment, and each feature below            |
| [docs/guide/migrating-from-embedded-janus.md](docs/guide/migrating-from-embedded-janus.md) | moving an application from embedded janus to Clavix |
| [docs/guide/magic-link.md](docs/guide/magic-link.md)                                       | the operations the hosted sign-in link page calls   |
| [docs/troubleshooting.md](docs/troubleshooting.md)                                         | the errors you can meet, with causes and fixes      |
| [docs/roadmap.md](docs/roadmap.md)                                                         | what is shipped and what comes next                 |
| [AGENTS.md](AGENTS.md)                                                                     | rules for contributors and agents                   |

## Run

```sh
export GITHUB_TOKEN=$(gh auth token)   # read:packages, for the @softistx packages
bun install
cp .env.example .env
bun run generate   # GraphQL types, gitignored; also run by build and verify
bun dev            # http://localhost:3000/graphql and /healthz
```

## Scripts

| Script                    | Does                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `generate`                | scalar/validation SDL, then GraphQL codegen                               |
| `dev`, `build`, `start`   | watch server; bundle into `dist/`; run the bundle                         |
| `test`                    | `bun test`                                                                |
| `typecheck`               | `bun check`                                                               |
| `lint`, `fix`, `check:ci` | Biome                                                                     |
| `db:sync`, `db:migrate`   | collections, indexes and relations; pending migrations (deployment steps) |
| `tenants:create`          | create a tenant (see "Tenants")                                           |
| `clients:create`          | register or update an OAuth client on a tenant (see "OAuth clients")      |
| `resources:create`        | register or update a tenant's API resource and scopes (see "Resources")   |
| `operators:grant`         | give a clavix-tenant user a platform role for the console (`--email`)     |
| `verify`                  | `generate`, `check:ci`, `typecheck`, `test` (what CI runs, plus `build`)  |

Every script reads `MONGO_URI` and validates the rest of the environment below at start, so with `NODE_ENV=production` a script also needs the production-required variables. What each
one needs on top:

| Script                  | Environment it needs                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db:sync`, `db:migrate` | `MONGO_URI` with a role that may create indexes and validators (`dbAdmin`)                                                                                                                                   |
| `tenants:create`        | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_SCHEME` (and `CLAVIX_PUBLIC_PORT`) for the issuer it prints, `CLAVIX_KEYS_MASTER_KEY` for the first signing key; `REDIS_URL` when set, to drop the tenant cache |
| `clients:create`        | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_SCHEME` (and port) for the issuer it prints                                                                                                                     |
| `resources:create`      | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_SCHEME` (and port), to refuse a tenant's own userinfo URL                                                                                                       |
| `operators:grant`       | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_KEYS_MASTER_KEY` (reads the clavix tenant's users)                                                                                                                     |
| `start`                 | all of the environment; in production `REDIS_URL`, `CLAVIX_DOMAIN`, `CLAVIX_KEYS_MASTER_KEY`, `CLAVIX_SMTP_URL` and `CLAVIX_TRUSTED_PROXIES` are required                                                    |

## Environment

`.env.example` lists the variables; a malformed one stops the app at start, naming it.

| Variable                                                               | Default / rule                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                 | 3000                                                                                                                                                                                                                    |
| `MONGO_URI`                                                            | required; a replica set (transactions)                                                                                                                                                                                  |
| `REDIS_URL`                                                            | required in production; unset elsewhere, the tenant cache is off and monthly active users are not counted                                                                                                               |
| `CLAVIX_DOMAIN`                                                        | required in production; `clavix.localhost` elsewhere                                                                                                                                                                    |
| `CLAVIX_PUBLIC_SCHEME`                                                 | `https`; `http` is refused in production                                                                                                                                                                                |
| `CLAVIX_PUBLIC_PORT`                                                   | optional; set when issuers are not on the scheme's own port                                                                                                                                                             |
| `CLAVIX_SMTP_URL`                                                      | `smtp://` or `smtps://` URL of the mail relay; required in production; unset elsewhere, mails stay in memory                                                                                                            |
| `CLAVIX_KEYS_MASTER_KEY`                                               | required in production (32 bytes, base64); a public development default elsewhere                                                                                                                                       |
| `CLAVIX_CODE_IP_LIMIT` / `CLAVIX_CODE_IP_WINDOW_SECONDS`               | sign-in code requests per client address and tenant: 20 per 600 s                                                                                                                                                       |
| `CLAVIX_CODE_TENANT_LIMIT` / `CLAVIX_CODE_TENANT_WINDOW_SECONDS`       | sign-in code requests per tenant: 200 per 3600 s                                                                                                                                                                        |
| `CLAVIX_PASSKEY_IP_LIMIT` / `CLAVIX_PASSKEY_IP_WINDOW_SECONDS`         | `passkeySignInOptions` requests per client address and tenant: 60 per 600 s                                                                                                                                             |
| `CLAVIX_PASSKEY_TENANT_LIMIT` / `CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS` | `passkeySignInOptions` requests per tenant: 600 per 3600 s                                                                                                                                                              |
| `CLAVIX_MAGIC_LINK`                                                    | global switch of magic-link sign-in (janus `magicLink.enabled`); `true`/`1` or `false`/`0`, default `false`; off, `requestMagicLink` and `confirmMagicLink` answer 404 `MAGIC_LINK_DISABLED` (see "Magic-link sign-in") |
| `CLAVIX_TRUSTED_PROXIES`                                               | reverse proxies in front of the app; required in production (0 if none), default 0 elsewhere (see "Sign-in code limits")                                                                                                |

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

## Console API

`POST /console/graphql` is the console's own GraphQL API (SDL in `src/console`). It reads no
cookie and resolves no tenant from the host: the credential is an access token of the `clavix`
tenant whose audience is `https://console.<CLAVIX_DOMAIN>/api`, sent as `Authorization: Bearer`.
No token, or a forged, expired or other-audience one, is a 401; the store down is a 503. It
exposes `me { user platformRole memberships { tenant { slug } role } }`, a tenant's clients,
resources and scopes (below) and the branding fields (see "Branding"); tenants are still created
by script.

Roles are `owner`, `admin` and `viewer`, on the platform (inherited by every tenant) or on one
tenant; every field is refused unless its guard allows it.

Deployment order: `bun run db:sync`, `bun run db:migrate` (the `2026-11-12-console` migration
registers the console resource and its confidential client `console` in the `clavix` tenant and
prints the client secret once: save it; the `2026-11-13-scopes` migration turns each resource's
scope strings into `Scope` documents), then name the first
operator, a user who already exists in the `clavix` tenant:

```sh
bun run operators:grant --email ada@example.com            # platform owner
bun run operators:grant --email bob@example.com --role viewer
```

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"{ me { platformRole } }"}'
```

### Clients, resources and scopes

Every field takes the `tenantId` it works on. Queries need `view` on that tenant (any role),
mutations need `edit` (`owner` or `admin`); a viewer, or an admin of another tenant, gets
`FORBIDDEN`. Errors carry `extensions.code`: `NOT_FOUND` (also a suspended tenant), `CONFLICT`,
`BAD_USER_INPUT`, `FORBIDDEN`. An id of another tenant is unknown: a query answers `null`, an
update `NOT_FOUND`, a delete `false`. Deleting twice answers `true` then `false`.

| Field                                                | What it does                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `clients(tenantId, q, after, first)`                 | a page of clients in id order (`q` matches the name or the id), `nextCursor`    |
| `client(tenantId, id)`                               | one client, or `null`                                                           |
| `createClient(tenantId, input)`                      | `{ client, clientSecret }`; the secret of a confidential client, shown once     |
| `updateClient(tenantId, id, input)`                  | the name, the redirect URIs; a client keeps its id and its type                 |
| `rotateClientSecret(tenantId, id)`                   | a new secret, shown once; the old one stops working; refused on a public client |
| `deleteClient(tenantId, id)`                         | removes the client and revokes its grants and their tokens                      |
| `resources(tenantId)`, `resource(tenantId, id)`      | the tenant's APIs, each with its `scopes`                                       |
| `createResource`, `updateResource`, `deleteResource` | a resource keeps its URI; deleting it deletes its scopes                        |
| `scopes(tenantId, resourceId)`                       | every scope of the tenant, or those of one resource                             |
| `createScope`, `updateScope`, `deleteScope`          | a scope keeps its name and its resource                                         |

```graphql
mutation {
  createClient(
    tenantId: "6731…"
    input: {
      name: "Back office"
      type: CONFIDENTIAL
      redirectUris: ["https://office.example.com/callback"]
    }
  ) {
    client {
      id
      name
      type
      redirectUris
    }
    clientSecret # shown once: janus keeps only its hash
  }
}
```

```graphql
mutation {
  createScope(
    tenantId: "6731…"
    input: {
      name: "invoices:read"
      resourceId: "6732…"
      description: { fr: "Lire vos factures", en: "Read your invoices" }
    }
  ) {
    id
    name
    description {
      fr
      en
    }
    resourceId
    claims
  }
}
```

- **A client id** is `input.clientId` (`a-z0-9-`) or the name in that form; one that exists is a
  `CONFLICT`. Redirect URIs follow the rules of `clients:create` (below).
- **A scope** belongs to a resource, where its name is unique: two resources may each have a
  `read`. Without `resourceId` it is a standard OpenID Connect scope and its name must be `openid`,
  `profile` or `email`: this is how a tenant writes the consent text of those. `claims` is stored
  only; no claim is emitted from it yet.
- **The consent page** shows a scope's `description` as its label, in the viewer's language
  (`Accept-Language`: French, else English), then in the other language, then the scope's name.
- **A change serves at once**: the scopes a resource offers are read on every OAuth request.
- **Limits**: a name has at most 100 characters, a description 300, a scope 50 claims, a client 20
  redirect URIs, a search 100 characters; more is `BAD_USER_INPUT`.
- **The console's own client and resource** (`console` in the `clavix` tenant) cannot be changed
  or deleted here (`BAD_USER_INPUT`): use `clients:create --client-id console --rotate-secret`.
- **Listing**: clients come in id order; a client made by `clients:create` is listed too. With
  `q`, a page may hold fewer than `first` items (even none) and still give a `nextCursor`: follow
  it until it is `null`.
- **`grantTypes`** on a client is what was recorded when it was registered (both grant types by
  default, or the script's `--grants`). It is shown for information: the token endpoint does not
  enforce it.
- **Deleting a client** signs its users out of it: the grants they gave it and the tokens those
  opened are revoked.

### Admin events

Every console mutation records what it did in the `adminEvents` collection (ADR-0037): the actor
(the token's user), the action (`tenant.create`), the tenant it was about (`null` for the platform),
the target's type and id, the time and the id of the request. Events are only ever added, and they
hold identifiers alone: never a secret, a token or the old and new values of a field. `bun run
db:sync` creates the collection and its two indexes (by tenant and by actor, newest first). Nothing
reads it yet: the viewer and the export come with M4.

A mutation declares its action beside its module's guards (the declaration is spread into `audits`
in `src/console/modules/index.ts`) and records it once its change is stored; AGENTS.md "Admin
events" has the rules:

```ts
// src/console/modules/tenants/index.ts
export const tenantsAudits: Audits = {
  "Mutation.renameTenant": "tenant.rename",
};

// in the resolver, after the write
await ctx.audit("tenant.rename", { type: "tenant", id: tenantId, tenantId });
```

`ctx.audit` is awaited: when the event cannot be stored, the mutation fails (and may be retried)
rather than leave a change with no record. `src/console/audit.spec.ts` fails for a mutation whose
module declares no action.

## Branding

A tenant wears its own theme on the hosted pages. The brand is one document per tenant (collection
`branding`, tenant-owned, run `bun run db:sync` to create it): display name, seed colour, radius,
optional background preset and motif (ids of `@softistx/material-core/backgrounds`), an optional logo,
and the generated stylesheet.

`updateBranding` on `/console/graphql` replaces the whole brand (the logo is kept unless `logo` or
`removeLogo` is sent), so repeating a call changes nothing (`changed: false`). It compiles the seed with
`defineTheme` and `themeToCss({ scope: "attribute" })`, measures every pair with `checkThemeContrast` in
light and dark, and stores the CSS only when all pass WCAG AA. A pair that fails is `BRANDING_CONTRAST`
(422, `extensions.failures`: foreground, background, mode, ratio, minimum). The generator moves a hard
seed (a yellow) lighter or darker to reach AA on its own; the payload's `warnings` say what it moved.
A bad value is `BAD_USER_INPUT` (400, `extensions.field`). `branding(tenantId)` needs `view` on the tenant,
`updateBranding` needs `edit`. Each call that succeeds records the admin event `branding.update`.

The display name is a label only: it is stored as text and never written into the stylesheet. The seed
and the radius are parsed, and the CSS is built from the parsed values, so a value that is not a colour
or a length is refused rather than copied. Escape the display name where you print it. Two calls at the
same time apply one after the other (the document carries a `version`), so a logo one of them sets or
removes is not undone by the other; a call that keeps losing to others is `CONFLICT` (409) and stored
nothing: read the brand and send it again.

Limits: `displayName` 1 to 80 characters; `radius` in rem or px up to 3rem (48px); `backgroundPreset`
and `motif` must be ids of `@softistx/material-core/backgrounds`.

```graphql
mutation {
  updateBranding(
    tenantId: "..."
    input: { displayName: "Acme", seed: "#0a7ea4", radius: "0.5rem" }
  ) {
    changed
    warnings
    branding {
      themeName
      css
      logoUrl
    }
  }
}
```

A logo is a PNG, JPEG or WebP of at most 256 KiB (`logo: { contentType, dataBase64 }`); SVG is refused
because it can carry script. The hosted pages read `tenantBranding` on `/graphql` (anonymous, by the
request host; `null` keeps Clavix's own theme): they put `css` in a `<style>` and set
`data-nxgt-theme="<themeName>"` on the root element, and draw the page's background from
`backgroundPreset` and `motif` (not part of the CSS; `null` for none).

```graphql
{
  tenantBranding {
    displayName
    themeName
    css
    backgroundPreset
    motif
    logoUrl
  }
}
```

`GET /branding/logo` on the tenant's host serves the logo with an `ETag` (its sha256), `304` on
`If-None-Match`, `nosniff` and a sandboxing CSP; `404` (not stored) for an unknown host or a tenant
without a logo, `405` for a method other than GET or HEAD. `logoUrl` is
`/branding/logo?v=<start of the hash>`, so it changes with the image: asked with the current `v` the
logo is `Cache-Control: public, max-age=31536000, immutable`; the bare path, or an old `v`, is
`max-age=300, must-revalidate`.

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

## Resources

An access token is bound to one resource (RFC 8707): the API it is for. A tenant registers its
APIs in the console ("Console API") or by script. A resource is per tenant: `acme`'s is unknown to
`globex` (`invalid_target`). A client asking `resource=<uri>` gets a token whose `aud` is that URI,
signed with the tenant's key; an unregistered URI is refused. Re-running with the same URI updates
the name and replaces the scopes (a scope that stays keeps its consent texts). It serves at once, with no restart.

```sh
bun run resources:create --tenant acme --uri https://api.acme.example \
  --scope invoices:read --scope invoices:write
```

| Flag              | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `--tenant <slug>` | required; an unknown slug or a suspended tenant is refused        |
| `--uri <uri>`     | required; `https` (`http` on a loopback host), no fragment        |
| `--scope <s>`     | required, repeatable; printable ASCII without space, quote or `\` |
| `--name <name>`   | a label; default: the URI's host                                  |

A URI is matched exactly as stored (`resource=` is compared as a string): register it as the API
sends it. The tenant's own `<issuer>/userinfo` is built in (the default resource of OIDC clients that send
none) and cannot be registered.

## OAuth clients

A client is registered on a tenant in the console ("Console API") or by script. Clients are per tenant:
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
- **Grants**: `--grants` is recorded on the client and shown by the console (`grantTypes`), but
  the token endpoint does not enforce it: every client may use the authorization code and refresh
  grants. Any other (device code, token exchange, client credentials) is refused.

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

**The `sub` claim** is the janus user id of the signed-in user in that tenant, unchanged
(`janus-oidc` sets `sub` to the session's `userId` in the id_token and in `/userinfo`; no
hashing, no pairwise value). Janus mints that id in its core (`mintId`) when the user is created:
a lowercase, hyphenated **UUIDv7** (36 characters, e.g. `0192f3a4-5b6c-7d8e-9f01-23456789abcd`),
time-ordered by creation. It is stable: it never changes for a user, whichever client asks, and
it is not derived from the e-mail, so changing the e-mail does not change it. It is unique per
tenant, not across tenants: the same person in two tenants is two users with two unrelated
`sub`s, and a `sub` of one tenant is unknown to another. Treat it as an opaque string (currently
36 characters; do not rely on the shape), keyed together with the issuer (`iss`, the tenant host).

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
- **Passkey relying party** (a default to confirm before the first production passkey, since a passkey is bound to its relying party for good): the tenant's own host. `rpIdOf(tenant)` is
  `<slug>.<CLAVIX_DOMAIN>` and `originOf(tenant)` its origin (`src/users/rp.ts`).
- `authFor` and `claimsFor` (`src/config/users.ts`) are the OAuth issuers' ports, wired in
  `src/server.ts`. Consent and passkeys are below, and a client's `/authorize` needs a resource: userinfo's, or one
  registered with `resources:create`. `__Host-` cookies need https (Chrome accepts `localhost`).

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

## Magic-link sign-in

Off by default: `CLAVIX_MAGIC_LINK=true` (or `1`) turns it on for every tenant. Off, both operations
answer HTTP 404 `MAGIC_LINK_DISABLED` before anything is counted, written or mailed, so the surface
looks absent; the hosted page hides its button. Same endpoint as the e-mail code
(`https://<slug>.<CLAVIX_DOMAIN>/graphql`):

```graphql
mutation {
  requestMagicLink(email: "ada@example.com") {
    expiresAt
  }
}
mutation {
  confirmMagicLink(token: "...") {
    user {
      id
      email
      emailVerified
    }
    expiresAt
  }
}
```

`requestMagicLink` mails a link `https://<slug>.<CLAVIX_DOMAIN>/sign-in/link?token=<token>` (valid
15 minutes; only the last link a user asked for works). The answer is the same for an address with
an account, one without and, on a `signUp: false` tenant, one that is not invited (nothing is created
or sent for the last). The hosted page behind that URL must show a button that POSTs the token to
`confirmMagicLink`: never sign in on the `GET`, mail scanners open links and would spend the token.
`confirmMagicLink` opens the session (`__Host-clavix-session`), marks the e-mail verified, and every
refusal (unknown, spent, expired or stale link) is `MAGIC_LINK_INVALID` (401): offer a new link.
`MAIL_THROTTLED` (429) past 5 requests per address and 10 minutes, and the per-IP and per-tenant
"Sign-in code limits" apply to link requests too (one shared budget). janus 0.57 refuses to enrol a
passkey or second factor while the e-mail is unproved (`EMAIL_UNVERIFIED`), so a link that proves
the e-mail has no squatter's factor to wipe. More in [docs/guide/magic-link.md](docs/guide/magic-link.md).

## Passkey sign-in and registration

Passwordless sign-in with a passkey, on the same `/graphql` of the tenant's host (every operation
below goes through the same-origin guard). janus passkeys are the **first factor** here
(`passkeys.firstFactor`, `@softistx/janus-passkeys`): no password and no TOTP. The relying party
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
  verified gets `EMAIL_UNVERIFIED` (403; janus 0.57 refuses every factor enrolment while the e-mail is unproved, see
  [troubleshooting](docs/troubleshooting.md)). The session must have signed in within 10 minutes
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
  `EMAIL_UNVERIFIED` (403, also at registration), `STEP_UP_REQUIRED` (403), `TOKEN_*` for a bad challenge.
  `UNAUTHENTICATED` (401) when the operation needs a session and has none.
- **Over http** (development): `http://<slug>.clavix.localhost` tenants have passkeys with their real
  rpId and origin (janus 0.55+ accepts `*.localhost` origins).
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
so one Yoga plugin (`useSameOriginJson`, `src/http/same-origin.ts`: `sameOrigin()` of `@alxia/graphql` with a 404 for consent operations) guards every `/graphql` request
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
tenant whose purge started. A suspended or deleted (trash) tenant resolves with its `status`: sign-in,
`/authorize` and `/token` refuse it with `TENANT_SUSPENDED` (403), while discovery and keys keep answering. A slug is reserved for good: deleting a tenant does not free its slug, and creating a tenant with it fails like any duplicate. In a resolver, `await tenant()` of the context gives
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
