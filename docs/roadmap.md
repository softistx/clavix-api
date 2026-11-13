# Roadmap

What clavix-api does and what comes next, from the point of view of the applications and
tenants that use it. The spec is in `../spec/`.
A "Next" entry says what the effort will cover, not how. An effort that waits on an
nxgt-janus release says which.

## Now

- **Console API foundation** — the console's own GraphQL API at `/console/graphql`, behind a
  bearer token of the `clavix` tenant, with platform and tenant roles (owner, admin, viewer), a
  deny-by-default guard on every field, and `operators:grant` to name the first operators
  ([#99](https://github.com/softistx/clavix-api/issues/99)).
- **Console** — operators and tenant admins manage Clavix from the console instead of scripts:
  tenants, plans and quotas with usage counters
  ([#8](https://github.com/softistx/clavix-api/issues/8)); a tenant's clients, resources, scopes,
  users and admin roles ([#9](https://github.com/softistx/clavix-api/issues/9)); a theme per
  tenant with an AA contrast check ([#10](https://github.com/softistx/clavix-api/issues/10));
  custom domains with DNS TXT verification and automatic TLS
  ([#11](https://github.com/softistx/clavix-api/issues/11)); and sign-in methods and social
  providers per tenant ([#12](https://github.com/softistx/clavix-api/issues/12)).

## Next

- **Access rules** — an application publishes its OpenAPI and SDL from CI
  ([#34](https://github.com/softistx/clavix-api/issues/34)); a tenant drafts, publishes,
  versions and rolls back the access rules of a resource, with coverage and a simulator
  ([#35](https://github.com/softistx/clavix-api/issues/35)); Clavix serves them signed, with a
  `policy.published` event ([#36](https://github.com/softistx/clavix-api/issues/36)); and a guide
  goes from schema publication to enforced rules
  ([#37](https://github.com/softistx/clavix-api/issues/37)). The SDK part
  (`clavixPolicy()`, `clavixRelations()`) is [#38](https://github.com/softistx/clavix-api/issues/38)
  and [softistx/alxia#700](https://github.com/softistx/alxia/issues/700).
  Waits on `@softistx/security` `remotePolicy`.

## Later

**Advanced protocols**
- PAR mandatory by default; DPoP-bound tokens.
- Device authorization and its verification page; token exchange.
- Rich authorization requests and their consent.
- MCP and agents: dynamic registration policy, RFC 9728, consent per agent.

**Federation, step-up and events**
- Enterprise OIDC connections and home-realm discovery.
- MFA policy and step-up (`acr_values`, `max_age`, `acr`/`amr`).
- Audit log, viewer and export; webhooks per tenant; telemetry.

**Authorization authoring**
- Roles, permissions and relations defined per tenant in the console, as the vocabulary
  the access rules refer to.

## Shipped

- **Dogfooding on Clavix** — our applications sign in through Clavix: the OIDC authorization
  server per issuer, users and sessions per tenant, passkeys and e-mailed codes, clients,
  resources and tenants registered by script, and a migration guide. Each piece is listed below.

- **Magic-link sign-in (toggleable)** — `requestMagicLink` and `confirmMagicLink`, off by default
  (404 `MAGIC_LINK_DISABLED` when off) and turned on per tenant in its sign-in policy. The answer is
  the same for any address, requests are throttled, and the link proves the e-mail
  ([#89](https://github.com/softistx/clavix-api/issues/89)).
- **Skeleton** — the repository builds, lints, type checks and tests: a `health` query and
  `GET /healthz`.
- **Tenants** — a tenant model, the tenant a host belongs to (resolved from the `Host` and
  cached in Redis, a suspension applying within 60 s at worst), a repository that cannot
  read another tenant's data, slugs reserved for good, and the `clavix` tenant seeded.
- **Signing keys per tenant** — keys kept encrypted by janus's Mongo key store, rotated on
  a schedule (90 days, published 48 h ahead, retired 24 h), published as a JWKS per issuer
  ([#2](https://github.com/softistx/clavix-api/issues/2)); adopted from janus-oauth 0.8.
- **An authorization server per issuer** — authorization code with PKCE, refresh with
  rotation, revocation and discovery for each tenant. A request with no `resource` is for
  the userinfo resource, the tenant's `defaultResource`; an API audience needs a registered
  resource. A consent API on `/graphql` serves the hosted consent page.
- **OpenID Connect** — id_token, userinfo, `openid-configuration`, JWT access tokens
  (RFC 9068) and introspection ([#4](https://github.com/softistx/clavix-api/issues/4)): each
  tenant host serves its own discovery, JWKS, userinfo and introspection, with user claims
  from the tenant's own user pool. The `roles` claim waits for the console.
- **Users and sessions per tenant** — one partitioned user pool per tenant, a host-only
  `__Host-` session cookie (14 days sliding, 30-day absolute cap), e-mail code sign-in
  (`requestSignInCode`, `verifySignInCode`, `signOut`, `currentUser`), per-tenant `signUp`
  (closed on `clavix`, invitation only, no account enumeration), and passwordless passkey
  sign-in and registration (`passkeySignInOptions`, `signInWithPasskey`,
  `passkeyRegistrationOptions`, `registerPasskey`, `myPasskeys`, `removePasskey`)
  ([#5](https://github.com/softistx/clavix-api/issues/5)).
- **Clients registered by script** — `bun run clients:create` registers or updates a public
  (PKCE) or confidential client on a tenant, idempotently, the secret shown once
  ([#6](https://github.com/softistx/clavix-api/issues/6)). Grants other than code and
  refresh wait on a per-client grant list in janus-oauth.
- **Tenants created by script** — `bun run tenants:create` creates a tenant (slug rules,
  reserved and deleted slugs refused, first signing key) idempotently and prints its issuer
  ([#74](https://github.com/softistx/clavix-api/issues/74)).
- **Resources registered by script** — `bun run resources:create` stores a tenant's API
  (audience URI and scopes), idempotently; an app's own API gets access tokens with its `aud`,
  isolated per tenant ([#75](https://github.com/softistx/clavix-api/issues/75)). Scopes are a
  plain list until the console.
- **Migration guide** — how an application moves from embedded janus to Clavix as an OIDC
  relying party ([#7](https://github.com/softistx/clavix-api/issues/7)):
  [written](guide/migrating-from-embedded-janus.md).
