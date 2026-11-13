# clavix-api: rules for agents and contributors

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider (one
issuer per tenant): Bun, alxia, GraphQL Yoga, `@softistx/mongo`, `@softistx/redis` and the
`@softistx/janus*` packages. It serves the OAuth/OIDC endpoints and the GraphQL API of the hosted
pages (e-mail code and passkey sign-in, consent), with the tenant, client, resource and signing-key
services behind them; tenants, clients and resources are created by script until the M2 console.
The UI is `softistx/clavix-ui`.

The owner's rules for every repository (worktrees, Conventional Commits, integration
branches, CI quotas, merges and releases, questions to the owner, in-house packages) are
in `~/.claude/CLAUDE.md`; this file states only what is clavix-api's own.

## Where things are

- **The spec** is in `../spec/` (the coordinating session's folder, outside this repository): `README.md`,
  `vision.md`, `domain.md`, `architecture.md`, `decisions.md` (the ADRs, changed only by a
  new ADR), `milestones.md`. Read `architecture.md` and `decisions.md` before a slice.
- **The roadmap** is `docs/roadmap.md`; each slice is one GitHub issue on this repository,
  and a slice that waits on an nxgt-janus release says which one.
- **The coordinating session** is the one in `~/workspace/dev/clavix`: this repository's
  session sends it its status, merges, blockers and every owner question with its
  recommended option, instead of asking the owner directly.

## Conventions

- The conventions are those of the `alxia-graphql-api` plugin (enabled in
  `.claude/settings.json`); healthix-api is the worked example this skeleton was cut from.
- Layout: `src/modules/<name>/` holds a module's `*.graphqls`, resolvers and services,
  merged by `src/modules/index.ts`; `src/http/` holds the context and the schema;
  `src/config/` reads the environment once (`defineEnv`); `src/cli/` holds what the scripts share
  (`CliInputError`, `CliTenant`); `src/http/throttle/` is the rate-limit core (below); generated code is in
  `src/generated/` and `test/generated/` (`bun run generate`, gitignored), never committed.
- `src/oauth/` is the authorization server: one janus server per tenant (`createClavixOAuthIssuers`),
  mounted on the app by `mountOAuth`. Signing keys, end-user authentication, user claims and resources
  come in as ports (`SigningKeysFor`, `AuthFor`, `ClaimsFor`, `ResourcesFor`). The janus adapters
  partition themselves by tenant, so they take the plain `oauthDb` (`src/config/oauth-db.ts`),
  not the scoped collections. `createApp({ oauth })` mounts it. The issuers are split: `issuers.ts` (`createClavixOAuthIssuers`), `resolution.ts` (host to tenant and resources), `building.ts` (the server config). `AuthFor` and `ClaimsFor` are wired by `src/users` (`createIssuers(authFor, claimsFor, resourcesFor?)` in `src/config/oauth.ts` is the real wiring, keys and stored resources included, and `src/server.ts` passes the real `authFor`/`claimsFor` of `src/config/users.ts`; a tenant with no key yet gets a 503 `temporarily_unavailable`). `resourcesFor` defaults to the tenants' stored resources (below); without any, only userinfo's resource, the issuer's `defaultResource`, is served. `/consent` is the hosted page, built in clavix-ui (its API is built, see Consent). `bun run
  db:sync` also syncs the OAuth collections (output `{ app, oauth, users, invitations, relations }`). Lifetimes (assumed
  owner decision, clavix-api#24) (`src/oauth/lifetimes.ts`): access token 15 min,
  refresh 30 days sliding, 90 days cap.
- Imports carry no extension (bundler resolution); `@/` is `src/`, `~/` is `test/`.
- Split by responsibility: no file that holds several roles.
- Commits and PR titles follow Conventional Commits (`type(scope): description`).

## Resources (`src/modules/resources`)

A resource is an API of a tenant (RFC 8707): its `uri` is the `aud` of the access tokens asked with
`resource=<uri>`, its `scopes` what a client may request on it. `bun run resources:create --tenant
<slug> --uri <https uri> --scope <s> [--scope <s>] [--name <label>]` stores or updates one
(idempotent on the URI; the scopes are replaced), until the console (M2). The `resources`
collection is tenant-owned and reached only through `scopeToTenant` (`storedResourcesFor`,
`registerResource`; `src/config/resources.ts` exports `registerStoredResource`, never the collection), so a resource of tenant A is unknown to B (`invalid_target`); the source scan
in `src/tenancy/guards.spec.ts` allows `src/modules/resources/` and `src/config/resources.ts`.
`ResourcesFor` is read on every request in the issuer's `resolve`, and its fingerprint is part of the
cache version, so a script-registered resource serves at once, no restart. A tenant's own userinfo
URL cannot be registered: it is built in, with the OpenID Connect scopes. Scopes are a plain list
for now (assumed; the Scope entity with consent texts is M2).

## OpenID Connect

`src/oauth/issuers.ts` also builds each issuer's `@softistx/janus-oidc` provider (one hook per
issuer, `tokenResponse({ issuer, keys })`, the same key store as the access tokens) and
serves discovery and userinfo before the janus routes. The userinfo URL (`userinfoOf(issuer)`,
`<issuer>/userinfo`) is a resource of every issuer offering `openid`, `profile` and `email`,
and the issuer's `defaultResource`, so a client that sends no `resource` gets a token userinfo
accepts. User claims come in through the `ClaimsFor` port (`src/oauth/ports.ts`): janus gives
`claims` only the issuer, which `build` maps back to its tenant (`issuer -> ResolvedTenant`),
so the lookup is in that tenant's user pool. Introspection (`POST /introspect`, a confidential
client of the same tenant, `client_secret_basic`) answers only for tokens of the tenant's own
resources (`resourcesFor`), never for userinfo's. janus-oauth's `NoSigningKeyError` is a 503 `temporarily_unavailable` on these paths
too (janus answers it itself). The `roles` claim is M2.

## Users and sessions

Magic-link sign-in is a global switch, `CLAVIX_MAGIC_LINK`, off by default: janus 0.56 defaults it to on, so `tenant-janus.ts` always passes `magicLink: { enabled }`. `requestMagicLink` / `confirmMagicLink` (`src/modules/auth/magic-link.ts`, README "Magic-link sign-in") answer 404 `MAGIC_LINK_DISABLED` while it is off, checked in the resolver before the throttle. The test script runs `magic-link.spec.ts` twice: off (default, the "off" half) and with `CLAVIX_MAGIC_LINK=true` (the "on" half), because the flag is read once at start.

`src/users/` holds the end users of a tenant (ADR-0008): `createTenantJanusIssuers` (janus
`createJanusIssuers`, fed by the same tenant resolver as the OAuth issuers, `version` as a string) builds
one `janus()` per tenant over `createMongoStores(db, { partition })`, so users, sessions, passkeys and
tokens are the tenant's partition (`syncMongoStoresPartitioned` and `syncMongoInvitationsPartitioned` in
`db:sync` and `test/setup.ts`). `createTenantAuth` gives the real `authFor` and `claimsFor`
(`src/config/users.ts`, wired in `src/server.ts`): both go through the tenant's own instance, so a
user id or session of another tenant is unknown or anonymous. Relations, API keys and janus-kit are not
partitioned: never use them for tenant users.
- **Cookie**: `__Host-clavix-session`, no `Domain`, Secure, SameSite=Lax. Session 14 days sliding,
  capped at 30 days after sign-in (`session.absolute`, janus 0.53).
- **Assumed, not answered (2026-11-12), confirm before first production passkey**: the passkey rpId is
  the tenant's host and the origin `https://<slug>.<CLAVIX_DOMAIN>`, in one place, `rpIdOf` /
  `originOf` (`src/users/rp.ts`). A custom domain later goes through WebAuthn Related Origins. A
  passkey is scoped to its rpId for good.
- **Sign-up** is the tenant's `signUp` flag (default `false`: closed, invitation only; `clavix` is
  closed). It rides in `ResolvedTenant`, so changing it bumps the `version` and rebuilds the janus.
  Invitations: `createMongoInvitations(db, { partition })`; accepting one has no GraphQL surface
  until the M2 console.

