# clavix-api: rules for agents and contributors

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider (one
issuer per tenant): Bun, alxia, graxia (`@softistx/alxia-graphql` on `@softistx/graxia`), `@softistx/mongo`, `@softistx/redis` and the
`@softistx/janus*` packages. It serves the OAuth/OIDC endpoints and the GraphQL API of the hosted
pages (e-mail code and passkey sign-in, consent), with the tenant, client, resource and signing-key
services behind them; tenants, clients, resources and scopes are managed in the console API
(the M2 console) or by script.
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
  `src/config/` reads the environment once (`defineEnv`); the hosted `/graphql` serves its IDE (Apollo Sandbox) and allows
  introspection (`introspection: ide` of `createApp`) only when `CLAVIX_GRAPHQL_IDE` is on (`createApp({ ide })`: on under `bun dev`, off elsewhere, refused in production; the console API has `ide: false`), since the page runs a third-party script on the session cookie's origin; `src/cli/` holds what the scripts share
  (`CliInputError`, `CliTenant`); `src/http/throttle/` is the rate-limit core (below); generated code is in
  `src/generated/` and `test/generated/` (`bun run generate`, gitignored), never committed.
- `src/oauth/` is the authorization server: one janus server per tenant (`createClavixOAuthIssuers`),
  mounted on the app by `mountOAuth`. Signing keys, end-user authentication, user claims and resources
  come in as ports (`SigningKeysFor`, `AuthFor`, `ClaimsFor`, `ResourcesFor`). The janus adapters
  partition themselves by tenant, so they take the plain `oauthDb` (`src/config/oauth-db.ts`),
  not the scoped collections. `createApp({ oauth })` mounts it. The issuers are split: `issuers.ts` (`createClavixOAuthIssuers`), `resolution.ts` (host to tenant and resources), `building.ts` (the server config). `AuthFor` and `ClaimsFor` are wired by `src/users` (`createIssuers(authFor, claimsFor, resourcesFor?)` in `src/config/oauth.ts` is the real wiring, keys and stored resources included, and `src/server.ts` passes the real `authFor`/`claimsFor` of `src/config/users.ts`; a tenant with no key yet gets a 503 `temporarily_unavailable`). `resourcesFor` defaults to the tenants' stored resources (below); without any, only userinfo's resource, the issuer's `defaultResource`, is served. `/consent` is the hosted page, built in clavix-ui (its API is built, see Consent). `bun run
  db:sync` also syncs the OAuth collections (the clients `source` index of `countClients`, which counts the quota's clients in `src/config/usage.ts`) (output `{ app, oauth, users, invitations, relations }`). Lifetimes (assumed
  owner decision, clavix-api#24) (`src/oauth/lifetimes.ts`): access token 15 min,
  refresh 30 days sliding, 90 days cap.
- Imports carry no extension (bundler resolution); `@/` is `src/`, `~/` is `test/`.
- Split by responsibility: no file that holds several roles.
- Commits and PR titles follow Conventional Commits (`type(scope): description`).

## Telemetry (`src/telemetry/`, `src/config/telemetry.ts`, D24)

`buildTelemetry` makes the app's `@softistx/telemetry` (OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, no exporter
otherwise; `ratioSampler(0.1)` in production), `config/telemetry.ts` installs it, and `createBase` (`http/context.ts`) gives
`@softistx/alxia-telemetry` to `use` first, with `createApp({ telemetry })` to swap it in a spec. A second middleware resolves the tenant
(the memoised `ctx.tenant()`) and runs the rest under `withAttributes` of `clavix.tenant.id` and `clavix.tenant.plan` (`ResolvedTenant.plan`,
`telemetry/tenant.ts`); `/healthz`, `/readyz` and `/internal/*` are neither traced nor resolved. `buildTenantJanus` returns
`instrumentJanus(...)`; `createClavixOAuthIssuers` passes `instrument` (`instrumentOAuth`, tenant attributes via `tenantAttributes`; spec `src/oauth/telemetry.spec.ts`); the MongoDB command spans (`instrumentDatabase`, `server.ts`) need `monitorCommands`, set in `db.ts` only
with an endpoint. **Never written:** tokens, codes, secrets, e-mails, logins, IPs: `createBase` passes `clientAddress: false`
to `@softistx/alxia-telemetry` (>= 0.10.0), so the server span leaves `client.address` off. A new attribute is
added to `tenantAttributes` or to the span that owns it, never from a request body. Spec: `telemetry/telemetry.spec.ts`.

## Console pages carry `totalCount: Int!`

Every paged console connection (`TenantUserPage`, `ClientPage`, `RoleMemberPage`, `TenantPage`,
`SwitchableTenantPage`) exposes `totalCount`: all the matches, ignoring the cursor and `first`,
honouring the search (`q`, `status`, `emailPrefix`). It is counted by the module's tenant-scoped
service (`clientsService.count`, `rolesService.membersCount` through `scopeToTenant`,
`ctx.users.count`, `tenantAdmin.count` sharing its `filterOf` with `list`), never by a copy of the
filter. The lists that are plain arrays (resources, scopes, roles, memberships, adminInvitations,
domains) have no connection: their length is the count. A new paged connection adds `totalCount`
the same way.

## Resources (`src/modules/resources`)

A resource is an API of a tenant (RFC 8707): its `uri` is the `aud` of the access tokens asked with
`resource=<uri>`, its scopes what a client may request on it. `bun run resources:create --tenant
<slug> --uri <https uri> --scope <s> [--scope <s>] [--name <label>]` stores or updates one
(idempotent on the URI; the scopes are replaced), beside the console. The `resources` and `scopes`
collections are tenant-owned and reached only through `scopeToTenant` (`Catalog` in `catalog/index.ts`,
`storedResourcesFor`, `registerResource`; `src/config/resources.ts` exports `catalog`,
`registerStoredResource` and `scopeTextsFor`, never the collections), so a resource of tenant A is unknown to B (`invalid_target`); the source scan
in `src/tenancy/guards.spec.ts` allows `src/modules/resources/` and `src/config/resources.ts`.
`ResourcesFor` is read on every request in the issuer's `resolve`, and its fingerprint is part of the
cache version, so a script-registered resource serves at once, no restart. A tenant's own userinfo
URL cannot be registered: it is built in, with the OpenID Connect scopes.
- **A scope is a document** (`scopes.model.ts`, ADR-0025): `name`, `description { fr, en }`,
  `resourceId` and `claims`, unique on `(tenantId, resourceId, name)`, so two resources may each
  have a `read`. `resourceId: null` is a standard OpenID Connect scope and only `openid`, `profile`
  or `email` (`scope-name.ts`); it exists once a tenant describes it. `claims` is stored only.
- **`Catalog`** is the one writer of scopes and the console's writer of resources
  (`registerResource` upserts the resource itself, then calls `replaceResourceScopes`); it throws `CatalogError`
  (`NOT_FOUND`, `CONFLICT`, `BAD_USER_INPUT`), which the console maps to `extensions.code`. Sizes are
  bounded there (names 100 characters, descriptions 300, 50 claims; a client 20 redirect URIs).
- **The fingerprint** comes from what `storedResourcesFor` reads (URIs and scope names, now from the
  `scopes` documents), so a scope added or removed in the console serves at once.
- **Detail types** (`detail-types/`, README "Authorization details", D1/D2, softistx/clavix-api#17 and #18):
  the console's `Catalog` (`catalog/detail-types.ts`) is the only writer: the type name is immutable, labels hold 100 and descriptions 300 characters (`MAX_LABEL`, `MAX_DESCRIPTION`), deleting a type a client lists throws `DETAIL_TYPE_IN_USE` (D6), and deleting a resource removes its types and prunes them from the clients' lists (`DetailTypeClients`);
  the tenant-owned `detailTypes` collection (unique on `(tenantId, type)`, so a name is unique in the
  tenant) holds a bounded field list, compiled by the pure `compile.ts` into a `z.strictObject` (no
  free JSON Schema); `storedResourcesFor` gives each resource `authorizationDetails`, `fingerprintOf`
  hashes the definitions (`digestOf`) so an edit rebuilds the issuer, and `withScopes` keeps a resource
  that has types and no scope. `saveDetailType` is the writer (the console's `Catalog` wraps it). `createDetailType` repeated with the same values on the same resource returns the stored type (the console records its event again, as `createResource` and `createScope` do); other values or another resource stay `CONFLICT`.
- **A client opts in** (R3): `registerClient` and `ClientsService` take `detailTypes` (`authorizationDetailsTypes` on the janus record; `src/clients/detail-types.ts` judges it). Each name must be a stored type of the tenant (the `ClientDetailTypes` port, wired in `config/resources.ts`), the final client must require PAR (D3), and a client with `authorization_code` or the device grant (a consent page) needs the tenant in `CLAVIX_RAR_CONSENT_READY` (temporary `rarConsentReady`, removed with the consent page, V4). A kept type that is no longer stored stays on the record and is refused by the issuer.
- **The consent API shows details in words** (R4, D4/D5): `OAuthRequest.details` and `OAuthDeviceRequest.details` (`consent/detail-labels.graphqls`) are built by the pure `detailsOf` (`consent/detail-labels.ts`) from janus's `authorizationDetails` string and the tenant's `detailTypes` texts (`detailTextsFor` in `config/resources.ts`, read once per request like the scope texts, put on the context by `oauthContext`). A detail that cannot be fully described (type deleted, a key, action or enum value the type no longer defines) makes `detailsComplete` false (`reviewDetails`), and janus-oauth's `beforeApprove` hook (`consent/index.ts`, once per approval in both flows) refuses it with `invalid_authorization_details`, the request staying pending. Approval stays all or nothing: `beforeApprove` refuses any `authorizationDetails` selection with `invalid_authorization_details`, in both flows. `src/oauth/rar.spec.ts` is the end-to-end spec.
- **Migration `2026-11-13-scopes`** moves the old `resources.scopes` strings to documents (empty
  texts); `resources.scopes` stays optional in the model for its `down`.
- **Migration `2026-11-16-name-keys`** backfills `nameKey` on the `partitionedUsers` written before janus 0.66 (janus-mongo "Backfilling name keys"), which `userLookup`'s `namePrefix` reads; run `db:sync` first.

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
too (janus answers it itself). The `roles` claim: see "End-user roles" below.

## OAuth policy (`src/modules/oauth-policy`, `src/console/modules/oauth-policy/`)

`tenant.oauth` (`oauthPolicySchema`: `{ par: { required }, dpop: { required } }`, every flag defaults to `false`) is on the tenant document and on `ResolvedTenant`, so an entry cached before the field parses off. `building.ts` passes `pushedAuthorizationRequests: { required: tenant.oauth.par.required }` (`/par` is always served, and is in `OAUTH_PATHS`, `REFUSED_PATHS` and the Caddyfile `@api` matcher).
- **Every write goes through `OAuthPolicyService`** (over `TenantsService.updateOAuth`, optimistic lock, no write when nothing changes, `version` bump), modelled on `SignInPolicyService`. The `clavix` tenant accepts `par.required` / `dpop.required` like any tenant (the 409 guard is lifted, #233): migration `2026-11-17-console-par-dpop` sets both on the tenant and marks the `console` client `requirePar` + `dpopBound` (idempotent, version bumped only on a change; its `down` relaxes them). The console (clavix-ui#228) pushes (PAR) and proves (DPoP ES256), so **deploy clavix-ui first or together**: an older console is locked out once the migration has run. `test/setup.ts` relaxes the platform tenant after the migrations, so the specs keep minting plain tokens; `console.spec.ts` sets `dpop.required` itself and restores it.
- `TenantsService.create` writes `par.required: true` for a new tenant (not the platform one); migration `2026-11-16-oauth-policy` writes an explicit `false` on the existing ones (`db:sync` first). Specs that authorize directly on a tenant made by `createFlow().setUp` get PAR turned off there (`{ par: true }` keeps it).
- **Device grant** (`deviceAuthorization: { verificationUri: \`${issuer}/device\` }`in`building.ts`for every tenant;`/device_authorization`is in`OAUTH_PATHS`, `REFUSED_PATHS`and the Caddyfile`@api`matcher). It is never implied: a client lists`DEVICE_GRANT`in`grantTypes`. `registerClient`requires redirect URIs only when the grants include`authorization_code` (`usesRedirect`); default grants are `DEFAULT_GRANTS`, not `OFFERED_GRANTS`. The verification page's operations are janus's `oauthResolvers` (`modules/consent/index.ts`) with `beforeUserCodeLookup`=`deviceThrottle` (`modules/consent/device-throttle.ts`, `CLAVIX_DEVICE_*`, on the shared `createUserThrottle`of`http/throttle/core.ts`). The hook runs before the store is read, so it counts every lookup, not only misses. The device approve guard looks the code up first, so it runs the hook itself and marks the call (`counted`) so janus's hook does not count it twice. Specs that call `/authorize`on a new tenant use`createTenantParOff`.
- **Client credentials grant** (#362): opt-in at three levels. A resource sets `allowClientCredentials` (`Resource` model, `storedResourcesFor` gives janus `clientCredentials: true`, `updateResource` in the console, refused on the console's own resource by `refuseMachineConsole`); `building.ts` turns the server option on for a tenant only when one of its resources opted in (`fingerprintOf` adds `cc` so the cached issuer rebuilds); a client lists `CLIENT_CREDENTIALS_GRANT`, is confidential and has `allowedScopes` (the ceiling janus enforces; `defaultScopes` optional), judged by `registerClient`/`validate.ts`. The `accessTokens.claims` hook skips `roles` for `subjectType: "client"`. Only the token endpoint accepts a client token: the console's `authenticateRequest` never passes `clientCredentials`, userinfo answers 401, and no other endpoint reads a bearer principal. `OAuthPrincipal` is a union (`kind`/`subjectType`); the console uses `OAuthUserPrincipal`. Revoking does not cut a client off: delete it, drop the grant or rotate the secret. Spec: `src/oauth/client-credentials.spec.ts`; guide: `docs/guide/client-credentials.md`.
- **Token exchange** (`tokenExchange: { policy: exchangePolicy(...) }` in `building.ts`, every tenant; `exchangePolicy` is in `src/oauth/token-exchange.ts`): the policy reads the client's rules through the `ExchangeRulesFor` port (`src/oauth/ports.ts`, stored by `src/config/client-policies.ts`, collection `clientPolicies`, tenant-owned) and answers `delegation` or `null` (`access_denied`); with no port, always `null`. Rules: `targetResources` and `subjectClients | "any"`. A client lists `TOKEN_EXCHANGE_GRANT` and is confidential (`registerClient`, `ClientsService.setTokenExchange`, which checks the input with `validateTokenExchange` in `src/modules/client-policies/validate.ts`); `ClientsService.delete` deletes its rules and removes the client from the other rules' `subjectClients` (`removeSubjectClient`); deleting a resource removes its URI from `targetResources` (`removeTarget`), both tenant-scoped.
- **DPoP** (`dpop` in `building.ts`, every tenant): `algorithms ['ES256','EdDSA']`, `required: tenant.oauth.dpop.required`, `replay: createMongoDPoPReplayCache(oauthDb, { clock })` (Mongo, shared by instances, not Redis) and `nonce: { secret }`, the secret being `dpopNonceSecretOf(masterKeys)` (`src/config/keys.ts`: HKDF-SHA256 of the first master key, info `dpop-nonce`) passed to `createClavixOAuthIssuers({ dpopNonceSecret })` (required: specs pass a constant). The proof's `htu` is the issuer's public URL. New tenants start with `dpop.required: false` (`newTenantOAuthPolicy`). A client's `dpopBoundAccessTokens` goes through `registerClient` (`dpopBound`, CLI `--dpop-bound` / `--no-dpop-bound`, kept on a re-run) and `ClientsService`; `ClientView` carries it. The console (`src/console/auth.ts`) takes `Bearer` and `DPoP` through `server.authenticateRequest({ headers, method, url: publicUrl }, { resource })`, `publicUrl` being `https://console.<domain>/console/graphql` (`config/console.ts`); a refused DPoP request is a `ConsoleDPoPRefusal` that the plugin answers as `WWW-Authenticate: DPoP` plus `DPoP-Nonce`. Specs: `~/dpop` signs proofs (`createDpopKey`) and retries on `use_dpop_nonce` (`withNonce`). The console also refuses a delegated token (`principal.actor`, an RFC 8693 exchange) with a plain 401.
- A client's own `requirePushedAuthorizationRequests` goes through `registerClient` (`requirePar`, CLI `--require-par`) and `ClientsService`; `ClientView` carries it.
- **Agents (M3b G1)**: `tenant.oauth.agents` (`{ dynamic: off|restricted|open, redirectUris, metadataDocuments, allowHosts }`, default off, zod `.default` so old cached tenants parse) feeds janus's `registration` through `registrationOf` (`src/oauth/registration.ts`: restricted is janus's MCP redirect URIs plus the tenant's valid ones; documents only from the MCP hosts plus `allowHosts`). `/register` is Clavix's own route (`src/oauth/register-route.ts`, wired by `withRegistration` and `config/agents-registration.ts`, mounted with the client IP): suspended tenant 403, janus's 400 when off, throttle (`CLAVIX_REGISTER_*`), a body of at most 16 KiB (413 on a larger `Content-Length`, the stream cut at 16 KiB otherwise), then, under one `exclusive` lock per tenant (`agentsQuotaKey`, `oauth/agents-quota.ts`; the console's Redis lock, in-process without Redis), the `agents` quota (403 `access_denied`), `server.registerClient` and the tenant-owned `agentClients` record (rolled back with `deleteClient` if the record fails). A metadata-document client is recorded (`kind: metadata`) on first `/authorize` or `/par`, idempotently; before janus fetches the document, `withRegistration` throttles it (`CLAVIX_METADATA_*`, 429 `temporarily_unavailable`) and, for a client not yet recorded, runs the quota check (403 `access_denied` over it), the fetch and the record under the same per-tenant lock. Dynamic agents are not counted in the `clients` quota or meter. `/register` is in `OAUTH_PATHS`, `REFUSED_PATHS` and the Caddyfile `@api` matcher. The device and token-exchange URNs are never offered to dynamic clients.
- **Agents (M3b G2)**: the console's `OAuthPolicy.agents` goes through `applyAgentsInput` (`modules/oauth-policy/agents-input.ts`: lower-cased deduped hosts, redirect URIs checked with `redirectUriProblem`, 50 entries at most, `AgentsInputError` becomes `BAD_USER_INPUT`); `agentsNeedPushOrProof` is the D14 flag (agents on while `par`/`dpop` required tenant-wide), saving stays allowed. `Client.registration` (`CONSOLE|DYNAMIC|METADATA`) is derived from the janus `source` plus `AgentClientsService.kinds`; `clients(kind:)` is a list filter; metadata-document clients are listed and read (`find(..., { agents: true })`) but writes still see registered clients only. `deleteClient` removes the agent record too (`ClientsService.delete`). The daily job `agents.prune` (`modules/agents/prune.ts`, queue `agents-prune` 03:41 UTC, started in `server.ts`, wired in `config/agents-prune.ts`, no start-up pass) deletes agents of every kind (dynamic and metadata-document, so none counts toward the quota for ever) recorded more than 7 days ago with no standing grant, the grant check and the delete under the tenant's clients lock (`clientsKey`), one admin event `agent.prune` per agent actually removed with the actor `system:agents:prune`; it needs `REDIS_URL` (no queue, no run); a failed agent makes the tick throw so the queue retries.
- **RFC 9728 document (M3b G3)**: the console `Resource.metadataUrl` and `protectedResourceMetadata` come from `protectedResourceDocument` (`modules/resources/protected-resource-document.ts`), which calls janus's `protectedResource()` and returns its handler's body, so the console never drifts from janus. The tenant host is resolved once per request; one that does not resolve gives `null` for `metadataUrl` and `protectedResourceMetadata` (both nullable). The issuer and DPoP policy are the resolved tenant's (`tenantResolver.resolveHost` on the slug host); DPoP is announced only when `oauth.dpop.required` (algorithms `DPOP_ALGORITHMS`, shared with `building.ts`). Clavix hosts no copy (D13); the RAR detail types join the document once janus ships them (J3).
- Console: `oauthPolicy` needs `view`, `updateOAuthPolicy` `edit`, admin event `oauthPolicy.update`.

## Users and sessions

Sign-in methods are the tenant's own policy (`tenant.signIn`, `src/modules/sign-in-methods/`; README "Sign-in methods and social providers"), never an environment switch:
- **One field, one schema**: `signIn: signInPolicySchema` (`sign-in.schema.ts`) on the tenant document and on `ResolvedTenant`: `methods` is a list of `{ type, enabled }` entries (`mfa: { mode: passkeySufficient|required, totp }` goes beside it, with zod defaults so a cached tenant without it still parses: `totp` off, mode `passkeySufficient`) and `social` a list of `{ provider, clientId, secret, enabled }`. A method absent from the list has its default (`passkey` and `emailCode` on, `magicLink` and `password` off). `password` is stored but not available (`isAvailable`): it is never on and cannot be enabled until janus's password flow is wired.
- **Every write goes through `SignInPolicyService`** (`service.ts`, over `TenantsService.updateSignIn`): it refuses a policy with no enabled method and no enabled provider (`NO_SIGN_IN_METHOD`), writes nothing when nothing changes, and bumps the tenant's `version`, which rebuilds its janus (`createJanusIssuers`).
- **Gates**: `requireMethod(tenant, method)` (`gate.ts`) is the first line of the e-mail code and passkey sign-in resolvers, before any throttle (404 `SIGN_IN_METHOD_DISABLED`). Magic link keeps janus's own gate: janus defaults it to on, so `tenant-janus.ts` always passes `magicLink: { enabled }` from the policy, and `requestMagicLink` / `confirmMagicLink` (`src/modules/auth/magic-link.ts`) answer 404 `MAGIC_LINK_DISABLED`, checked in the resolver before the throttle. Registering a passkey while signed in is not gated.
- **Social secrets** are sealed by `secretBox` (`src/config/keys.ts`, `secrets.ts`): AES-256-GCM under an HKDF-SHA256 subkey of `CLAVIX_KEYS_MASTER_KEY` (info `social-secrets`), stored as `{ v: 1, kid, iv, ct }` with the tenant id and provider as associated data, so an envelope copied to another tenant or provider does not open. The master key itself is not exported. A secret is opened only in `socialProvidersOf` (`social.ts`), when a tenant's janus is built; it is in no GraphQL type (console or hosted), no log line and no error message (a provider that cannot be built is skipped with a warning naming the tenant, the provider and the error's name). The resolved tenant, cached in Redis, holds the envelope, never the secret.
- **A social sign-in may replace an unverified holder (nxgt-janus #978)**. **Assumed, not answered**:
  `social.unverifiedHolder` (`unverifiedHolderOf`, `tenant-janus.ts`) answers `'replace'` for the tenant's built-in
  social apps (Google, GitHub, Microsoft: the static providers, which vouch for the addresses they hold) and
  `'refuse'` for an enterprise connection (the tenant's own identity provider could vouch for an address it does
  not control). janus asks only once the provider reported the e-mail verified, and never replaces a verified
  user. A replaced user loses their credentials, links and sessions; `SocialSignedIn.replaced` says so, and the
  sign-in log's `session.signIn` carries `reason: "replaced"`. Clavix revokes the replaced user's OAuth grants
  and refresh tokens itself: `socialSignInComplete` calls `revokeOAuthGrants` (`modules/consent/revoke.ts`, janus-oauth
  `grants.revokeAll`) when `replaced` is true, before anything else. janus does not repeat `replaced`, so a
  failure must not be lost (clavix-api #353): `revokeOnReplace` (`modules/consent/revoke-job.ts`) puts a failed
  revocation on the `grants-revoke` queue (`revoke.queue.ts`, `{ tenantId, userId }`, 8 attempts, backoff 1 min
  doubling to 1 h, `grantsRevokeQueue` in `config/grants-revoke.ts`) and the sign-in succeeds once the job is
  stored; the worker (`startGrantsRevoke`, started in `server.ts`, `createGrantsRevoke`) finds the tenant's
  server by its issuer URL and repeats the idempotent `revokeAll`. With no Redis, or when the job cannot be
  added, the original error fails the sign-in as before.
- **The social flow is janus's**: `socialSignInStart` / `socialSignInComplete` delegate to janus-graphql's `socialResolvers` with a per-request auth function (the tenant of the host, null when it has no provider); the providers are `@softistx/janus-social` presets. A new user is created only where the tenant's `signUp` is open (`SIGN_UP_DISABLED` otherwise). No provider code is written here.
- **Console** (`src/console/modules/sign-in-methods/`): `signInPolicy` needs `view`, the three mutations `edit`, on the tenant of `tenantId`. Each mutation records its admin event after the write (`signInPolicy.update`, `socialProvider.set`, `socialProvider.remove`; target ids only, never a client id or secret). A change that loses the optimistic lock three times is `CONFLICT` (409).
- **Console users** (`src/console/modules/users/`): reads need `view`, the mutations `edit` (`updateUser` renames only; `setUserEmailVerified` writes the flag only), on the tenant of `tenantId`; the tenant must be active. Janus is reached only through the `ConsoleUsers` port (`janus-users.ts`), per tenant. `users` searches by `emailPrefix` (case-insensitive, also a username) with a `totalCount`; `userLookup` (`edit`, the role member picker: e-mail/username prefix through janus, name prefix through janus's indexed `namePrefix`; at most 20, id/email/name only) feeds the Add member picker; `userSessions` lists a user's sessions (`device` is the sign-in's User-Agent, set by `src/modules/auth/device.ts` on the e-mail code and magic-link sign-ins). Each mutation records its admin event (`user.*`; ids only), repeats included.
- **What is offered is what can be opened**: `hostedSignInMethods` and `socialSignInStart` use `offeredSocial(policy, secretBox.opens)`, so a provider sealed under a key outside the `CLAVIX_KEYS_MASTER_KEY` keyring is not shown (with a keyring the first key seals and every key opens; `keys:reseal` wraps them again under the first).

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
  `originOf` (`src/users/rp.ts`). A verified custom domain is a WebAuthn related origin of it
  (ADR-0036): `ResolvedTenant.relatedOrigins` (the same `relatedOriginsOf` list the well-known document
  serves) joins janus's `passkeys.origins`, and the janus issuer cache's version carries its digest, so
  verifying or removing a domain rebuilds the instance. A passkey is scoped to its rpId for good. The janus and OAuth issuer cache versions start with `tenantId`, so a tenant recreated under a purged slug never gets the old instance, bound to the old partition (#290).
- **Sign-up** is the tenant's `signUp` flag (default `false`: closed, invitation only; `clavix` is
  closed). It rides in `ResolvedTenant`, so changing it bumps the `version` and rebuilds the janus.
  Invitations: `createMongoInvitations(db, { partition })`; accepting one is the hosted
  `acceptInvitation` (below, "Admins of a tenant and invitations").

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

## E-mail verification (`src/modules/auth/email-verification.ts`)

`requestEmailVerification` / `confirmEmailVerification` (README "E-mail verification"), signed in only
(`auth.authenticate`, else `UNAUTHENTICATED`; `requireLive` first). Request: `verifyEmail.prepare(email)`
then, after the answer, `send()` and `mail.verifyEmail` (link `VERIFY_EMAIL_PATH`, `src/mail/tenant-mail.ts`);
always `true`, an already verified user is mailed nothing, and the token must be issued to the signed-in
user. Confirm: `verifyEmail.confirm(token, { user })`, **never** `firstProof` and never unbound; every
janus refusal except `STORE_FAILED` is `EMAIL_VERIFICATION_INVALID` 400. janus's `MAIL_THROTTLED` becomes
`EMAIL_VERIFICATION_THROTTLED` too (stable code for the UI).
- Limits (`src/modules/auth/verification-throttle.ts`, `CLAVIX_VERIFY_*`): per user (`tenantId/userId`,
  10 / hour), then the shared core pair per IP and tenant and per tenant. `ctx.verifyThrottle`, injected with
  `createApp({ verifyThrottle })`; Redis down: fail open, logged.
- Spec: `src/modules/auth/email-verification.spec.ts` (incl. OIDC `email_verified`, tenant isolation,
  suspended tenant, Redis).

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
- **TOTP second factor (M4 M1)**: every tenant's janus is built with `secondFactor` (`tenant-janus.ts`), so a user who holds a factor gets a challenge instead of a session. The sealing keys come from the keyring (`src/users/second-factor-keys.ts`: HKDF-SHA256 of each master key, info `second-factor`, key id = another 8 bytes of the same master key): the first key seals, every key opens, so a rotation of `CLAVIX_KEYS_MASTER_KEY` keeps TOTP working. `keys:reseal` seals the TOTP secrets again with janus's `secondFactor.reseal` (`src/keys/second-factor-reseal.ts`) and counts what is still under an older key (`secondFactor.behind` for secrets, `recoveryCodesBehind` for the recovery-code hashes, which cannot be re-hashed): keep the old key until `recoveryCodesBehind` is 0. `src/modules/mfa/` binds janus-graphql's `secondFactorResolvers` (bound once, `auth` a function of the context answering the request's tenant janus (nxgt-janus#914), `NOT_FOUND` for an unknown host, `freshWithin: '10m'`) behind our own SDL; its guard refuses `enroll` and `activate` with 403 `SECOND_FACTOR_DISABLED` when the policy's `mfa.totp` is off (a factor that exists is kept; disabling and new recovery codes stay allowed). The code, link and social completions answer a union (`SignInResult`, `SocialSignInResult`: the session or a `SecondFactorChallenge`), recorded as a sign-in only when a session opened; `confirmSecondFactor` / `recoverSecondFactor` record `session.signIn` by `totp` / `recoveryCode`, and `confirmSecondFactorWithPasskey` by `passkey` (janus-graphql's `passkeyResolvers().Mutation.confirmSecondFactorPasskey`, the same five attempts; clavix-api#293). `requestSecondFactorPasskeyOptions` re-reads the passkey options of a challenge: no attempt is counted, it shares `ctx.passkeyThrottle`, and runs `requireLive` then `requireMethod("passkey")`. A passkey sign-in stays `SignedIn` (a passkey is multi-factor). Console: `updateMfaPolicy` (`edit`, event `mfaPolicy.update`), `TenantUser.secondFactor`, `resetUserSecondFactor` (`edit`, event `user.resetSecondFactor`). `TenantUser.secondFactor` reads through a per-request DataLoader (`second-factor-loader.ts`, `ConsoleUsers.secondFactors`: one `findMany`, the recovery codes of the holders only); the users module resolvers are wrapped in `freshPerMutation`, so a field read after a reset sees the write.
- janus (0.55+) accepts
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
(a graxia plugin, `onContext`, added in `createApp` when `oauth.serverFor` exists) puts the issuers in the context, and
the resolver picks the request host's tenant's OAuth server; the session is that tenant's too.
The same-origin guard is not in this module: it is the HTTP-layer plugin below, so a consent operation refused there still sees `NOT_FOUND`.
`approveOAuthRequest` is fresh-only (5 min, `STEP_UP_REQUIRED`). Step-up (M2): `beforeApprove` runs
`assessment` (`authentication.ts`, over the pure `src/oauth/authentication-level.ts`) for the code and device flows and
refuses with `UNMET_AUTHENTICATION_REQUIREMENTS` (403, extension `missing`); `approveOptions` passes `amr`, `acr` and
`authTime`. A request nothing can meet (`missing` empty: an `acr` Clavix does not issue) is not left pending: `approveOAuthRequest`
is wrapped (`approveOrDenyUnmet`, `consent/index.ts`; `consent/unmet.ts`) and denies it with `unmet_authentication_requirements`
(janus-oauth 0.24), answering `{ redirectTo }` with `error`, `state` and `iss`; a gap the user can close (`SECOND_FACTOR`,
`FRESH_PROOF`, `ENROLMENT`) stays the 403 and the request stays pending for the step-up. The access-token `claims` hook
(`oauth/building.ts`) puts the grant's `acr`, `amr` and `auth_time` in the JWT, the ID token's values (janus 0.76).
A recovery-code sign-in adds `rec` and `mfa` to the first factor's amr (RFC 8176), not `otp`: janus stores it on the session itself (@softistx/janus 0.77), and `mfa.spec.ts` asserts it. A passkey step-up needs no
authenticator app with `passkeys.firstFactor` (janus 0.76). A scope's `label` is the tenant's description of it (`scope-labels.ts`: the
resource's scope, else the standard one; `Accept-Language` French else English, then the other
language, then janus's label), set by our `OAuthRequest.scopes` and `OAuthConnectedApp.scopes`
resolvers because janus-oauth's `scopeLabels` is one static map. Passkeys are the next section.

## Same-origin guard and shutdown

`useSameOriginJson` (`src/http/same-origin.ts`, first graxia plugin of `createApp`, an `onRequest` of this API's own: `sameOrigin()` of `@softistx/alxia-graphql` is gone, and graxia's `csrf` option answers a fixed 403, so it is not used for this; graxia's CSRF header check stays on and runs before it, so a GET or a non-JSON POST carries `x-graphql-csrf: 1` to reach it) guards **every**
`/graphql` operation once: a foreign `Origin`, `Origin: null` or a non-JSON POST is answered before
parsing, with no CORS header: consent operations (`CONSENT_FIELDS`) get 404 `NOT_FOUND`, all others 403
`FORBIDDEN`. Origin and request are compared by host (TLS-terminating proxy); no Origin passes (the cookie
is `__Host-`). A new operation needs no guard of its own; never add a CORS plugin without revisiting this, and `onRequest` does not guard a WebSocket upgrade (`ws` is off: keep it so or guard the upgrade).
On stop, `server.ts` has an `onStop` hook that awaits `drain()` (`src/modules/auth/outbox.ts`, 10 s)
so a code mail in flight is not lost; `stopTimeout` is set above it.

## Signing keys

`src/keys/` holds the per-tenant signing keys on janus (`signingKeysFor`, `jwksFor`, wired in
`src/config/keys.ts`; a tenant's partition is its hex id), the rotation policy and the hourly
`key-rotation` queue (Redis only; without it the pass at server start is the only one). `CLAVIX_KEYS_MASTER_KEY` encrypts them: one key or a comma-separated keyring, first = current (README, "Signing keys"; rotation runbook in `docs/operations.md`: `bun run keys:reseal`, which must cover **every store sealed under the keyring** (signing keys, TOTP secrets, and the `createSecretBox` stores in `SECRET_STORES`, `src/keys/reseal.ts`: each service's `resealSecrets(tenantId)`; a new sealed store adds its entry there, and the old key is dropped only when the report's `oldKeyNeededBy` is empty), and `bun run keys:rotate <tenant>|--all [--drop-old]` for the emergency rotation). `withPublicDocuments` (`src/oauth/public-documents.ts`) serves the JWKS and discovery documents from memory (key `<tenantId>.<version>.<keys generation>`, 60 s TTL, ETag and 304); `createTenantKeys` bumps the generation on every key insert, promote or retire, so a key write goes through `signingKeysFor`; a write from another process (the `keys:rotate` CLI, another instance) shows only when the TTL ends. Sign and
verify through the janus store; never log a key record, never read `oauthSigningKeys` raw
outside the specs.

## Tenants by script

`bun run tenants:create` (`src/scripts/tenants-create.ts`, README "Tenants") creates a tenant by script (the console API's
`createTenant` does too). It only parses flags (`src/modules/tenants/cli.ts`) and calls `registerTenant`
(`register-tenant.ts`), which goes through `TenantsService.create` (the one place for slug rules,
reserved slugs and the first-key hook; never copy them). Idempotent on the slug: same values report
`created: false`, other values are refused, a deleted tenant's slug stays reserved.

## Console API (`src/console`)

The console's own GraphQL API, `POST /console/graphql`, apart from the hosted pages' `/graphql`
(`src/http/schema.ts` and `codegen.ts` leave `src/console/**` out; `codegen.console.ts` generates
`src/generated/console`). No cookie and no Host-based tenant: the credential is a bearer JWT of the
`clavix` tenant whose audience is `https://console.<CLAVIX_DOMAIN>/api`, verified in process by
`server.authenticate(request, { resource })` (`auth.ts`; no crypto of ours, a store outage is a 503,
every other failure a 401). Only the console's own client (`CONSOLE_CLIENT_ID`, `identity.ts`) is
accepted: a console-audience token minted for another client of `clavix` is a 401, whatever its scopes.
- **Permissions** are a janus `defineModel` (`model.ts`) over the relation store in `oauthDb`
  (`config/access.ts`; `db:sync` creates its collection): platform and tenant `owner` / `admin` /
  `viewer`, permits `manage` / `edit` / `view`, a platform role inherited by every tenant through the
  tenant's `platform` link. The link is written when a tenant is created (`config/tenancy.ts`
  `onCreated`) and backfilled by the `2026-11-12-console` migration.
- **Deny by default** (`guard.ts`): every root field is wrapped, and one without an entry in its
  module's `guards` (`signedIn()`, `onTenant(perm, args => tenantId)`, `onPlatform(perm)`) is refused
  `FORBIDDEN`. A spec enumerates the real root fields. A new field ships with its guard.
- **Writes on the `clavix` tenant are the platform's** (`guard.ts`, `allowed`): an `onTenant` guard
  with `edit` or `manage` whose target is the `clavix` tenant itself asks `canPlatform` instead of
  the tenant role (operators, the issuer's domains, sign-in policy, clients, branding and users
  are all behind it); `view` stays tenant-level. It is central, so no module opts in: the rule is
  `permitted` (`guard.ts`), which the audit export's route uses too (`log=auth` on `clavix` is the platform's `edit`); a new way into the console that checks a role goes through it, never `access.can` bare. A tenant-level
  role on `clavix` never writes there (`modules/platform-writes.spec.ts`). Deleting a `clavix` user
  also removes their console relations (`access.removeUser`); every mutation that changes the account of a `clavix` user
  who holds a platform role or owns a tenant needs platform `manage` (`keepOwners`, `users/operators.ts`: disable, enable,
  delete, `revokeUserSessions`, `setUserEmailVerified`, `resetUserSecondFactor`). A new user mutation goes through it with its `OwnerChange` kind.
- **A slice adds a module** under `src/console/modules/<name>/` (SDL, resolvers, guards, the audit
  action of each mutation: "Admin events" below) and lists it in `modules/index.ts`; the SDL lives
  there, never in `src/modules`.
- **`clients` and `resources`** (issue #9) are thin: resolvers call `ClientsService`
  (`src/modules/clients`, wired in `src/config/clients.ts`) and `Catalog`
  (`src/modules/resources`), after `liveTenant` (`catalog-support.ts`: a suspended tenant is
  readable, its writes are refused by the guard; a trashed one is `NOT_FOUND`). Queries are `onTenant("view")`, mutations `onTenant("edit")`; each mutation records
  its admin event (`client.create`, `client.rotateSecret`, `resource.delete`, `scope.update`, ...:
  the target is the client id or the document id, never a secret; a delete records on a repeat
  too, and `deleteResource` one `scope.delete` per scope it removed). The `operators:grant` script records
  `operator.grant` the same way (platform target, no tenant). `test/console.ts`
  (`consoleAs(userId)`) runs the real console app with a stubbed token check.
- **The console's own client and resource** (`console` in the `clavix` tenant, the migration's) are
  refused by `modules/reserved.ts`: no update, rotation or deletion of the client, no deletion of
  the resource or its scopes through the API (it would lock every operator out); scripts still can.
- **Clients are listed from the janus store** (`ClientsService`, `src/modules/clients`): the
  tenant's partition store answers `listClients` in id order, and each record is mapped to a
  `ClientView` there, so a `secretHash` never reaches a resolver or a GraphQL type. The store has
  no search: `q` is applied by `listClientViews` (`client-listing.ts`), which reads what the page still lacks until it is full
  (at most 20 reads, then a short page with its cursor), so the store's cursor stays the page's. `totalCount` (`countClientViews`, same filter, every page read at 100) ignores the cursor.
  `deleteClient` deletes the client, then calls `revokeClientGrants` (grants and tokens), on a
  repeat too. `Client.grantTypes` shows what the record holds, and janus-oauth 0.13 enforces it (`unauthorized_client` on `/authorize`, the code exchange and the refresh grant); the console sends no list, so a console client takes the default `authorization_code` + `refresh_token`. The store
  has no insert-only write, so `createClient`, `updateClient`, `rotateClientSecret` and `deleteClient` run under `ctx.exclusive(clientsKey(tenant), ...)` (a racing delete never brings a client back; an update or rotation of a missing client is `NOT_FOUND`, from `ClientsService.require` inside the lock; `refuseAgent` (`client-agents.ts`) answers `NOT_FOUND` first for an agent on `updateClient`, `rotateClientSecret` and `setClientTokenExchange`, before any validation; agent reads are bounded by the ids resolved: `kinds`/`registeredAt` take them, `AgentsFor(request, clientIds)`)
  (`console:clients:<hex>`, the same queue and Redis lock as the admins): the id check and the
  upsert of two creations of one id are never interleaved (one wins, the other is `CONFLICT`), and
  the `clients` quota (`assertClientQuota`: `usageService.count` against `quotasOf`, `QUOTA_EXCEEDED`)
  is read under it, so concurrent creations cannot pass the limit together. `deleteClient` leaves a
  record that is not a registered one (`source` other than `registered`: a metadata-document client)
  alone and answers false, and records `client.delete` only for a registered client or for a valid id
  that names nothing (a retry may be the event the first run missed); an id no client can have, and an
  untouched foreign record, name nothing to record. A deleted client's grants are revoked, so its
  access and refresh tokens stop working (`clients.spec.ts`).
- **Admins of a tenant and invitations** (`modules/admins/`, README "Admins of a tenant"): a
  membership is a relation (`access.holders` / `grantTenant` / `revokeTenant`). Every write of a
  tenant's memberships runs under `ctx.exclusive(membersKey(tenantId), ...)` (`exclusive.ts`: a queue
  per key in the process, plus the app's Redis lock when there is one, `config/exclusive.ts`): the
  relation store has no conditional write, so the last-owner check (`LAST_OWNER`) only holds under it.
  Go through `changeRole` / `removeMember` (`service.ts`); never grant or revoke a tenant role bare.
  **One owner rule** (`otherLiveOwners`, `service.ts`): an owner counts only while they exist and can
  sign in (`directory.findUser(...).active`). `setRole`, `keepOwners` (`users/operators.ts`: disable,
  delete and un-verify of a `clavix` user (`OwnerChange`; `touch` checks the caller only, no count), tenant ownerships and the last live platform owner, under
  `PLATFORM_OWNERS_KEY` then the members locks) and the accept hooks (`accept.ts`: no `owner` for a
  ghost, a deleted or disabled inviter) all use it. A repeat `disableUser` or un-verify is never `LAST_OWNER`.
  Invitations are **not** the console's own: `src/invitations/tenant-invitations.ts`
  (`createTenantInvitations`, wired per tenant by `invitationsOf` in `src/config/invitations.ts`) issues,
  mails, lists and revokes the invitations of any tenant's user pool, and a users slice reuses it
  (never copy it). An admin invitation is one of the `clavix` tenant under the scope
  `adminScope(tenantId)` (`src/invitations/scope.ts`, `admin:<id>`); **only that scope grants a console
  role**, so an invitation into a pool (the `clavix` pool included) uses any other scope. Accepting is
  the hosted `/graphql` (`src/modules/invitations`, `invitationPreview`, `acceptInvitation`, every
  refusal `INVITATION_INVALID`); what acceptance checks and grants are janus's `beforeAccept` /
  `onAccepted`, given per tenant by `invitationHooks` (`src/config/users.ts`; on `clavix`:
  `adminInvitationHooks`, which refuses a suspended or deleted tenant and grants the relation).
  `resend` (`resendAdminInvitation`) sends a pending invitation again through janus's `resend`: a new
  code and lifetime, `resentBy` set, the original `invitedBy` kept (the console reads it from the stored
  invitation and resolves the name from the directory). The cooldown (`RESEND_COOLDOWN_MS`, 60 s) is read
  from janus's `updatedAt`, so it holds across processes with no Redis; the check and the write run under
  `ctx.exclusive` per invitation. Refusals are `ResendRefusedError` (`NOT_FOUND`, `INVITATION_NOT_PENDING`,
  `RESEND_TOO_SOON` with `retryAfter`). A users-pool invitation has no resend yet.
  `invite` is guarded by `guardInvite` (`src/invitations/invite-guards.ts`, from the stored pending list, so no Redis and
  it holds when Redis is down): re-inviting an address inside the cooldown is `INVITE_TOO_SOON` (`retryAfter`), a new
  address past `CLAVIX_INVITE_PENDING_LIMIT` (500 per scope) is `PENDING_INVITATIONS_LIMIT`; both are `ResendRefusedError`s
  that `refusing` maps (429 / 409). Not atomic. The Redis budgets (`CLAVIX_INVITE_*`) stay fail-open, as the audit export.
  Its events are `membership.invite` / `.resendInvitation` / `.revokeInvitation` (target `invitation`) and `membership.change`
  / `.remove` (target `user`), recorded outside the lock once the change is stored; the resolvers
  canonicalise `tenantId` (24 hex, lower case) and bound the ids first, so `ctx.audit` cannot refuse
  after a write. Accepting (hosted, no console caller) records none.
- **The migration** `2026-11-12-console` (`src/migrations/console-seed.ts`) registers the console
  resource and the confidential client `console` (redirect URI `<console origin>/console/auth/callback`,
  an assumption until the UI slice settles it) in the `clavix` tenant. The client secret is printed
  once by the migration (not in tests).
- **`bun run operators:grant --email <address> [--role owner|admin|viewer] [--create]`** gives a user
  of the `clavix` tenant a platform role (default owner), until the console can. The user must exist,
  unless `--create`: an unknown address is then invited (operator scope, `operatorScope()`, issued by
  the system, mailed by the tenant's mail path) and accepting the invitation makes the account and
  grants the role (`adminInvitationHooks`, under the user's `userKey` lock, inside the tenant's members lock, the order `keepOwners` keeps: platform owners, members by id, user). A disabled account is refused: the active check and `grantPlatform` run under the user's `userKey` lock (`grantOperator`'s `lock`, wired by the script with `exclusive`), on a fresh read, so a `deleteUser` or a disable cannot slip between them (#182). Each run records the admin event `operator.grant`.

### Admin events (`src/console/audit.ts`, `src/console/admin-events/`)

Every console mutation writes an append-only admin event (ADR-0037). The platform's own changes with no console user write one too, under a `system:<module>:<job>` actor (`domain.lapse`, `domain.evict`: see Custom domains). A slice that adds a mutation
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
  nothing twice and records the event the first one missed. So `createTenant`, `createClient` (`clientSecret: null`), `createRole`, `createResource` and `createScope` return the stored record, not `CONFLICT`, when a repeat has the same values. Never `void` it or catch its error. The declaration is not
  checked against the call: the slice's own spec asserts the stored event.
- **Never a secret**: an event is identifiers only (`target` is `{ type, id }`). The schema is
  closed (`z.strictObject`, no free-form field), so there is no place for a secret, a token or the
  before/after of a value, and none is to be added.
- **Sign-in events (M4 E1, D12-D18)**: `src/events/` is the event bus (`createEventBus`: every
  subscriber awaited, a failure reported and swallowed, so an event never fails its caller, D13;
  `config/events.ts` counts failures in `eventFailures`); `authEvents` (`modules/audit/`, tenant-owned,
  closed schema, `scopeToTenant` only) is written by the `authRecorder` subscriber. Sources: the hosted
  sign-in resolvers through `recordingSignIn` / `recordSignOut` (`modules/auth/sign-in-events.ts`: code,
  magic link, passkey, social), and the per-tenant janus `events` listener (`events/janus-listener.ts`:
  second factor, recovery codes, passkeys; no address). A new type goes in `AUTH_EVENT_TYPES` (closed).
  OAuth events (M4 E3, D14): `createClavixOAuthIssuers({ eventsFor })` gives each tenant's issuer its own janus-oauth `events` listener (`events/oauth-listener.ts`, built per tenant and dropping an event of another issuer; wired in `config/oauth.ts`): `consent.granted` / `.denied`, `grant.revoked`, `refreshToken.reused`, `device.approved` / `.denied`, `token.exchanged`, `client.registered`, with client and user, no address, no client name; `oauth.client.loginFailed` is not recorded (telemetry's).
  Reads: console `authEvents` (`edit`, an admin: addresses) and `adminEvents` (`view`), and by id
  `authEvent(tenantId, id)` / `adminEvent(tenantId, id)` (same permissions; `null` for an unknown or
  another tenant's id, `find` on the reader and the service),
  `platformAdminEvents` (operators). The full IP stays in `authEvents` only (D15). Retention
  (`modules/audit/retention.ts`, queue `audit-retention`, 04:17 UTC, `config/audit-retention.ts`) cuts by the
  tenant's current plan (`Plan.auditRetentionDays`) as `system:audit:retention`, with no event per deletion.
- **Export (M4 E2, D17)**: `GET /console/audit/export` (`src/console/audit-export/`: `export.ts` handler, `params.ts`, `columns.ts`, `body.ts`, `serveAuditExport`, mounted
  by `createApp` beside `/console/graphql`, in the Caddyfile `@api` matcher) authenticates like the GraphQL API
  (`authenticated` in `plugin.ts`, the DPoP proof's `htu` being the export path), then a verified e-mail, `view`
  for `log=admin`, `edit` for `log=auth` (through `permitted`, so the platform's `edit` on the `clavix` tenant). The range is cut to the plan's retention, at most 100 000 rows
  (`ConsoleDeps.auditExport` overrides it in a spec; `exceeds` reads at most one row past the limit, no full count), a per-tenant budget (`throttle.ts`, limit `auditExport`, `CLAVIX_EXPORT_TENANT_*`, 429; Redis only, down: allowed and logged), streamed with `reader.stream` / `authEventsService.stream`
  (`modules/audit/stream.ts`, 500 rows per batch, one row per pull). `auditLog.export` is recorded, awaited,
  before the first byte. CSV cells go through `csvCell` (formula guard). `ConsoleDirectory.tenantsByIds` carries the `plan`.
- `adminEvents` is a platform collection: its `tenantId` says which tenant an event is about, so it
  is listed in `platformCollections` (`src/tenancy/owned.ts`) and left out of the tenant-owned
  guards. It is reached only through `AdminEventRecorder.record` (`src/config/admin-events.ts`); a
  source scan in `src/tenancy/guards.spec.ts` refuses any other access or export. Indexes (`tenantId, at` and `actor, at`,
  newest first) are the definition's, created by `db:sync`. Read through `AdminEventReader`
  (`src/console/admin-events/reader.ts`, `ConsoleExtras.activity.admin`: `adminEvents`, `platformAdminEvents`,
  the retention's `deleteBefore`). `ConsoleDeps.adminEvents` takes another recorder in a spec.
- The request id is minted per HTTP request by the console plugin; a client's `x-request-id` is
  never used.

## End-user roles (`src/modules/roles`, `src/console/modules/roles`)

A role is a named claim value a tenant gives to its end users (not a console admin role, which is
`access`). Two tenant-owned collections (`roles.model.ts`, purged with the tenant by `ownedPurgers`):
`roles` (name, description, `resourceId`, unique `{tenantId, resourceId, name}`) and
`roleAssignments` (`roleId`, `userId`, unique `{tenantId, roleId, userId}`). Everything goes through
`RolesService` (`src/config/roles.ts`, `scopeToTenant`); the module is in the direct-access allow list of
`tenancy/guards.spec.ts`.
- **The claim**: `claimRoles(tenantId, userId, audience)` returns the sorted, de-duplicated names of the
  tenant-wide roles plus those scoped to the resource whose `uri` is the audience. `RolesFor`
  (`oauth/ports.ts`) is the port; `building.ts` puts it in janus's `accessTokens.claims` (runs on every
  exchange and refresh, so a refreshed token carries the current roles) and `issuers.ts` in the id_token
  and `/userinfo` (`scopeClaims: { openid: ["roles"] }`, `idToken.includeClaims`). No scope is needed. A
  role scoped to resource X is in a token for X only; the id_token and userinfo have no audience, so they
  carry the tenant-wide roles only. `includeClaims` also puts the e-mail and profile claims in the id_token.
- **Console** (`roles` module): reads `onTenant("view")`, writes `onTenant("edit")`; audit actions
  `role.create|update|delete|assign|unassign` (assign and unassign record the role and the user). `deleteRole`
  and `unassignRole` are idempotent; `assignRole` needs a user of the tenant's pool (`NOT_FOUND` else).
  `deleteRole` removes the assignments first, `deleteUser` and `deleteResource` remove theirs (a retry
  finishes a half run). `assignRole` (check the user, write) and `deleteUser` (delete, sweep) run under
  `ctx.exclusive(userKey(tenant, user))` (`console/modules/user-key.ts`), so no assignment outlives its
  user; `disableUser` (platform users) and the `clavix` invitation accept hooks (`userLock`) take it too. `memberCount` of a list comes from one grouped query (`memberCounts`), not one count per role (it counts rows, so a user janus no longer has still counts until swept). `delete` removes the role first, then sweeps its assignments (on a repeat too), so `assign`'s re-check covers every ordering.
  **Managed roles** (#207): `roles.managed` (default `false`) marks a role Clavix provides; only `RolesService.create(…, { managed: true })` sets it (never the console input). `update` and `delete` refuse it with `RolesError("ROLE_MANAGED")` (403); the cascade of a deleted resource still removes it. `TenantRole.managed: Boolean!` exposes it.
  `roles.input.ts` holds the input checks, `role-claims.ts` the claim join, `catalog-support.ts` the one `refusing` for `CatalogError` and
  `RolesError`.
- **Shared helpers**: `console/modules/ids.ts` (`tenantArg`, `tenantIdOf`, `idArg`, and `liveTenant`: a suspended tenant is returned, a trashed or unknown one is `NOT_FOUND`).
  A tenant trashed mid-request is `NOT_FOUND` in the users module too (`TenantUnavailableError`).
- **A suspended tenant's console is readable, not writable** (ADR-0039, #167): `ConsoleDirectory.tenantsByIds`,
  `TenantsService.liveByIds` and `SignInPolicyService.get` return active and suspended tenants (not the trash);
  every read of every module works for the tenant's admins, and `Me.memberships` lists it with its `status`.
  The write refusal is central, in `console/guard.ts`: a `tenant` guard with `edit` or `manage` on a
  suspended tenant throws `TENANT_SUSPENDED` (403) after the role check (a caller with no right still gets
  `FORBIDDEN`), unless the caller holds the same permission on the platform (support; `updateTenant` by an
  operator keeps working). The platform's `suspendTenant`, `resumeTenant`, `deleteTenant`, `restoreTenant` and
  `setTenantPlan` are `onPlatform` guards and never reach it. A new write on a tenant needs nothing
  more than its `onTenant("edit" | "manage")` guard. `activeByIds` (status active only) stays for the
  sign-up and invitation paths.
- **The console needs a verified e-mail** (ADR-0041, #179): `console/guard.ts` refuses every root
  field whose guard is not `aboutCaller()` (only `Query.me`) with `EMAIL_UNVERIFIED` (403), before the
  role check, through `requireVerifiedEmail` (`src/users/verified-email.ts`, reusable by the
  future e-mail change) and `ConsoleDirectory.emailVerified(id)` (false for an unknown user, throws when the clavix tenant is unavailable), read once per request
  (`callerProved`). `Me.memberships` and `Me.switchableTenants` call `verifiedCaller` themselves: they
  are tenant data under the open `me`. `signedIn()` also needs the proof; a new field never opts out. Operators are held to it (the
  ADR-0039 exception is about the target tenant). Accepting an invitation proves the address (janus
  `invitations.accept`; `admins.spec.ts` covers it). Specs: `consoleAs(id)` and `verifiedCallers(deps)`
  in `test/console.ts` count the caller as proved; `console.spec.ts` covers the gate over the real
  wiring.
- `test/oauth-flow.ts` runs a real authorize/approve/token flow against the test database (specs that
  read a token's content).

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
  taken from a closed list, and gets a case in the "break out of the stylesheet" spec. `buildTheme` also refuses the compiled
  CSS when it holds `<`, `@import`, `url(`, `image-set(`, `src(` or a backslash (`assertSafeCss`,
  BAD_USER_INPUT field `css`).
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
  `requestSignInCode`, `verifySignInCode`, `requestMagicLink`, `confirmMagicLink`, `requestEmailVerification`, `confirmEmailVerification`, the passkey sign-in, `requestSecondFactorPasskeyOptions`,
  `socialSignInStart`, `socialSignInComplete`, `acceptInvitation` (on the tenant's own host: an end-user invitation of a suspended tenant is refused before the code is read),
  and `/authorize` and `/token` (`oauth/tenant-state.ts`, a 403 JSON `access_denied`, not a redirect).
  Discovery, jwks, userinfo, introspect, revoke, `signOut` and `currentUser` keep answering: tokens
  already issued live to expiry, and the console stays readable.
- **Plans** (`plan.schema.ts`): `free`, `pro`, `enterprise`; `effectiveQuotas` = plan, then the tenant's
  `quotaOverrides` (setting a key to `null` removes the override; an override cannot express "no limit").
- **Usage** (`UsageService`, `config/usage.ts`): monthly active users are a Redis unique counter
  (`clavix:usage.mau`, 400 days), counted at sign-in, passkey and social sign-in and a successful `/token` (the `sub`
  of a user's access token, so refreshes count; a client_credentials token, whose `sub` is its client id, counts nobody) and an `acceptInvitation` that signs the new account in (#176); `recordActive` never throws. Without `REDIS_URL` nothing is counted (the stored month is read). The month is snapshotted in
  `usageCounters` (tenant-owned) when read, never lowered. Clients are counted in
  `oauthPartitionedClients` by `partition`; domains are counted from `domainStore`. `assertWithinQuota`
  / `QuotaExceededError` (`QUOTA_EXCEEDED`, 409) is for the hard quotas, used by the creations of
  clients (A2) and domains (A4); MAU is a soft meter (`exceeded`), it blocks nothing.
- **Trash and purge**: `deleteTenant` soft-deletes; `purgeAt` = `deletedAt` + 30 days. `purgeTenants`
  (`purge.ts`) claims (`purgeStartedAt`: it resolves nowhere, cannot be restored), purges the janus
  partition, the tenant-owned collections (`ownedPurgers`, by `isOwned`: `adminEvents` is the platform's
  record and stays), the roles and platform link (`access.removeTenant`), then `markPurged` leaves a
  tombstone (slug, `deletedAt`, `purgedAt`) that keeps the slug reserved. The Redis MAU counters (hashed, no user ids) are not deleted: they expire on their own after 400 days.
  A failing tenant stays
  claimed and the next run resumes it. **The janus part** is `createPartitionPurger(oauthDb)`
  (`src/config/partition-purger.ts`, the `PartitionPurger` port): `purgeMongoOAuthPartition`,
  `purgeMongoStoresPartition` and `purgeMongoInvitationsPartition` for the tenant's partition (its hex
  id), refusing `default` and empty; it answers the counts per collection, which the job logs. **Scheduled**
  by the `tenant-purge` queue (`purge-queue.ts`, daily cron `17 3 * * *`, `purge-worker.ts`
  `startTenantPurge` in `src/server.ts`, one pass at start; without Redis only that pass). Only
  tenants deleted 30 days ago or more are touched. A new tenant-owned
  collection needs nothing here, but is a purge target: keep it behind `tenantOwned`.
- **Console API**: `tenants`, `tenant`, `plans`, `usage` and the seven mutations are in
  `src/console/modules/tenants`, with their audit actions (`tenant.create`, `.update`, `.setPlan`,
  `.suspend`, `.resume`, `.delete`, `.restore`). Only `updateTenant` is open to a tenant admin (refused with `TENANT_SUSPENDED` while the tenant is suspended); the rest
  is platform-only. The `Tenant` parent is `TenantParent` (codegen mapper), so `Me.memberships` keeps
  working with the extended type.
- **Still public for a suspended or deleted tenant**: the anonymous `tenantBranding` and the logo by host
  (a hosted page can show its suspended screen); `createTenant` repeated with the same slug, name, plan
  and sign-up returns the tenant and records the event again (a retry after a failed record).
  Dynamic registration is per tenant (`oauth.agents.dynamic`); `tenant-state.ts` refuses `/register` for a suspended tenant (`REFUSED_PATHS`).
  `subjectAgents` (a client's token exchange rules) lets it exchange the tokens of the tenant's agents; `AgentCheckFor` (`src/oauth/ports.ts`) tells an agent apart, from the tenant's own scope.

## Custom domains (`src/modules/domains`, `src/console/modules/domains`)

A tenant adds a host (`addDomain`), publishes `_clavix.<host> TXT clavix-verify=<token>`, then
`verifyDomain` reads it through the `TxtResolver` port (`dns.ts`; specs inject a fake, only
`src/config/domains.ts` wires the real resolver). `DomainStore` (`domains.service.ts`) is the
only way into the `domains` collection; the periodic recheck is `DomainRecheck`
(`domains.recheck.ts`, the DNS comparison `domains.check.ts`), which the store builds and delegates to.
- `domains` is a **platform** collection (like `adminEvents`): a verified host is unique across
  tenants (partial unique index on `{ host }` where `status: "verified"`), which the
  tenant-owned "every index starts with `tenantId`" rule cannot express. Every query still
  carries `tenantId` except `tenantOfHost`/`verifiedHost`, the resolver's and the TLS ask's lookups.
- The token is 32 random bytes, bound to its own claim (tenant and host). Several tenants may
  hold a pending claim on a host; the first to verify wins and evicts the others. A host
  verified elsewhere is `DOMAIN_TAKEN`. Hosts are normalised (case, trailing dot, IDN to
  punycode); IPs, localhost, wildcards, reserved suffixes and the platform domain are refused.
- The quota (`effectiveQuotas(...).domains`) counts pending claims too and is checked on
  `addDomain` (`assertWithinQuota`), which runs under the tenant's `ctx.exclusive` lock
  (`console:domains:<tenantId>`, shared by `removeDomain` and `setPrimaryDomain`, so two
  concurrent `setPrimaryDomain` leave one primary); the post-insert recount stays as a second guard.
  `removeDomain` records `domain.remove` on a repeat too (an id the trail cannot hold is not recorded).
  `usage.domains` is `domainStore.count`. These slice decisions stand (issue #127): pending
  claims count toward the quota; a lapsed primary keeps resolving but the TLS ask refuses it;
  recheck every 6 h with a 7-day grace.
- `verifyDomain` is held to one check per claim per 60 s (`VERIFY_COOLDOWN_SECONDS`, from the
  claim's `checkedAt`): `VERIFY_COOLDOWN` (429) with `extensions.retryAfter`, no lookup made.
- The platform's own changes are admin events too: `domain.lapse` (recheck, actor
  `system:domains:recheck`) and `domain.evict` (a verification removing another tenant's claim,
  actor `system:domains:verify`), recorded through `DomainStoreOptions.record` (`events.ts`,
  wired in `src/config/domains.ts`); a failure to record is logged, never fails the write.
- The primary is explicit (`setPrimaryDomain`, ADR-0032); the issuer follows it (resolver
  `toResolved`), the passkey rpId stays the slug host (`slugIssuer`, `src/users/rp.ts`,
  ADR-0036). The primary cannot be removed. The slug host keeps serving.
- `recheckAll` runs every 6 hours (`recheck.queue.ts`, started in `src/server.ts`). A record
  missing for 7 days makes the domain `unverified` (it stops serving and no certificate is
  issued) and the tenant's owners are e-mailed once (`notice.ts`). A lapsed primary keeps its
  flag and keeps resolving: the issuer never moves silently. A DNS failure changes nothing.
- A host that maps to a non-live tenant behaves like the default host: callers check `isLive`.
- **TLS ask** (`tls-ask.ts`, `GET /internal/tls/ask?token=&domain=`): 200 only for a verified
  domain of a live tenant or a platform host (apex, `console.`, the slug host of a live tenant: `allowedPlatformHost`), 429 past `CLAVIX_TLS_ASK_LIMIT`/min (`@softistx/redis`; **fails closed**
  when Redis is down: refused, with a warning, `tlsAskGate`; **spent after the lookup**, by known hosts only, so a flood of unknown names
  cannot use up the budget real domains need, #328), a bare 404 for everything else (wrong or unset `CLAVIX_TLS_ASK_SECRET`,
  proxied requests carrying `X-Forwarded-*`, `X-Real-IP` or `Forwarded`, garbage, unknown, pending, lapsed, suspended).
  The app has one listener: keep `/internal/` off the public proxy (`deploy/Caddyfile` does). No ACME client lives here. Going live (Dockerfile, `deploy/`, `scripts/mongo-*.ts`, `/readyz`) is in `docs/operations.md`.
- `/.well-known/webauthn` on a live tenant's slug host lists its verified domains' origins
  (Related Origins). The passkey layer accepts the same origins (`relatedOriginsOf`, `src/modules/domains/well-known.ts`).

## Webhooks (`src/modules/webhooks`, `src/console/modules/webhooks`, `src/config/webhooks.ts`)

A tenant posts its events to its own endpoints (M4 W1, D19-D22, issue #22).
- `webhookEndpoints` is tenant-owned: reached only through `WebhookEndpointsService`
  (`scopeToTenant`; the files allowed in `guards.spec.ts` are `src/modules/webhooks/` and
  `src/config/webhook-endpoints.ts`). Its quota is `webhooks` (free 2, pro 10, enterprise 50),
  checked on create under `ctx.exclusive("console:webhooks:<tenantId>")`.
- One process-wide `webhooks()` (`delivery.ts`, wired in `src/config/webhooks.ts`) serves every
  tenant: its endpoint resolver reads the endpoints of `event.data.tenantId` at each attempt, so a
  rolled secret or a switched-off endpoint is honoured by a retry, and another tenant's events never
  reach an endpoint. It is a bus subscriber (`relay`); the queue is Redis (`createRedisWebhookQueue`,
  prefix `clavix:webhooks:`) when `REDIS_URL` is set, memory otherwise; `server.ts` closes it on stop.
- **Queue caps (G2-03, nxgt-janus #974/#982)**: `webhookQueueLimits` (`src/modules/webhooks/delivery.ts`, applied in `src/config/webhooks.ts`) gives both
  queues (Redis and memory) `maxInFlight` (`CLAVIX_WEBHOOKS_MAX_IN_FLIGHT`, 4), `maxPending`
  (`CLAVIX_WEBHOOKS_MAX_PENDING`, 5000) and `groupOf`. **Assumed, not answered**: the caps are per tenant, not
  per endpoint, because janus-webhooks counts per group once `groupOf` is set (one queue cannot cap both). So the
  queue's endpoint name is `<tenantId>.<endpointId>` (`queueEndpointId`, `webhookGroupOf`, `endpointIdOf` in
  `delivery.ts`): the resolver adds the prefix and every callback strips it before it touches a store. The
  claim also rotates over endpoints, so one endpoint of a tenant does not take the tenant's whole share.
- **Console budgets (`src/console/budgets.ts`, #328)**: `ctx.budgets` (`ConsoleDeps.budgets`; undefined without Redis) holds the
  `@softistx/redis` limits of the console mutations that act outside the platform. `sendTestWebhook` spends
  `budgets.testWebhook` (5/min per endpoint, then 20/min per tenant, `CLAVIX_WEBHOOK_TEST_*`) once the endpoint is found
  and enabled, before the address check and the queue. `inviteUser` / `inviteAdmin` spend `budgets.invitation` (200/h per
  tenant, both together, `CLAVIX_INVITE_TENANT_*`) just before the invitation is issued, and the per-caller budget
  (60/h per mutation, `CLAVIX_INVITE_CALLER_*`) is `@softistx/alxia-graphql`'s `fieldRateLimit` (`useInviteBudget`, first in the
  console's plugins in `app.ts`), which counts every aliased selection before anything runs. Refusal: `RATE_LIMITED` 429,
  `extensions.retryAfter` and `Retry-After`. Redis down: allowed and logged, as the audit export. A new console mutation
  that sends a mail or queues outbound work gets its budget here, never a counter of its own.
- The catalogue (D22, `events.ts`) is janus's 16 user events (without `user.apiKeyCreated` / `user.apiKeyRevoked`, which never fire until API keys are adopted, and `user.passwordReset` / `user.passwordChanged`, which cannot fire while password sign-in is unavailable; #336) plus `session.signedIn`; `data` holds ids
  only, never an address or an e-mail (D15). `tenantId` is in `data` because the wire body has no
  top-level field for it. Console admin events are not delivered. `webhook.test` is outside the
  catalogue and goes to one endpoint, whatever its types.
- Secrets (D19): `whsec_`, sealed with `webhookSecretBox` (its own subkey label) with the context
  `<tenantId>:<endpointId>`, returned once by `createWebhookEndpoint` and `rollWebhookSecret`. A roll with
  `keepPrevious` keeps the old secret signing for 24 h (both signatures sent); without it, it is dropped
  at once. `webhookSecretsPrune` (daily 04:37) removes expired ones; they are ignored at send time anyway.
- URL policy (D21, `url-policy.ts`): `https`, no credentials, public addresses only, checked on save
  and again by `guardedFetch` on every send (a DNS rebinding is refused; redirects are never followed).
  `CLAVIX_WEBHOOKS_ALLOW_PRIVATE` lifts the address check for development and is refused in production.
  A check and the connection resolve the name separately (documented in `url-policy.ts`).
- Auto-disable (D20): 5 given-up deliveries in a row (`retriesRanOut` only; a 2xx resets the run)
  switch the endpoint off, record the admin event `webhook.disable` (actor `system:webhooks:disable`)
  and e-mail the owners (`notice.ts`, origin only). An admin switches it on again with
  `updateWebhookEndpoint(enabled: true)`, which re-checks the address.
- Deliveries log (W2): `onAttempt` writes `webhookDeliveries` through `WebhookDeliveriesService`
  (tenant-owned, same allowed files): event id and type, attempt, status or failure name, duration,
  `delivered`, `willRetry`, `at`; never the URL, a header or a body. A TTL index on `at` (7 days) and a trim
  to the newest 100 per endpoint on each write; a failed write is only logged. `WebhookEndpoint.deliveries(first:)`
  reads them (parent `WebhookEndpointParent` carries the tenant id); deleting an endpoint deletes its attempts.
- Admin events: `webhook.create|update|delete|rollSecret|test`; none carries a secret.

## Enterprise OIDC connections (`src/modules/connections`, `src/console/modules/connections`, `src/config/connections.ts`)

- A tenant registers upstream OIDC identity providers (F1 of M4, Part of #19). `connections` is
  tenant-owned (`src/modules/collections.ts`, allowed files in `src/tenancy/guards.spec.ts`):
  `connectionId` unique per tenant, `domains[]` (`domain`, `txtToken`, `verifiedAt`), and a partial
  unique index on a verified-and-enabled domain per tenant.
- The client secret is sealed (`connectionSecretBox`, label `connection-secrets`, context
  `<tenantId>:<connectionId>`), never returned, logged or put in an admin event.
- Every admin input goes through janus-social's `checkConnection` (`connections.record.ts`): its
  `checkConnection:` TypeError becomes `BAD_USER_INPUT` with the field names, no values. Ids `google`,
  `github`, `microsoft` are refused (they are the static apps). `emailTrust` offers `claimAndDomain`
  and `domain` only. `upstreamMfa.acr` is enforced (D6): it becomes the connection's `stepUp.acrValues`, so an ID token without that `acr` is `SOCIAL_STEP_UP_UNMET`.
- `ConnectionsService.sourceOf(tenantId)` is the janus `ConnectionSource`; `tenant-janus.ts` wires it as
  `social.resolveProvider` through `oidcConnections` (one redirect URI per connection:
  `<issuer>/sign-in/social/<id>/callback`, the hosted UI's callback route). Every tenant's janus instance carries it, so the static-social
  gate in `sign-in-methods` also checks the tenant's offered providers.
- Domain ownership: `addConnectionDomain` returns a TXT name `_clavix-sso.<domain>` and token;
  `verifyConnectionDomain` reads the TXT (60 s cooldown) and can be asked again. A domain is claimed
  by one enabled connection per tenant (`DOMAIN_TAKEN`).
- Quota `connections` (free 1, pro 5, enterprise unlimited; `plan.schema.ts`, usage, console `Quotas`).
  A connection with linked users is not deleted (`CONNECTION_IN_USE`).
- **IdP mix-up (RFC 9207, nxgt-janus#979, G2-05)**: the record's `requireIssParameter` is stored as `requireIss`
  (`connections.service.ts`): pinned at create, and again when the issuer changes, from the issuer's metadata
  (`advertisesIss`, janus's `advertisesIssParameter`; unreadable means not pinned; connections created before are not backfilled, the library still requires `iss`
  whenever the metadata advertises it). Each connection has its own redirect URI
  (`ssoCallbackUrlOf(issuer, id)`: janus-social's function form, nxgt-janus#975), and `socialResolvers`'s
  `bindCallback` (janus-graphql 0.35, nxgt-janus#987; `sign-in-methods/index.ts`) binds the callback to the
  connection whose URL received it (`bindSsoCallback`), so an identity provider cannot pass a visitor's flow to another
  one even without `iss`. The id is the path of `callbackUrl` (`connectionIdOfCallbackUrl`) and must equal the
  `x-sso-connection` header the BFF sets from its own `:provider` route parameter (it forwards no browser header);
  a missing or disagreeing pair binds nothing, which a connection's flow refuses (fail closed). Register
  `<issuer>/sign-in/social/<id>/callback` with each identity provider.
- Admin events: `connection.create|update|setSecret|delete|addDomain|verifyDomain|removeDomain`.
- **Home-realm discovery and sign-in (F2)**: hosted `hostedHomeRealm(email)` (`modules/connections`) names the one
  enabled connection owning the address's verified domain (`ownerOf`: two claimants answer none), else null; it
  spends its own `homeRealmThrottle` (IP and tenant; `socialSignInStart` spends `ssoStartThrottle`: `sign-in-methods/sso-throttle.ts`,
  `CLAVIX_SSO_*`, refusal `MAIL_THROTTLED`), never the mail-sending `signInThrottle` (#328: a flood of lookups must not close
  a tenant's sign-in codes), and is `no-store`. The federated sign-in is janus's
  `socialSignInStart` / `socialSignInComplete` with the connection id as `provider` (an unknown or disabled one is
  `SIGN_IN_METHOD_DISABLED`); the session is `amr: ["fed"]`. JIT (D4): a new user is created only when the
  connection's `jit` is on, whatever the tenant's `signUp` (`SIGN_UP_DISABLED` otherwise); an existing user is linked.
- **`SSO_REQUIRED` (D3)**: when the owning connection has `requireSso`, `requestSignInCode` and `requestMagicLink`
  refuse (403), and `verifySignInCode`, `confirmMagicLink` and the answer to a second-factor challenge (`confirmSecondFactor`, `recoverSecondFactor`, `confirmSecondFactorWithPasskey`) revoke the session janus just
  opened (by id for a code or link, whose cookie is then never set; for the second-factor answer every non-federated session opened
  since the attempt began, janus-graphql having queued a cookie that now names a revoked session). `signInWithPasskey`
  is refused by janus-graphql's `passkeyResolvers({ signInGuard })` before any session, token or cookie exists. Each runs inside
  `recordingSignIn` so it is a failed sign-in (`sso-gate.ts`). Limits: a static social app (Google, GitHub) and
  `acceptInvitation`'s sign-in are not gated. `login_hint` waits for J2; the callback route is F3.
- `domainOfEmail` is janus-social's (exported since 0.9); `federation.spec.ts` injects `resolveHost`. janus has no
  API to mark `mfa` amr from a federated step-up proof for tenant connections (`oidcConnections` takes no `federatedAmr`
  by design): D6 uses the acr check, and `trustingUpstreamMfa` (`tenant-janus.ts`) wraps the resolved provider with
  `federatedAmr` for a connection whose `stepUp.acrValues` is set, so such a session is `["fed", "mfa"]` (acr `mfa`).

## OAuth clients

`src/clients/` registers a client on a tenant (`registerClient`; `grants.ts` holds the offered grants and `validate.ts` the input checks and `clientIdOf`, both re-exported by `register-client.ts`; the script `clients:create`
in `src/scripts/clients-create.ts`, README "OAuth clients"). It writes through the janus store of
the tenant's partition (`createMongoOAuth(oauthDb, { partition })`), with its own client id as
the idempotency key (janus has no lookup by name); a secret is minted with janus's
`mintOAuthSecret`, shown once and stored as `hashOAuthSecret`. Tenants are read through
`tenantBySlug` (`src/config/tenancy.ts`). `--grants` is stored on the client (`grantTypes`, shown by the console) and enforced by janus-oauth 0.13, which takes an explicit list as written: the script offers five grants (code, refresh, device, token exchange, client_credentials), and a list must name one of `authorization_code`, the device URN, the token-exchange URN or `client_credentials` (`refresh_token` alone is refused), plus `refresh_token` for a client that refreshes. The migration `2026-11-15-client-grants` (`db:migrate`) repairs stored lists written before 0.13. A client keeps its type: re-running a
public client with `--confidential`, a confidential one without it, or `--rotate-secret` on a public
one is refused (docs/troubleshooting.md).

## Green bar

`bun run verify` = `generate`, `check:ci` (Biome), `typecheck` (`bun check`), `test`; CI
(`.github/workflows/ci.yml`, on pull requests into `develop` only) runs it, then `build`.
The `@softistx/*` packages come from npmjs (public): `bun install` needs no token.

## Tests and the machine

A spec connects to no service the CI runner lacks. The skeleton has no store; the slice
that adds MongoDB or Redis starts an in-memory one in `test/setup.ts` (as healthix-api's
does) rather than reading `.env`. A slice runs the specs of the code it changed.

## graxia plugins of this API

An error's `extensions.http.status` and `headers` (a throttle's `Retry-After`) answer the JSON result through graxia
itself (`errorHttp`, on by default since 0.10: highest status wins, `http` is stripped from the body, `spec: true` ignores
the status under `application/json`); no plugin of this API carries it. `useWithoutQuotedValues`
(`src/http/coercion.ts`) scrubs the coercion errors in `onResultChunk` (streams) and `onResponse` (plain JSON). The console is
`useConsole` (`onRequest` verifies the token, `onContext` adds the principal), with its own cost limit (`CONSOLE_MAX_COST`, 50 000 in `app.ts`: the UI's nested reads of stored lists cost more than graxia's default 5 000, and a refused document is a 200 with no `data`; `modules/resources/cost.spec.ts`); `useInviteBudget` is
`fieldRateLimit`, whose 429 and `Retry-After` are graxia's. A client that sends a GET or a non-JSON POST sends
`x-graphql-csrf: 1`. The JSON plugins match `application/json` and `application/graphql-response+json` (parameters
ignored); a `text/event-stream` answer carries no status, as it is sent before any error is known. Unexpected resolver errors and janus 5xx errors go to the app's telemetry
logger (`src/http/unexpected.ts`, `report` of `janusGraxiaMaskError`).
