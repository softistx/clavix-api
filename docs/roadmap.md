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
- **Admin events** — every change made from the console is recorded: who did it, what, on which
  tenant and target, and when, with no secret value ever stored. The viewer and the export come
  with the audit log ([#107](https://github.com/softistx/clavix-api/issues/107)).
- **Console** (in progress; the foundation, branding and admin events above are in the M2
  integration branch, nothing of M2 is in `develop` yet) — operators and tenant admins manage
  Clavix from the console instead of scripts:
  - Platform: tenants with plans, quotas and usage counters
    ([#8](https://github.com/softistx/clavix-api/issues/8)). A suspended tenant refuses
    sign-ins and new tokens (tokens already issued live to expiry, the console stays readable).
    A deleted tenant goes to a 30-day trash, can be restored, then is purged; its slug stays
    reserved. The API and the scheduled daily purge of the trash are in the M2 integration branch
    (tenants, plans, usage, suspension, trash; the purge uses janus's partition purges,
    softistx/nxgt-janus#710, [#112](https://github.com/softistx/clavix-api/issues/112)).
  - Switchable tenants: `me.switchableTenants`, the shell's tenant switcher (a member's tenants, an
    operator's every live tenant, paged and searchable; done on the M2 branch,
    [#120](https://github.com/softistx/clavix-api/issues/120)).
  - Tenant: clients, resources and scopes with consent texts (done on the M2 branch); users (list, invite,
    disable, delete, sessions and grants; done on the M2 branch,
    [#101](https://github.com/softistx/clavix-api/issues/101); the e-mail search is exact until janus
    offers a prefix filter), end-user roles per tenant, scoped to a resource or not, and assigned to users (done on the M2 branch, [#102](https://github.com/softistx/clavix-api/issues/102)); admin roles remain ([#9](https://github.com/softistx/clavix-api/issues/9)).
  - Branding: a theme per tenant with an AA contrast check, a logo and a public brand query by
    host ([#10](https://github.com/softistx/clavix-api/issues/10)) (in progress).
  - Custom domains: DNS TXT verification and automatic TLS; certificates are issued only for
    verified domains of active tenants
    ([#11](https://github.com/softistx/clavix-api/issues/11)). The API is in the M2
    integration branch (add, verify, remove, make primary, a 6-hourly recheck with a 7-day
    grace, the TLS ask endpoint, the Related Origins document); the reverse-proxy
    configuration waits for the going-live slice.
  - Going live ([#108](https://github.com/softistx/clavix-api/issues/108)): a `Dockerfile`, a
    compose file with Caddy (on-demand TLS asking the API, a wildcard option), `/healthz` and
    `/readyz`, a MongoDB backup and restore script with a restore drill, and the runbook
    [operations.md](operations.md) (done on the M2 branch; no deploy pipeline, images are built by hand).

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
- PAR required per tenant and per client (on for new tenants); DPoP-bound tokens.
- Device authorization and its verification page; token exchange.
- Rich authorization requests and their consent.
- MCP and agents: dynamic registration policy, RFC 9728, consent per agent.

**Federation, step-up and events**
- Enterprise OIDC connections and home-realm discovery.
- MFA policy and step-up (`acr_values`, `max_age`, `acr`/`amr`).
- Admin events and OAuth events: viewer, export and retention per plan; webhooks per tenant;
  telemetry.

**Before v1**
- Master-key rotation, a security review of the whole surface, a load test of the token and
  JWKS paths, and a restore drill.

**Authorization authoring**
- Roles, permissions and relations defined per tenant in the console, as the vocabulary
  the access rules refer to.

## Shipped

- **Sign-in methods and social providers per tenant** — a tenant turns passkey, e-mail code and
  magic link on or off, and brings its own Google, GitHub or Microsoft app (secret sealed at rest,
  never returned); the platform tenant always keeps passkey or e-mail code
  ([#12](https://github.com/softistx/clavix-api/issues/12)):
  [guide](guide/sign-in-methods.md).
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
  from the tenant's own user pool. The `roles` claim (id_token, userinfo and access tokens) is released from the console's end-user roles.
- **Users and sessions per tenant** — one partitioned user pool per tenant, a host-only
  `__Host-` session cookie (14 days sliding, 30-day absolute cap), e-mail code sign-in
  (`requestSignInCode`, `verifySignInCode`, `signOut`, `currentUser`), per-tenant `signUp`
  (closed on `clavix`, invitation only, no account enumeration), and passwordless passkey
  sign-in and registration (`passkeySignInOptions`, `signInWithPasskey`,
  `passkeyRegistrationOptions`, `registerPasskey`, `myPasskeys`, `removePasskey`)
  ([#5](https://github.com/softistx/clavix-api/issues/5)).
- **Clients registered by script** — `bun run clients:create` registers or updates a public
  (PKCE) or confidential client on a tenant, idempotently, the secret shown once
  ([#6](https://github.com/softistx/clavix-api/issues/6)). A client's grant types are
  recorded and shown, not enforced; grants other than code and refresh wait on janus-oauth.
- **Tenants created by script** — `bun run tenants:create` creates a tenant (slug rules,
  reserved and deleted slugs refused, first signing key) idempotently and prints its issuer
  ([#74](https://github.com/softistx/clavix-api/issues/74)).
- **Resources registered by script** — `bun run resources:create` stores a tenant's API
  (audience URI and scopes), idempotently; an app's own API gets access tokens with its `aud`,
  isolated per tenant ([#75](https://github.com/softistx/clavix-api/issues/75)). Scopes became
  documents with per-language consent texts in the console API
  ([#9](https://github.com/softistx/clavix-api/issues/9)).
- **Migration guide** — how an application moves from embedded janus to Clavix as an OIDC
  relying party ([#7](https://github.com/softistx/clavix-api/issues/7)):
  [written](guide/migrating-from-embedded-janus.md).