## E-mail code sign-in (`src/modules/auth`, `src/mail`)

The hosted pages' GraphQL (`auth.graphqls`: `requestSignInCode`, `verifySignInCode`, `signOut`,
`currentUser`) sits on `useJanus({ auth })`, the auth being `janusIssuers.forRequest(ctx.request)`
per request (unknown host: `NOT_FOUND`). janus-graphql ships no sign-in-code SDL and no session
cookie setter, so the mutations are ours, on documented janus APIs (`signInCode.prepare`/`confirm`,
`cookie.serialize`/`clear`) and `ctx.set.headers`.
- **No enumeration**: `prepare` mints the challenge before any lookup; user creation, `send()` and the
  mail run after the answer (`outbox.ts`, `afterAnswer`); a closed tenant creates and mails nothing
  for an unknown address; every verify refusal is the same `CODE_INVALID` 401. An open tenant creates
  an unverified user per request (accepted trade-off).
- The challenge travels in the response body (`cache-control: no-store`), not a cookie: the hosted
  pages are a BFF. Code: 6 digits, 10 min, 5 attempts; 5 mails per address per 10 min
  (`MAIL_THROTTLED`, 429), both janus's.
- **Limits on top** (`src/modules/auth/throttle.ts` over `src/http/throttle/core.ts`, README "Sign-in code limits"): per client IP and tenant (20 / 10 min)
  and per tenant (200 / hour), `@softistx/redis` rate limits wired in `openAppRedis`, keys led by the
  tenant id, configured by `CLAVIX_CODE_*`. Refusal = janus's `MailThrottledError`, so the answer is the
  per-address one. `createApp({ signInThrottle })` injects it (specs); default: the app's Redis, none
  without it. The IP is `ctx.ip`; `CLAVIX_TRUSTED_PROXIES` (required in production, 0 elsewhere by default) makes `createBase` read
  `X-Forwarded-For`, and `test/setup.ts` sets it to 1 so specs choose the address by header.
