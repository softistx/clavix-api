# clavix-api: rules for agents and contributors

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider (one
issuer per tenant): Bun, alxia, GraphQL Yoga, and later `@softistx/mongo`,
`@softistx/redis` and the `@softistx/janus*` packages. It serves the OAuth/OIDC endpoints,
the GraphQL API of the console and of the hosted pages, and the tenant, key, domain and
policy services. The UI is `softistx/clavix-ui`.

The owner's rules for every repository (worktrees, Conventional Commits, integration
branches, CI quotas, merges and releases, questions to the owner, in-house packages) are
in `~/.claude/CLAUDE.md`; this file states only what is clavix-api's own.

## Where things are

- **The spec** is in `../spec/` (the coordinating session's folder): `README.md`,
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
  `src/config/` reads the environment once (`defineEnv`); generated code is in
  `src/generated/` and `test/generated/` (`bun run generate`, gitignored), never committed.
- `src/oauth/` is the authorization server: one janus server per tenant (`createClavixOAuthIssuers`),
  mounted on the app by `mountOAuth`. Signing keys, end-user authentication, user claims and resources
  come in as ports (`SigningKeysFor`, `AuthFor`, `ClaimsFor`, `ResourcesFor`). The janus adapters
  partition themselves by tenant, so they take the plain `oauthDb` (`src/config/oauth-db.ts`),
  not the scoped collections. `createApp({ oauth })` mounts it. `AuthFor` and `ClaimsFor` are wired by `src/users` (`createIssuers(authFor, claimsFor, resourcesFor?)` in `src/config/oauth.ts` is the real wiring, keys included, and `src/server.ts` passes the real `authFor`/`claimsFor` of `src/config/users.ts`; a tenant with no key yet gets a 503 `temporarily_unavailable`), and without `resourcesFor`
  no `/authorize` succeeds. `/consent` is the hosted page of a later UI slice (its API is built, see Consent). `bun run
  db:sync` also syncs the OAuth collections (output `{ app, oauth, users, invitations }`). Lifetimes (assumed
  owner decision, clavix-api#24) (`src/oauth/lifetimes.ts`): access token 15 min,
  refresh 30 days sliding, 90 days cap.
- Imports carry no extension (bundler resolution); `@/` is `src/`, `~/` is `test/`.
- Split by responsibility: no file that holds several roles.
- Commits and PR titles follow Conventional Commits (`type(scope): description`).

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
resources (`resourcesFor`), never for userinfo's. `NoSigningKeyError` is a 503 on these paths
too. The `roles` claim is M2.

## Users and sessions

`src/users/` holds the end users of a tenant (ADR-0008): `createTenantJanusIssuers` (janus
`createJanusIssuers`, fed by the same tenant resolver as the OAuth issuers, `version` as a string) builds
one `janus()` per tenant over `createMongoStores(db, { partition })`, so users, sessions, passkeys and
tokens are the tenant's partition (`syncMongoStoresPartitioned` and `syncMongoInvitationsPartitioned` in
`db:sync` and `test/setup.ts`). `createTenantAuth` gives the real `authFor` and `claimsFor`
(`src/config/users.ts`, wired in `src/server.ts`): both go through the tenant's own instance, so a
user id or session of another tenant is unknown or anonymous. Relations, API keys and janus-kit are not
partitioned: never use them for tenant users.
- **Cookie**: `__Host-clavix-session`, no `Domain`, Secure, SameSite=Lax. Session 14 days sliding;
  the 30-day absolute cap is a janus gap (no option in 0.52), not worked around.
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
- **Limits on top** (`throttle.ts`, README "Sign-in code limits"): per client IP and tenant (20 / 10 min)
  and per tenant (200 / hour), `@softistx/redis` rate limits wired in `openAppRedis`, keys led by the
  tenant id, configured by `CLAVIX_CODE_*`. Refusal = janus's `MailThrottledError`, so the answer is the
  per-address one. `createApp({ signInThrottle })` injects it (specs); default: the app's Redis, none
  without it. The IP is `ctx.ip`; `CLAVIX_TRUSTED_PROXIES` (default 0) makes `createBase` read
  `X-Forwarded-For`, and `test/setup.ts` sets it to 1 so specs choose the address by header.
- **Mail**: one platform sender `no-reply@<CLAVIX_DOMAIN>` (display name = tenant name) over
  `@softistx/mail-smtp` when `CLAVIX_SMTP_URL` is set (required in production), else the memory
  mailer. Links point at the tenant issuer. Mails are English: users have no locale yet.
- Specs: `src/modules/auth/auth.spec.ts` (flow, closed sign-up, invitation, isolation A/B).

## Consent

`src/modules/consent/` is the API of the hosted `/consent` page, served on E1's `/graphql`
(janus-oauth's `oauthResolvers` and `oauthTypeDefs`, merged in `src/http/schema.ts`). `oauthContext`
(a Yoga plugin added in `createApp` when `oauth.serverFor` exists) puts the issuers in the context, and
the resolver picks the request host's tenant's OAuth server; the session is that tenant's too.
`ownsRequest` is the same-origin guard (a foreign Origin or a non-JSON POST sees `NOT_FOUND`).
`approveOAuthRequest` is fresh-only (5 min, `STEP_UP_REQUIRED`) and passes no `amr`/`acr` (janus gap,
not worked around). Passkeys (slice E3) wait on janus: its passkeys are a second factor beside TOTP
only, with no passwordless sign-in yet.

## Signing keys

`src/keys/` holds the per-tenant signing keys on janus (`signingKeysFor`, `jwksFor`, wired in
`src/config/keys.ts`; a tenant's partition is its hex id), the rotation policy and the hourly
`key-rotation` queue (Redis only; without it the pass at server start is the only one). `CLAVIX_KEYS_MASTER_KEY` encrypts them (README, "Signing keys"). Sign and
verify through the janus store; never log a key record, never read `oauthSigningKeys` raw
outside the specs.

## OAuth clients

`src/clients/` registers a client on a tenant (`registerClient`, the script `clients:create`
in `src/scripts/clients-create.ts`, README "OAuth clients"). It writes through the janus store of
the tenant's partition (`createMongoOAuth(oauthDb, { partition })`), with its own client id as
the idempotency key (janus has no lookup by name); a secret is minted with janus's
`mintOAuthSecret`, shown once and stored as `hashOAuthSecret`. Tenants are read through
`tenantBySlug` (`src/config/tenancy.ts`). Grants are not stored: janus-oauth 0.8 has no
per-client list (the script refuses all but code and refresh).

## Green bar

`bun run verify` = `generate`, `check:ci` (Biome), `typecheck` (`bun check`), `test`; CI
(`.github/workflows/ci.yml`, on pull requests into `develop` only) runs it, then `build`.
The `@softistx/*` packages come from GitHub Packages: `export GITHUB_TOKEN=$(gh auth token)`
(`read:packages`) before `bun install`; CI uses the `PACKAGES_TOKEN` secret.

## Tests and the machine

A spec connects to no service the CI runner lacks. The skeleton has no store; the slice
that adds MongoDB or Redis starts an in-memory one in `test/setup.ts` (as healthix-api's
does) rather than reading `.env`. A slice runs the specs of the code it changed.