- **Mail**: one platform sender `no-reply@<CLAVIX_DOMAIN>` (display name = tenant name) over
  `@softistx/mail-smtp` when `CLAVIX_SMTP_URL` is set (required in production), else the memory
  mailer. Links point at the tenant issuer. Mails are English: users have no locale yet.
- Specs: `src/modules/auth/auth.spec.ts` (flow, closed sign-up, invitation, isolation A/B).

## Magic-link sign-in (`src/modules/auth/magic-link.ts`)

Same shape as the e-mail code (janus `magicLink.prepare` then, after the answer, `send()` and
`mail.magicLink`; sign-up creation shared as `createIfOpen`), on the same `signInThrottle`. The link is
`<issuer>/sign-in/link?token=` (`MAGIC_LINK_PATH`, `src/mail/tenant-mail.ts`), a hosted page that POSTs
`confirmMagicLink`; never a sign-in on GET. Every confirm refusal is `MAGIC_LINK_INVALID` 401. No second
factor is configured, so `confirm` always opens a session; janus 0.57 refuses enrolment while the
e-mail is unproved (janus#693 closed there, no guard of ours).

## Passkeys (`src/modules/passkeys`)

Passwordless passkey sign-in and registration on `/graphql` (README, "Passkey sign-in and
registration"). janus passkeys are the first factor (`passkeys.firstFactor: true`,
`@softistx/janus-passkeys`), rpId and origin from `src/users/rp.ts`; janus-graphql's passkey SDL is
not used: its resolvers bind to one janus instance and it has no first-factor sign-in, and ours is
per tenant, so the operations sit on `auth.passkeys` like the sign-in code's.
- The passkey sign-in is janus-graphql's `passkeyResolvers({ auth, firstFactor: true })`, called from
  our own `passkeySignInOptions` (a Mutation, behind the throttle) and `signInWithPasskey`: our SDL keeps
  its names, arguments and errors, so the janus refusals (`CREDENTIALS_INVALID`, `TOKEN_*`, a non-JSON
  response) are answered as one `PASSKEY_INVALID` 401 (`asPasskeyInvalid`; `STORE_FAILED` stays 503).
  Registration lets janus's errors through (`janusMasking`). Cookie as `verifySignInCode`.
- No `secondFactor` is configured (no TOTP is offered). janus (0.55+) accepts
  `http://<name>.localhost` origins, so a development tenant on http (`<slug>.clavix.localhost`) gets its
  real rpId and origin like any other: no http special case.
- Specs use `softwareAuthenticator` from `@softistx/janus-passkeys/testing`.
- The anonymous `passkeySignInOptions` has its own limits (`src/modules/passkeys/throttle.ts`, README
  "Passkey sign-in and registration"): per IP and tenant (60 / 10 min) and per tenant (600 / hour),
  `CLAVIX_PASSKEY_*`, over the shared core `createThrottle` / `ipAndTenantLimits` of
  `src/http/throttle/core.ts` (never copy it); the throttles ride on the context (`ctx.signInThrottle`,
  `ctx.passkeyThrottle`, set by `createBase`). `passkeySignInOptions` resolves the tenant first (unknown host: `NOT_FOUND`, no budget spent). Refusal = `PASSKEY_THROTTLED` 429 with `Retry-After`; Redis down:
  fail open, logged. `createApp({ passkeyThrottle })` injects it (specs); default: the app's Redis.
  Spec: `src/modules/passkeys/throttle.spec.ts`.

## Consent

`src/modules/consent/` is the API of the hosted `/consent` page, served on E1's `/graphql`
(janus-oauth's `oauthResolvers` and `oauthTypeDefs`, merged in `src/http/schema.ts`). `oauthContext`
(a Yoga plugin added in `createApp` when `oauth.serverFor` exists) puts the issuers in the context, and
the resolver picks the request host's tenant's OAuth server; the session is that tenant's too.
The same-origin guard is not in this module: it is the HTTP-layer plugin below, so a consent operation refused there still sees `NOT_FOUND`.
`approveOAuthRequest` is fresh-only (5 min, `STEP_UP_REQUIRED`) and passes no `amr`/`acr` (janus gap,
not worked around). Passkeys are the next section.

## Same-origin guard and shutdown

`useSameOriginJson` (`src/http/same-origin.ts`, first Yoga plugin of `createApp`; `sameOrigin()` of `@alxia/graphql` with this API's own refusals) guards **every**
`/graphql` operation once: a foreign `Origin`, `Origin: null` or a non-JSON POST is answered before
parsing, with no CORS header: consent operations (`CONSENT_FIELDS`) get 404 `NOT_FOUND`, all others 403
`FORBIDDEN`. Origin and request are compared by host (TLS-terminating proxy); no Origin passes (the cookie
is `__Host-`). A new operation needs no guard of its own; never add a CORS plugin without revisiting this, and `onRequest` does not guard a WebSocket upgrade (`ws` is off: keep it so or guard the upgrade).
On stop, `server.ts` has an `onStop` hook that awaits `drain()` (`src/modules/auth/outbox.ts`, 10 s)
so a code mail in flight is not lost; `stopTimeout` is set above it.

## Signing keys

`src/keys/` holds the per-tenant signing keys on janus (`signingKeysFor`, `jwksFor`, wired in
`src/config/keys.ts`; a tenant's partition is its hex id), the rotation policy and the hourly
`key-rotation` queue (Redis only; without it the pass at server start is the only one). `CLAVIX_KEYS_MASTER_KEY` encrypts them (README, "Signing keys"). Sign and
verify through the janus store; never log a key record, never read `oauthSigningKeys` raw
outside the specs.

## Tenants by script

`bun run tenants:create` (`src/scripts/tenants-create.ts`, README "Tenants") creates a tenant until the
M2 console. It only parses flags (`src/modules/tenants/cli.ts`) and calls `registerTenant`
(`register-tenant.ts`), which goes through `TenantsService.create` (the one place for slug rules,
reserved slugs and the first-key hook; never copy them). Idempotent on the slug: same values report
`created: false`, other values are refused, a deleted tenant's slug stays reserved.

## Console API (`src/console`)

The console's own GraphQL API, `POST /console/graphql`, apart from the hosted pages' `/graphql`
(`src/http/schema.ts` and `codegen.ts` leave `src/console/**` out; `codegen.console.ts` generates
`src/generated/console`). No cookie and no Host-based tenant: the credential is a bearer JWT of the
`clavix` tenant whose audience is `https://console.<CLAVIX_DOMAIN>/api`, verified in process by
`server.authenticate(request, { resource })` (`auth.ts`; no crypto of ours, a store outage is a 503,
every other failure a 401).
- **Permissions** are a janus `defineModel` (`model.ts`) over the relation store in `oauthDb`
  (`config/access.ts`; `db:sync` creates its collection): platform and tenant `owner` / `admin` /
  `viewer`, permits `manage` / `edit` / `view`, a platform role inherited by every tenant through the
  tenant's `platform` link. The link is written when a tenant is created (`config/tenancy.ts`
  `onCreated`) and backfilled by the `2026-11-12-console` migration.
- **Deny by default** (`guard.ts`): every root field is wrapped, and one without an entry in its
  module's `guards` (`signedIn()`, `onTenant(perm, args => tenantId)`, `onPlatform(perm)`) is refused
  `FORBIDDEN`. A spec enumerates the real root fields. A new field ships with its guard.
- **A slice adds a module** under `src/console/modules/<name>/` (SDL, resolvers, guards, the audit
  action of each mutation: "Admin events" below) and lists it in `modules/index.ts`; the SDL lives
  there, never in `src/modules`.
- **The migration** `2026-11-12-console` (`src/migrations/console-seed.ts`) registers the console
  resource and the confidential client `console` (redirect URI `<console origin>/console/auth/callback`,
  an assumption until the UI slice settles it) in the `clavix` tenant. The client secret is printed
  once by the migration (not in tests).
- **`bun run operators:grant --email <address> [--role owner|admin|viewer]`** gives a user of the
  `clavix` tenant a platform role (default owner), until the console can. The user must exist.

### Admin events (`src/console/audit.ts`, `src/console/admin-events/`)

Every console mutation writes an append-only admin event (ADR-0037). A slice that adds a mutation
does two things, and nothing else touches the collection:
- **Declare** the action beside the module's guards, `export const <name>Audits: Audits = {
  "Mutation.renameTenant": "tenant.rename" }`, and spread it into `audits` in `modules/index.ts`
  (one line). `audit.spec.ts` walks the schema and fails on a `Mutation` root field with no action,
  on a declaration that names no mutation, and on an action that is not `<noun>.<verb>`
  (`AUDIT_ACTION`: camelCase segments, `client.rotateSecret`).
- **Record** it in the resolver, once the change is stored:
  `await ctx.audit("tenant.rename", { type: "tenant", id, tenantId })`. `tenantId` is the hex id of
  the tenant the target belongs to, `null` only for a target of the platform itself (an operator).
  `id` is the entity's own id (at most 200 characters), never a URI or free text, and `type` a
  short noun (`client`). The actor (the token's user), the time and the request id are filled in
  for you. A call the schema refuses (a malformed action, a `tenantId` that is not a tenant's hex
  id) throws on every try: the slice's spec runs each mutation once and asserts its stored event. A mutation that
  touches several targets records one event each; the same request id ties them.
- **Awaited, and a failure fails the mutation**: `ctx.audit` rejects when the event cannot be
  stored, so the resolver throws and the caller retries rather than a change being left with no
  record. So a mutation stays safe to repeat (the plan's idempotency rule): its second run stores
  nothing twice and records the event the first one missed. Never `void` it or catch its error. The declaration is not
  checked against the call: the slice's own spec asserts the stored event.
- **Never a secret**: an event is identifiers only (`target` is `{ type, id }`). The schema is
  closed (`z.strictObject`, no free-form field), so there is no place for a secret, a token or the
  before/after of a value, and none is to be added.
- `adminEvents` is a platform collection: its `tenantId` says which tenant an event is about, so it
  is listed in `platformCollections` (`src/tenancy/owned.ts`) and left out of the tenant-owned
  guards. It is reached only through `AdminEventRecorder.record` (`src/config/admin-events.ts`); a
  source scan in `src/tenancy/guards.spec.ts` refuses any other access or export. Indexes (`tenantId, at` and `actor, at`,
  newest first) are the definition's, created by `db:sync`. No reader and no SDL until the viewer
  (M4). `ConsoleDeps.adminEvents` takes another recorder in a spec.
- The request id is minted per HTTP request by the console plugin; a client's `x-request-id` is
  never used.

## Branding (`src/modules/branding`, `src/console/modules/branding`)

A tenant's brand is one tenant-owned document (`branding`, unique on `tenantId`), reached only through
`BrandingService` (`config/branding.ts`), which scopes every read and write with `scopeToTenant`.
- **The theme is compiled on write, served as stored** (`theme.ts`): `validateThemeInput`, then
  `defineTheme` and `themeToCss({ scope: "attribute" })` of `@softistx/material-core`, measured by
  `checkThemeContrast` in light and dark. A failing pair is `BRANDING_CONTRAST` and nothing is stored.
  Never write a stylesheet by hand, and never store CSS that did not pass `buildTheme`.
- **Nothing a tenant typed is copied into the CSS**: the display name is a label, the seed and radius
  are parsed by the library and our radius pattern, the preset and motif are ids from its lists. The
  hosted pages put `css` in a `<style>`, so a new brand field that reaches the stylesheet is parsed or
  taken from a closed list, and gets a case in the "break out of the stylesheet" spec.
- **`updateBranding` is a whole replacement, idempotent** (`changed: false` when nothing differs) and
  serialised by the optimistic lock: `update` writes at the version it read and decides again after a
  concurrent write (three attempts, then `CONFLICT`, 409). A new field joins `same()` or a repeat stops being a no-op.
  It records the admin event `branding.update` (target `branding`, id the tenant's) after the store,
  on a repeat too: the retry of a call whose record failed must still leave an event.
- **The logo** (`logo.ts`, `logo-route.ts`) is a PNG, JPEG or WebP of at most 256 KiB, checked by its
  magic bytes and stored inline; never SVG (it runs script on the tenant's own host). Its sha256 is the
  `ETag`, and `immutable` is sent only when `?v=` names the current image (`logoUrl`).
- **Two schemas**: the console's `branding` / `updateBranding` (guards `view` / `edit` on the tenant)
  live in `src/console/modules/branding`; the anonymous `tenantBranding` by host is in
  `src/modules/branding` and shows only what a hosted page draws (no seed, no tenant id).

## Tenants, plans, usage and the trash (`src/modules/tenants`, `src/modules/usage`, `src/console/modules/tenants`)

- **Two services on the one collection**: `TenantsService` creates and flips the status (script and
  tests); `TenantAdminService` (`config/tenancy.ts`: `tenantAdmin`) is what the console uses: `find` /
  `get` (trash included, a purging tenant is gone), `list`, `update`, `setPlan`, `trash`, `restore` and
  the three writes of the purge. Every write drops the tenant's host from the resolver's cache.
- **State**: `stateOf` = `active` | `suspended` | `deleted` (the trash), or `null` once the purge started.
  The resolver returns suspended and deleted tenants (`ResolvedTenant.status`); a caller that serves a
  tenant checks `isLive` (`tenancy/live.ts`: `requireLive`, `TENANT_SUSPENDED`, 403). Enforced on
  `requestSignInCode`, `verifySignInCode`, `requestMagicLink`, `confirmMagicLink`, the passkey sign-in,
  and `/authorize` and `/token` (`oauth/tenant-state.ts`, a 403 JSON `access_denied`, not a redirect).
  Discovery, jwks, userinfo, introspect, revoke, `signOut` and `currentUser` keep answering: tokens
  already issued live to expiry, and the console stays readable.
- **Plans** (`plan.schema.ts`): `free`, `pro`, `enterprise`; `effectiveQuotas` = plan, then the tenant's
  `quotaOverrides` (setting a key to `null` removes the override; an override cannot express "no limit").
- **Usage** (`UsageService`, `config/usage.ts`): monthly active users are a Redis unique counter
  (`clavix:usage.mau`, 400 days), counted at sign-in, passkey sign-in and a successful `/token` (the `sub`
  of the access token, so refreshes count); `recordActive` never throws. Without `REDIS_URL` nothing is counted (the stored month is read). The month is snapshotted in
  `usageCounters` (tenant-owned) when read, never lowered. Clients are counted in
  `oauthPartitionedClients` by `partition`; domains count 0 until A4 (clavix-api#11). `assertWithinQuota`
  / `QuotaExceededError` (`QUOTA_EXCEEDED`, 409) is for the hard quotas, used by the creations of
  clients (A2) and domains (A4); MAU is a soft meter (`exceeded`), it blocks nothing.
- **Trash and purge**: `deleteTenant` soft-deletes; `purgeAt` = `deletedAt` + 30 days. `purgeTenants`
  (`purge.ts`) claims (`purgeStartedAt`: it resolves nowhere, cannot be restored), purges the janus
  partition, the tenant-owned collections (`ownedPurgers`, by `isOwned`: `adminEvents` is the platform's
  record and stays), the roles and platform link (`access.removeTenant`), then `markPurged` leaves a
  tombstone (slug, `deletedAt`, `purgedAt`) that keeps the slug reserved. The Redis MAU counters (hashed, no user ids) are not deleted: they expire on their own after 400 days.
  A failing tenant stays
  claimed and the next run resumes it. **Not scheduled, and `PartitionPurger` has no implementation**:
  Temporary, until @softistx/janus-oauth-mongo#710; wiring is clavix-api#112. A new tenant-owned
  collection needs nothing here, but is a purge target: keep it behind `tenantOwned`.
- **Console API**: `tenants`, `tenant`, `plans`, `usage` and the seven mutations are in
  `src/console/modules/tenants`, with their audit actions (`tenant.create`, `.update`, `.setPlan`,
  `.suspend`, `.resume`, `.delete`, `.restore`). Only `updateTenant` is open to a tenant admin; the rest
  is platform-only. The `Tenant` parent is `TenantParent` (codegen mapper), so `Me.memberships` keeps
  working with the extended type.
- **Still public for a suspended or deleted tenant**: the anonymous `tenantBranding` and the logo by host
  (a hosted page can show its suspended screen); `createTenant` repeated with the same slug, name, plan
  and sign-up returns the tenant and records the event again (a retry after a failed record).
  Dynamic client registration is off; if it is ever turned on, `tenant-state.ts` must refuse `/register`.

## OAuth clients

`src/clients/` registers a client on a tenant (`registerClient`, the script `clients:create`
in `src/scripts/clients-create.ts`, README "OAuth clients"). It writes through the janus store of
the tenant's partition (`createMongoOAuth(oauthDb, { partition })`), with its own client id as
the idempotency key (janus has no lookup by name); a secret is minted with janus's
`mintOAuthSecret`, shown once and stored as `hashOAuthSecret`. Tenants are read through
`tenantBySlug` (`src/config/tenancy.ts`). Grants are not stored: janus-oauth 0.8 has no
per-client list (the script refuses all but code and refresh). A client keeps its type: re-running a
public client with `--confidential`, a confidential one without it, or `--rotate-secret` on a public
one is refused (docs/troubleshooting.md).

## Green bar

`bun run verify` = `generate`, `check:ci` (Biome), `typecheck` (`bun check`), `test`; CI
(`.github/workflows/ci.yml`, on pull requests into `develop` only) runs it, then `build`.
The `@softistx/*` packages come from GitHub Packages: `export GITHUB_TOKEN=$(gh auth token)`
(`read:packages`) before `bun install`; CI uses the `PACKAGES_TOKEN` secret.

## Tests and the machine

A spec connects to no service the CI runner lacks. The skeleton has no store; the slice
that adds MongoDB or Redis starts an in-memory one in `test/setup.ts` (as healthix-api's
does) rather than reading `.env`. A slice runs the specs of the code it changed.
