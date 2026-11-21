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
  `.claude/settings.json`); **schoolz-api is the reference** (its `AGENTS.md` and its
  modules are the worked example). The alignment effort
  ([#401](https://github.com/softistx/clavix-api/issues/401)) put this API on that layout; the
  differences that remain are the named exceptions below.
- **Modules**: `src/modules/<m>/` holds one subject, both faces (hosted and console), in
  `<m>.<role>.ts` files (each when the module needs it): `<m>.graphqls`, `<m>.model.ts`, `<m>.errors.ts` (+ spec),
  `<m>.rules.ts`, `<m>.utils.ts` (the shapes, input mapping and every helper of the module), ONE `<m>.service.ts` per domain
  (no split by action; it may pass 250 lines, but a method stays under 50 lines), resolvers
  `<m>.resolver.ts` split `-queries` / `-mutations` / `-support` / `-guards` when they grow, `<m>.data-loader.ts`,
  and `index.ts`, the only entry other modules import. Other files stay under 250 lines, a function under 80. No helper function at the top of a
  service, resolver or data-loader (it goes to `<m>.utils.ts`). Ports and clocks are passed
  explicitly, never defaulted (`src/config/runtime.ts` binds `clock`, `clockMs`, `janusClock`, `warn` and `reportError` once, at the composition root; only the CLI scripts and the server's startup banner print through `console` directly, and the frozen data migrations read `new Date()`). The same holds for every port: a module never defaults or optionally calls one (`?? (() => {})`, `?.(…)`, `port?: …`, `?? env.X`); every port is required and bound in `src/config/*`, a one-way callback with no consumer is bound to a named no-op there (`src/config/no-ops.ts`: `noInvitationHooks`, `unthrottled`, `unlimited`, `noThrottle`, `noUserThrottle`, `noDetailTypes`, `noBudgets`, `noQueue`; `src/server.ts` is the entry point that picks `noQueue` without Redis), and a service never reads env, config passes the value. Specs pass each port explicitly, through the helpers of `test/ports.ts` (`quietTenants`, `quietDomains`, `quietOAuth`, `quietUsers`, `quietJanus`, `quietKeys`, …). `src/config/app-ports.ts` (`appPorts`) binds the six throttles (Redis when `REDIS_URL` is set, `noThrottle` / `noUserThrottle` otherwise), `scopeTexts`, `detailTexts` and `agents`; `createApp(options: AppOptions)` requires them, `src/server.ts` passes `appPorts`, and specs go through `createTestApp` (`test/app.ts`, the same ports with overrides). The only optional `createApp` options are the entry-point exemption (`oauth`, `console`, `ready`, `ide`, `telemetry`, `requireClientHeader`); the library's `metadataTransport` (janus's own default transport is not exported), `metadataPorts` and `consentUrl` are plain data or a library injection point and stay optional. Known overrun of the 250 lines outside services, to split when touched:
  `config/env.ts` (297).
  `src/modules/index.ts` merges the resolvers, `services.ts` holds the per-request services (D10: the
  process-lifetime objects, such as the janus issuers, keys, `oauthDb`, Redis and telemetry, stay in `src/config/`), `collections.ts` the collections.
- **Console face**: the console's SDL is `src/modules/<m>/<m>.console.graphqls`, its resolvers
  `<m>.console-resolver.ts` (with `-queries`, `-mutations`, `-support`, `-guards` as above), its specs
  `<m>.<topic>.console.spec.ts` (or `<m>.console.spec.ts`). `codegen.ts` and `src/http/schema.ts` exclude `*.console.graphqls` and `src/console/**`;
  `codegen.console.ts` includes them. `src/console/` keeps the transport (`plugin.ts`, `auth.ts`, `context.ts`, `guard.ts`,
  `schema.ts`, `audit.ts`, `budgets.ts`, ...) and `src/console/modules/` only the registry and shared helpers (`ids.ts`,
  `refusal.ts`, `user-key.ts`, `reserved.ts`, `catalog-support.ts`, `issuer.ts`) with their cross-module specs.
- **Layout elsewhere**: `src/http/` holds the context and the schema; `src/config/` reads the environment once (`defineEnv`); the hosted `/graphql` serves its IDE (Apollo Sandbox) and allows
  introspection (`introspection: ide` of `createApp`) only when `CLAVIX_GRAPHQL_IDE` is on (`createApp({ ide })`: on under `bun dev`, off elsewhere, refused in production; the console API has `ide: false`), since the page runs a third-party script on the session cookie's origin; `src/shared/cli.ts` holds what the scripts share (`CliInputError`, `CliTenant`); `src/shared/html.ts` (`htmlEscape`) and `src/shared/values.ts` (`unique`, `isRecord`) hold the small helpers several modules use, and `badInput` lives in `src/shared/errors.ts`. The console's page size is `pageSize(first, fallback = 25, max = 100)` (`src/console/modules/ids.ts`: a list with its own bounds passes them, as `userLookup` (10, at most 20) and a webhook endpoint's attempts (100, the ones kept) do) and its tenant refusals `refusal` (`src/console/modules/refusal.ts`); `src/http/throttle/` is the rate-limit core (below).
- **Generated and printed files**: generated code is in `src/generated/` and `test/generated/` (`bun run generate`, gitignored), never committed. The
  printed schemas `schema.graphql` (hosted) and `console.schema.graphql` (console) are committed: `bun run schema:print` rewrites
  them (sorted, with directives) and `verify` runs `schema:print --check`, which fails when either is stale. clavix-ui syncs its schema copies from them.
- **Import cycles**: `bunx madge --circular --extensions ts --ts-config tsconfig.json src` reports 6 today
  (`webhooks` events/delivery, two cycles; `i18n/codes` with `auth.errors` (through `shared/errors`), one; `i18n/codes` with `sign-in-methods.errors`, one; `console/budgets` with `console/context`,
  `config/connections` with `config/users`); a change adds none (not run by `verify`).
- **Cross-module imports go through the owning module's `index.ts`** (A24, A29). Every import of another module is `@/modules/<m>`, and a module's own files import each other relatively, never through their own barrel; a barrel exports only names another module (or its spec) imports. A deep import (`@/modules/<m>/<m>.<role>`) is allowed only for these, each in the module's `index.ts` header:
  - **the registries** load a role file by file so the barrel never loads it: `modules/index.ts` (the hosted `*.resolver.ts`), `console/modules/index.ts` (the `*.console-resolver.ts`), `app.ts` and `http/schema.ts` (`auth.plugin`, `consent.plugin`, `consent.resolver`), and `modules/collections.ts` (the models registry, keyed as `mongo.db` exposes them);
  - **queues, workers and Redis throttles**, wired by `server.ts`, `config/redis.ts`, `config/redis-limits.ts` and `config/domains-job.ts` (a barrel would load Redis or the worker): `keys.queue`, `keys.worker`, `agents.prune-*`, `audit.retention-*`, `consent.queue`, `domains.recheck-*`, `tenants.purge-*`, `webhooks.secrets-prune-*`, `auth.throttle`, `auth.verification-throttle`, `consent.device-throttle`, `passkeys.throttle` (their limit configs, which the barrel cannot export without closing cycles through `config/redis.ts`);
  - **leaf files** (one rule, A29): a file that imports no service, resolver or barrel of the app, only packages, `shared/` or other leaves (`.errors`, `.schema`, `.model`, `.challenge`), may be imported by file from another module. Importing one never loads the module's services, so it cannot close a cycle through the barrel. Used by `i18n/codes.ts` (the `.errors` of `auth`, `connections`, `consent`, `invitations`, `mfa`, `passkeys`), `admins.errors.ts` (`invitations.errors`), `auth.service.ts` (`mfa.challenge`), `events/types.ts` (`audit.model`), `tenancy/resolved-tenant.ts` and the tenants model and service (`sign-in-methods.schema`, `oauth-policy.schema`); generated code (`src/generated/`) is exempt, its type imports follow the schema;
  - **service-level edges kept deep**, each because the barrel makes madge report a cycle (the 6 cycles of "Import cycles" stay): `config/connections.ts` takes `connections.discovery` and `connections.service` (`config/connections` > `connections/index` > `connections.sso-gate` > `config/connections`); `console/context.ts` takes `admins.service` (`console/context` > `admins/index` > `admins.janus` > `console/context`); `http/context.ts`, `invitations.types.ts` and `invitations.service.ts` take the type `TenantJanus` of `users.tenant-janus` (`users/index` > `users.service` > `users.types` > `invitations/index` > `invitations.types` > `users/index`; `TenantJanus` derives from the janus builder and cannot move out of `users`); `lock-order.spec.ts` takes `users.console-mutations`, a console-resolver part loaded by file like the registry's.
    `scripts/`, `load/` and `package.json` are not modules. Tests import fixtures as `~/<file>` (`test/`), never a relative path to `test/`.
- **Named exceptions** (owner decisions D1, D2 and D8 of the alignment plan, not the RAR D1/D2 below; each is deliberate, not drift):
  - **D1, two schemas**: the hosted `/graphql` (cookie, tenant from the Host) and the console `/console/graphql` (bearer or DPoP JWT of the
    `clavix` tenant, its own cost limit, deny-by-default guard) stay two endpoints and two printed schemas, since one merged schema
    would expose console fields on tenant hosts.
  - **D2, protocol endpoints**: the OAuth/OIDC routes (`src/oauth`, `mountOAuth`: authorize, token, PAR, device, JWKS, discovery,
    userinfo, registration) are plain Request/Response routes beside `/graphql`; they are RFC-defined and cannot be GraphQL.
  - **D8, a console face per module**: each console resolver lives in its owning module as role files (`<m>.console*`), not in a parallel tree.
- Errors keep their UPPER_SNAKE values (D3, see Errors); the client header and `CLAVIX_REQUIRE_CLIENT_HEADER` are in "Same-origin guard and shutdown".
- `src/oauth/` is the authorization server: one janus server per tenant (`createClavixOAuthIssuers`),
  mounted on the app by `mountOAuth`. Signing keys, end-user authentication, user claims and resources
  come in as ports (`SigningKeysFor`, `AuthFor`, `ClaimsFor`, `ResourcesFor`). The janus adapters
  partition themselves by tenant, so they take the plain `oauthDb` (`src/config/oauth-db.ts`),
  not the scoped collections. `createApp({ oauth })` mounts it. The issuers are split: `issuers.ts` (`createClavixOAuthIssuers`), `resolution.ts` (host to tenant and resources), `building.ts` (the server config). `AuthFor` and `ClaimsFor` are wired by `src/modules/users` (`createIssuers(authFor, claimsFor)` in `src/config/oauth.ts` is the real wiring, keys and stored resources included, and `src/server.ts` passes the real `authFor`/`claimsFor` of `src/config/users.ts`; a tenant with no key yet gets a 503 `temporarily_unavailable`). `resourcesFor`, `rolesFor`, `exchangeRulesFor`, `agentCheckFor` and `eventsFor` are required ports, bound there to the tenants' stored resources, roles and client policies (below). `/consent` is the hosted page, built in clavix-ui (its API is built, see Consent). `bun run
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
`ctx.users.count`, `tenantsService.count` sharing its `filterOf` with `list`), never by a copy of the
filter. The lists that are plain arrays (resources, scopes, roles, memberships, adminInvitations,
domains) have no connection: their length is the count. A new paged connection adds `totalCount`
the same way.

## Resources (`src/modules/resources`)

A resource is an API of a tenant (RFC 8707): its `uri` is the `aud` of the access tokens asked with
`resource=<uri>`, its scopes what a client may request on it. `bun run resources:create --tenant
<slug> --uri <https uri> --scope <s> [--scope <s>] [--name <label>]` stores or updates one
(idempotent on the URI; the scopes are replaced), beside the console. The `resources` and `scopes`
collections are tenant-owned and reached only through `scopeToTenant` (`ResourcesService` in `resources.service.ts`,
`storedFor`, `registerResource`; `src/config/resources.ts` exports `resourcesService`,
`registerStoredResource` and `scopeTextsFor`, never the collections), so a resource of tenant A is unknown to B (`invalid_target`); the source scan
in `src/tenancy/guards.spec.ts` allows `src/modules/resources/` and `src/config/resources.ts`.
`ResourcesFor` is read on every request in the issuer's `resolve`, and its fingerprint is part of the
cache version, so a script-registered resource serves at once, no restart. A tenant's own userinfo
URL cannot be registered: it is built in, with the OpenID Connect scopes.
- **A scope is a document** (`resources.model.ts`, ADR-0025): `name`, `description { fr, en }`,
  `resourceId` and `claims`, unique on `(tenantId, resourceId, name)`, so two resources may each
  have a `read`. `resourceId: null` is a standard OpenID Connect scope and only `openid`, `profile`
  or `email` (`resources.rules.ts`); it exists once a tenant describes it. `claims` is stored only.
- **`ResourcesService`** (one service for resources, scopes and detail types: they are one domain, the cascade of a resource's delete and the scope and type lookups all cross them) is the one writer of scopes and the console's writer of resources
  (`registerResource` upserts the resource itself, then calls `replaceResourceScopes`); it throws `CatalogError`
  (`NOT_FOUND`, `CONFLICT`, `BAD_USER_INPUT`), which the console maps to `extensions.code`. Sizes are
  bounded there (names 100 characters, descriptions 300, 50 claims; a client 20 redirect URIs).
- **The fingerprint** comes from what `storedFor` reads (URIs and scope names, now from the
  `scopes` documents), so a scope added or removed in the console serves at once.
- **Detail types** (`resources.compile*.ts`, `resources.detail-rules.ts`, README "Authorization details", RAR D1/D2, softistx/clavix-api#17 and #18):
  `ResourcesService` is the only writer: the type name is immutable, labels hold 100 and descriptions 300 characters (`MAX_LABEL`, `MAX_DESCRIPTION`), deleting a type a client lists throws `DETAIL_TYPE_IN_USE` (D6), and deleting a resource removes its types and prunes them from the clients' lists (`DetailTypeClients`);
  the tenant-owned `detailTypes` collection (unique on `(tenantId, type)`, so a name is unique in the
  tenant) holds a bounded field list, compiled by the pure `resources.compile.ts` (limits and checks in `resources.compile-rules.ts`) into a `z.strictObject` (no
  free JSON Schema); `storedFor` gives each resource `authorizationDetails`, `fingerprintOf`
  hashes the definitions (`digestOf`) so an edit rebuilds the issuer, and `withScopes` keeps a resource
  that has types and no scope. `saveDetailType` is the writer (`createDetailType` and `updateDetailType` call it). `createDetailType` repeated with the same values on the same resource returns the stored type (the console records its event again, as `createResource` and `createScope` do); other values or another resource stay `CONFLICT`.
- **A client opts in** (R3): `registerClient` and `ClientsService` take `detailTypes` (`authorizationDetailsTypes` on the janus record; `src/modules/clients/clients.detail-types.ts` judges it). Each name must be a stored type of the tenant (the `ClientDetailTypes` port, wired in `config/resources.ts`), the final client must require PAR (D3), and a client with `authorization_code` or the device grant (a consent page) needs the tenant in `CLAVIX_RAR_CONSENT_READY` (temporary `rarConsentReady`, removed with the consent page, V4). A kept type that is no longer stored stays on the record and is refused by the issuer.
- **The consent API shows details in words** (R4, D4/D5): `OAuthRequest.details` and `OAuthDeviceRequest.details` (`consent/consent.detail-labels.graphqls`) are built by the pure `detailsOf` (`consent/consent.detail-labels.ts`) from janus's `authorizationDetails` string and the tenant's `detailTypes` texts (`detailTextsFor` in `config/resources.ts`, read once per request like the scope texts, put on the context by `oauthContext`). A detail that cannot be fully described (type deleted, a key, action or enum value the type no longer defines) makes `detailsComplete` false (`reviewDetails`), and janus-oauth's `beforeApprove` hook (`ConsentService.beforeApprove`, `consent/consent.service.ts`, once per approval in both flows) refuses it with `invalid_authorization_details`, the request staying pending. Approval stays all or nothing: `beforeApprove` refuses any `authorizationDetails` selection with `invalid_authorization_details`, in both flows. `src/oauth/rar.spec.ts` is the end-to-end spec.
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

## OAuth policy (`src/modules/oauth-policy`, with its `oauth-policy.console-*` files)

`tenant.oauth` (`oauthPolicySchema`: `{ par: { required }, dpop: { required } }`, every flag defaults to `false`) is on the tenant document and on `ResolvedTenant`, so an entry cached before the field parses off. `building.ts` passes `pushedAuthorizationRequests: { required: tenant.oauth.par.required }` (`/par` is always served, and is in `OAUTH_PATHS`, `REFUSED_PATHS` and the Caddyfile `@api` matcher).
- **Every write goes through `OAuthPolicyService`** (over `TenantsService.updateOAuth`, optimistic lock, no write when nothing changes, `version` bump), modelled on `SignInPolicyService`. The `clavix` tenant accepts `par.required` / `dpop.required` like any tenant (the 409 guard is lifted, #233): migration `2026-11-17-console-par-dpop` sets both on the tenant and marks the `console` client `requirePar` + `dpopBound` (idempotent, version bumped only on a change; its `down` relaxes them). The console (clavix-ui#228) pushes (PAR) and proves (DPoP ES256), so **deploy clavix-ui first or together**: an older console is locked out once the migration has run. `test/setup.ts` relaxes the platform tenant after the migrations, so the specs keep minting plain tokens; `console.spec.ts` sets `dpop.required` itself and restores it.
- `TenantsService.create` writes `par.required: true` for a new tenant (not the platform one); migration `2026-11-16-oauth-policy` writes an explicit `false` on the existing ones (`db:sync` first). Specs that authorize directly on a tenant made by `createFlow().setUp` get PAR turned off there (`{ par: true }` keeps it).
- **Device grant** (`deviceAuthorization: { verificationUri: \`${issuer}/device\` }`in`building.ts`for every tenant;`/device_authorization`is in`OAUTH_PATHS`, `REFUSED_PATHS`and the Caddyfile`@api`matcher). It is never implied: a client lists`DEVICE_GRANT`in`grantTypes`. `registerClient`requires redirect URIs only when the grants include`authorization_code` (`usesRedirect`); default grants are `DEFAULT_GRANTS`, not `OFFERED_GRANTS`. The verification page's operations are janus's `oauthResolvers` (`modules/consent/consent.resolver.ts`) with `beforeUserCodeLookup`=`deviceThrottle` (`modules/consent/consent.device-throttle.ts`, `CLAVIX_DEVICE_*`, on the shared `createUserThrottle`of`http/throttle/core.ts`). The hook runs before the store is read, so it counts every lookup, not only misses. The device approve guard looks the code up first, so it runs the hook itself and marks the call (`counted`) so janus's hook does not count it twice. Specs that call `/authorize`on a new tenant use`createTenantParOff`.
- **Client credentials grant** (#362): opt-in at three levels. A resource sets `allowClientCredentials` (`Resource` model, `storedResourcesFor` gives janus `clientCredentials: true`, `updateResource` in the console, refused on the console's own resource by `refuseMachineConsole`); `building.ts` turns the server option on for a tenant only when one of its resources opted in (`fingerprintOf` adds `cc` so the cached issuer rebuilds); a client lists `CLIENT_CREDENTIALS_GRANT`, is confidential and has `allowedScopes` (the ceiling janus enforces; `defaultScopes` optional), judged by `registerClient`/`clients.validate.ts`. The `accessTokens.claims` hook skips `roles` for `subjectType: "client"`. Only the token endpoint accepts a client token: the console's `authenticateRequest` never passes `clientCredentials`, userinfo answers 401, and no other endpoint reads a bearer principal. `OAuthPrincipal` is a union (`kind`/`subjectType`); the console uses `OAuthUserPrincipal`. Revoking does not cut a client off: delete it, drop the grant or rotate the secret. Spec: `src/oauth/client-credentials.spec.ts`; guide: `docs/guide/client-credentials.md`.
- **Token exchange** (`tokenExchange: { policy: exchangePolicy(...) }` in `building.ts`, every tenant; `exchangePolicy` is in `src/oauth/token-exchange.ts`): the policy reads the client's rules through the `ExchangeRulesFor` port (`src/oauth/ports.ts`, stored by `src/config/client-policies.ts`, collection `clientPolicies`, tenant-owned) and answers `delegation` or `null` (`access_denied`); both ports (`ExchangeRulesFor`, the agent check) are required. Rules: `targetResources` and `subjectClients | "any"`. A client lists `TOKEN_EXCHANGE_GRANT` and is confidential (`registerClient`, `ClientsService.setTokenExchange`, which checks the input with `validateTokenExchange` in `src/modules/client-policies/client-policies.rules.ts`); `ClientsService.delete` deletes its rules and removes the client from the other rules' `subjectClients` (`removeSubjectClient`); deleting a resource removes its URI from `targetResources` (`removeTarget`), both tenant-scoped.
- **DPoP** (`dpop` in `building.ts`, every tenant): `algorithms ['ES256','EdDSA']`, `required: tenant.oauth.dpop.required`, `replay: createMongoDPoPReplayCache(oauthDb, { clock })` (Mongo, shared by instances, not Redis) and `nonce: { secret }`, the secret being `dpopNonceSecretOf(masterKeys)` (`src/config/keys.ts`: HKDF-SHA256 of the first master key, info `dpop-nonce`) passed to `createClavixOAuthIssuers({ dpopNonceSecret })` (required: specs pass a constant). The proof's `htu` is the issuer's public URL. New tenants start with `dpop.required: false` (`newTenantOAuthPolicy`). A client's `dpopBoundAccessTokens` goes through `registerClient` (`dpopBound`, CLI `--dpop-bound` / `--no-dpop-bound`, kept on a re-run) and `ClientsService`; `ClientView` carries it. The console (`src/console/auth.ts`) takes `Bearer` and `DPoP` through `server.authenticateRequest({ headers, method, url: publicUrl }, { resource })`, `publicUrl` being `https://console.<domain>/console/graphql` (`config/console.ts`); a refused DPoP request is a `ConsoleDPoPRefusal` that the plugin answers as `WWW-Authenticate: DPoP` plus `DPoP-Nonce`. Specs: `~/dpop` signs proofs (`createDpopKey`) and retries on `use_dpop_nonce` (`withNonce`). The console also refuses a delegated token (`principal.actor`, an RFC 8693 exchange) with a plain 401.
- A client's own `requirePushedAuthorizationRequests` goes through `registerClient` (`requirePar`, CLI `--require-par`) and `ClientsService`; `ClientView` carries it.
- **Agents (M3b G1)**: `tenant.oauth.agents` (`{ dynamic: off|restricted|open, redirectUris, metadataDocuments, allowHosts }`, default off, zod `.default` so old cached tenants parse) feeds janus's `registration` through `registrationOf` (`src/oauth/registration.ts`: restricted is janus's MCP redirect URIs plus the tenant's valid ones; documents only from the MCP hosts plus `allowHosts`). `/register` is Clavix's own route (`src/oauth/register-route.ts`, wired by `withRegistration` and `config/agents-registration.ts`, mounted with the client IP): suspended tenant 403, janus's 400 when off, throttle (`CLAVIX_REGISTER_*`), a body of at most 16 KiB (413 on a larger `Content-Length`, the stream cut at 16 KiB otherwise), then, under one `exclusive` lock per tenant (a required port of `createRegisterRoute` and `withRegistration`, bound in `config/agents-registration.ts`; `agentsQuotaKey`, `oauth/agents-quota.ts`; the console's Redis lock, in-process without Redis), the `agents` quota (403 `access_denied`), `server.registerClient` and the tenant-owned `agentClients` record (rolled back with `deleteClient` if the record fails). A metadata-document client is recorded (`kind: metadata`) on first `/authorize` or `/par`, idempotently; before janus fetches the document, `withRegistration` throttles it (`CLAVIX_METADATA_*`, 429 `temporarily_unavailable`) and, for a client not yet recorded, runs the quota check (403 `access_denied` over it), the fetch and the record under the same per-tenant lock. Dynamic agents are not counted in the `clients` quota or meter. `/register` is in `OAUTH_PATHS`, `REFUSED_PATHS` and the Caddyfile `@api` matcher. The device and token-exchange URNs are never offered to dynamic clients.
- **Agents (M3b G2)**: the console's `OAuthPolicy.agents` goes through `applyAgentsInput` (`modules/oauth-policy/oauth-policy.rules.ts`: lower-cased deduped hosts, redirect URIs checked with `redirectUriProblem`, 50 entries at most, `AgentsInputError` becomes `BAD_USER_INPUT`); `agentsNeedPushOrProof` is the D14 flag (agents on while `par`/`dpop` required tenant-wide), saving stays allowed. `Client.registration` (`CONSOLE|DYNAMIC|METADATA`) is derived from the janus `source` plus `AgentsService.kinds`; `clients(kind:)` is a list filter; metadata-document clients are listed and read (`find(..., { agents: true })`) but writes still see registered clients only. `deleteClient` removes the agent record too (`ClientsService.delete`). The daily job `agents.prune` (`modules/agents/agents.prune.ts`, queue `agents-prune` 03:41 UTC, started in `server.ts`, wired in `config/agents-prune.ts`, no start-up pass) deletes agents of every kind (dynamic and metadata-document, so none counts toward the quota for ever) recorded more than 7 days ago with no standing grant, the grant check and the delete under the tenant's clients lock (`clientsKey`), one admin event `agent.prune` per agent actually removed with the actor `system:agents:prune`; it needs `REDIS_URL` (no queue, no run); a failed agent makes the tick throw so the queue retries.
- **RFC 9728 document (M3b G3)**: the console `Resource.metadataUrl` and `protectedResourceMetadata` come from `protectedResourceDocument` (`modules/resources/resources.protected-document.ts`), which calls janus's `protectedResource()` and returns its handler's body, so the console never drifts from janus. The tenant host is resolved once per request; one that does not resolve gives `null` for `metadataUrl` and `protectedResourceMetadata` (both nullable). The issuer and DPoP policy are the resolved tenant's (`tenantResolver.resolveHost` on the slug host); DPoP is announced only when `oauth.dpop.required` (algorithms `DPOP_ALGORITHMS`, shared with `building.ts`). Clavix hosts no copy (D13); the RAR detail types join the document once janus ships them (J3).
- Console: `oauthPolicy` needs `view`, `updateOAuthPolicy` `edit`, admin event `oauthPolicy.update`.

## Users and sessions

Sign-in methods are the tenant's own policy (`tenant.signIn`, `src/modules/sign-in-methods/`; README "Sign-in methods and social providers"), never an environment switch:
- Layout (A8): `sign-in-methods.resolver.ts` (+ `.resolver-support.ts`: the tenant's janus per request, the social
  resolvers, the hosted page and the completed-flow answer), `.errors.ts` (the codes, `refusal`,
  `methodDisabled`; `badInput` is the shared `src/shared/errors.ts` one), `.rules.ts` (input checks, the method change, the first-party and usable rules, the reseal of
  the entries), `.utils.ts`, `.types.ts`, `.schema.ts`, `.secrets.ts`, `.social.ts`, `.gate.ts`, `.sso-throttle.ts`,
  and `sign-in-methods.service.ts`: one service per domain (owner, 2026-11-20), `SignInPolicyService`, holding
  every business method of the domain (`get`, `updateMethods`, `updateMfa`, `setSocial`, `removeSocial`,
  `resealSecrets`), its spec beside it. `index.ts` is the import surface (the schema first); `modules/index.ts` imports
  `sign-in-methods.resolver.ts` by file (its support loads the config wiring). The service is built in
  `src/config/sign-in-policy.ts` and registered as `services().signInPolicy`. Deep imports allowed: `sign-in-methods.schema.ts` by the tenants model and
  `tenancy/resolved-tenant.ts` (the barrel would close an import cycle through the service).
- **One field, one schema**: `signIn: signInPolicySchema` (`sign-in-methods.schema.ts`) on the tenant document and on `ResolvedTenant`: `methods` is a list of `{ type, enabled }` entries (`mfa: { mode: passkeySufficient|required, totp }` goes beside it, with zod defaults so a cached tenant without it still parses: `totp` off, mode `passkeySufficient`) and `social` a list of `{ provider, clientId, secret, enabled }`. A method absent from the list has its default (`passkey` and `emailCode` on, `magicLink` and `password` off). `password` is stored but not available (`isAvailable`): it is never on and cannot be enabled until janus's password flow is wired.
- **Every write goes through `SignInPolicyService`** (`sign-in-methods.service.ts`, over `TenantsService.updateSignIn`): it refuses a policy with no enabled method and no enabled provider (`NO_SIGN_IN_METHOD`), writes nothing when nothing changes, and bumps the tenant's `version`, which rebuilds its janus (`createJanusIssuers`).
- **Gates**: `requireMethod(tenant, method)` (`sign-in-methods.gate.ts`) is the first line of the e-mail code and passkey sign-in resolvers, before any throttle (404 `SIGN_IN_METHOD_DISABLED`). Magic link keeps janus's own gate: janus defaults it to on, so `users.tenant-janus.ts` always passes `magicLink: { enabled }` from the policy, and `requestMagicLink` / `confirmMagicLink` (`AuthService`, `src/modules/auth/auth.service.ts`) answer 404 `MAGIC_LINK_DISABLED`, checked first in the service, before the throttle. Registering a passkey while signed in is not gated.
- **Social secrets** are sealed by `secretBox` (`src/config/keys.ts`, `sign-in-methods.secrets.ts`): AES-256-GCM under an HKDF-SHA256 subkey of `CLAVIX_KEYS_MASTER_KEY` (info `social-secrets`), stored as `{ v: 1, kid, iv, ct }` with the tenant id and provider as associated data, so an envelope copied to another tenant or provider does not open. The master key itself is not exported. A secret is opened only in `socialProvidersOf` (`sign-in-methods.social.ts`), when a tenant's janus is built; it is in no GraphQL type (console or hosted), no log line and no error message (a provider that cannot be built is skipped with a warning naming the tenant, the provider and the error's name). The resolved tenant, cached in Redis, holds the envelope, never the secret.
- **A social sign-in may replace an unverified holder (nxgt-janus #978)**. **Assumed, not answered**:
  `social.unverifiedHolder` (`unverifiedHolderOf`, `users.social.ts`) answers `'replace'` for the tenant's built-in
  social apps (Google, GitHub, Microsoft: the static providers, which vouch for the addresses they hold) and
  `'refuse'` for an enterprise connection (the tenant's own identity provider could vouch for an address it does
  not control). janus asks only once the provider reported the e-mail verified, and never replaces a verified
  user. A replaced user loses their credentials, links and sessions; `SocialSignedIn.replaced` says so, and the
  sign-in log's `session.signIn` carries `reason: "replaced"`. Clavix revokes the replaced user's OAuth grants
  and refresh tokens itself: `socialSignInComplete` calls `ConsentService.revokeGrants` (`modules/consent/consent.service.ts`, janus-oauth
  `grants.revokeAll`) when `replaced` is true, before anything else. janus does not repeat `replaced`, so a
  failure must not be lost (clavix-api #353): `ConsentService.revokeOnReplace` puts a failed
  revocation on the `grants-revoke` queue (`consent.queue.ts`, `{ tenantId, userId }`, 8 attempts, backoff 1 min
  doubling to 1 h, `grantsRevokeQueue` in `config/grants-revoke.ts`) and the sign-in succeeds once the job is
  stored; the worker (`ConsentService.startRevokeWorker`, started in `server.ts`) finds the tenant's
  server by its issuer URL and repeats the idempotent `revokeAll`. With no Redis, or when the job cannot be
  added, the original error fails the sign-in as before.
- **The social flow is janus's**: `socialSignInStart` / `socialSignInComplete` delegate to janus-graphql's `socialResolvers` with a per-request auth function (the tenant of the host, null when it has no provider); the providers are `@softistx/janus-social` presets. A new user is created only where the tenant's `signUp` is open (`SIGN_UP_DISABLED` otherwise). No provider code is written here.
- **Console** (`src/modules/sign-in-methods/`, folded in by A15: `sign-in-methods.console.graphqls`, `sign-in-methods.console-resolver.ts` with its `-guards` and `-support` (`policyOf`; `issuerFor` lives in `src/console/modules/issuer.ts`, shared with connections), the enum maps and `policyShape` in `sign-in-methods.utils.ts`, `sign-in-methods.console.spec.ts`): `signInPolicy` needs `view`, the three mutations `edit`, on the tenant of `tenantId`. Each mutation records its admin event after the write (`signInPolicy.update`, `socialProvider.set`, `socialProvider.remove`; target ids only, never a client id or secret). A change that loses the optimistic lock three times is `CONFLICT` (409).
- **Console users** (`src/modules/users/`, folded in by A13: `users.console.graphqls`, `users.console-resolver.ts` with its `-queries`, `-mutations`, `-support` and `-guards` (guards and audits maps), `users.data-loader.ts`, `users.owners.ts`, `users.errors.ts`, `users.utils.ts`, `users.types.ts`; the console schema loads `src/modules/**/*.console.graphqls` beside `src/console/**/*.graphqls`, the hosted one leaves both out): reads need `view`, the mutations `edit` (`updateUser` renames only; `setUserEmailVerified` writes the flag only), on the tenant of `tenantId`; the tenant must be active. Janus is reached only through the `ConsoleUsers` port, implemented by `UsersService` (`users.service.ts`, one service per domain: users, sessions, second factor, invitations and grants; built in `src/config/console.ts` over a `UsersSource`, since it needs the OAuth handle), per tenant. `users` searches by `emailPrefix` (case-insensitive, also a username) with a `totalCount`; `userLookup` (`edit`, the role member picker: e-mail/username prefix through janus, name prefix through janus's indexed `namePrefix`; at most 20, id/email/name only) feeds the Add member picker; `userSessions` lists a user's sessions (`device` is the sign-in's User-Agent, set by `deviceOptions` in `src/modules/auth/auth.utils.ts` on the e-mail code and magic-link sign-ins). Per-request loaders (`oncePerRequest`, one per tenant, no cache across requests; `users.data-loader.ts`): `secondFactorLoader` (`TenantUser.secondFactor`) and `userLoader` (`roleMembers` reads a page's pool users with ONE `ConsoleUsers.findMany`, `null` for an id the pool lacks). `clients` and `tenants` lists have no per-row read (no field resolver; the tenant page carries its documents), so they have no loader. Each mutation records its admin event (`user.*`; ids only), repeats included.
- **What is offered is what can be opened**: `hostedSignInMethods` and `socialSignInStart` use `offeredSocial(policy, secretBox.opens)`, so a provider sealed under a key outside the `CLAVIX_KEYS_MASTER_KEY` keyring is not shown (with a keyring the first key seals and every key opens; `keys:reseal` wraps them again under the first).

`src/modules/users/` holds the end users of a tenant (ADR-0008): `createTenantJanusIssuers` (janus
`createJanusIssuers`, fed by the same tenant resolver as the OAuth issuers, `version` as a string) builds
one `janus()` per tenant over `createMongoStores(db, { partition })`, so users, sessions, passkeys and
tokens are the tenant's partition (`syncMongoStoresPartitioned` and `syncMongoInvitationsPartitioned` in
`db:sync` and `test/setup.ts`). `createTenantAuth` gives the real `authFor` and `claimsFor`
(`src/config/users.ts`, wired in `src/server.ts`): both go through the tenant's own instance, so a
user id or session of another tenant is unknown or anonymous. Relations, API keys and janus-kit are not
partitioned: never use them for tenant users.
Its files (A23): `users.tenant-janus.ts` (one tenant's `janus()` and the `TenantJanus` types),
`users.issuers.ts` (`createTenantJanusIssuers`, its options), `users.social.ts` (the social apps and
enterprise connections of a tenant), `users.sso.ts` (home-realm discovery, the callback's connection),
`users.session.ts` (the cookie and session constants), `users.rp.ts` (rpId, origin), `users.schema.ts`
(the user schema), `users.second-factor-keys.ts`, `users.verified-email.ts` and `users.tenant-auth.ts`
(`authFor`, `claimsFor`). `index.ts` is the import surface (registered as `services().users`); the console resolvers are imported by file (`console/modules/index.ts`, and `users.console-mutations.ts` by `lock-order.spec.ts`), the rest through the barrel.
- **Cookie**: `__Host-clavix-session`, no `Domain`, Secure, SameSite=Lax. Session 14 days sliding,
  capped at 30 days after sign-in (`session.absolute`, janus 0.53).
- **Assumed, not answered (2026-11-12), confirm before first production passkey**: the passkey rpId is
  the tenant's host and the origin `https://<slug>.<CLAVIX_DOMAIN>`, in one place, `rpIdOf` /
  `originOf` (`src/modules/users/users.rp.ts`). A verified custom domain is a WebAuthn related origin of it
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
  mail run after the answer (`src/modules/auth/auth.outbox.ts`, `afterAnswer`); a closed tenant creates and mails nothing
  for an unknown address; every verify refusal is the same `CODE_INVALID` 401. An open tenant creates
  an unverified user per request (accepted trade-off).
- The challenge travels in the response body (`cache-control: no-store`), not a cookie: the hosted
  pages are a BFF. Code: 6 digits, 10 min, 5 attempts; 5 mails per address per 10 min
  (`MAIL_THROTTLED`, 429), both janus's.
- **Limits on top** (`src/modules/auth/auth.throttle.ts` over `src/http/throttle/core.ts`, README "Sign-in code limits"): per client IP and tenant (20 / 10 min)
  and per tenant (200 / hour), `@softistx/redis` rate limits wired in `openAppRedis`, keys led by the
  tenant id, configured by `CLAVIX_CODE_*`. Refusal = janus's `MailThrottledError`, so the answer is the
  per-address one. `appPorts` binds it (Redis, the named `noThrottle` without it) and `createApp({ signInThrottle })` overrides it (specs). The IP is `ctx.ip`; `CLAVIX_TRUSTED_PROXIES` (required in production, 0 elsewhere by default) makes `createBase` read
  `X-Forwarded-For`, and `test/setup.ts` sets it to 1 so specs choose the address by header.
- **Mail**: one platform sender `no-reply@<CLAVIX_DOMAIN>` (display name = tenant name) over
  `@softistx/mail-smtp` when `CLAVIX_SMTP_URL` is set (required in production), else the memory
  mailer. Links point at the tenant issuer. Mails are English: users have no locale yet.
- Specs: `src/modules/auth/auth.sign-in.spec.ts` (flow, closed sign-up, invitation, isolation A/B).

## Magic-link sign-in (`AuthService`, `src/modules/auth/auth.service.ts`)

Same shape as the e-mail code (janus `magicLink.prepare` then, after the answer, `send()` and
`mail.magicLink`; sign-up creation shared as `createIfOpen`), on the same `signInThrottle`. The link is
`<issuer>/sign-in/link?token=` (`MAGIC_LINK_PATH`, `src/mail/tenant-mail.ts`), a hosted page that POSTs
`confirmMagicLink`; never a sign-in on GET. Every confirm refusal is `MAGIC_LINK_INVALID` 401. No second
factor is configured, so `confirm` always opens a session; janus 0.57 refuses enrolment while the
e-mail is unproved (janus#693 closed there, no guard of ours).

## E-mail verification (`AuthService`, `src/modules/auth/auth.service.ts`)

`requestEmailVerification` / `confirmEmailVerification` (README "E-mail verification"), signed in only
(`auth.authenticate`, else `UNAUTHENTICATED`; `requireLive` first). Request: `verifyEmail.prepare(email)`
then, after the answer, `send()` and `mail.verifyEmail` (link `VERIFY_EMAIL_PATH`, `src/mail/tenant-mail.ts`);
always `true`, an already verified user is mailed nothing, and the token must be issued to the signed-in
user. Confirm: `verifyEmail.confirm(token, { user })`, **never** `firstProof` and never unbound; every
janus refusal except `STORE_FAILED` is `EMAIL_VERIFICATION_INVALID` 400. janus's `MAIL_THROTTLED` becomes
`EMAIL_VERIFICATION_THROTTLED` too (stable code for the UI).
- Limits (`src/modules/auth/auth.verification-throttle.ts`, `CLAVIX_VERIFY_*`): per user (`tenantId/userId`,
  10 / hour), then the shared core pair per IP and tenant and per tenant. `ctx.verifyThrottle`, injected with
  `createApp({ verifyThrottle })`; Redis down: fail open, logged.
- Spec: `src/modules/auth/auth.email-verification.spec.ts` (incl. OIDC `email_verified`, tenant isolation,
  suspended tenant, Redis).

## Passkeys (`src/modules/passkeys`)

Passwordless passkey sign-in and registration on `/graphql` (README, "Passkey sign-in and
registration"). janus passkeys are the first factor (`passkeys.firstFactor: true`,
`@softistx/janus-passkeys`), rpId and origin from `src/modules/users/users.rp.ts`; janus-graphql's passkey SDL is
not used: its resolvers bind to one janus instance and it has no first-factor sign-in, and ours is
per tenant, so the operations sit on `auth.passkeys` like the sign-in code's.
- The passkey sign-in is janus-graphql's `passkeyResolvers({ auth, firstFactor: true })`, called from
  our own `passkeySignInOptions` (a Mutation, behind the throttle) and `signInWithPasskey`: our SDL keeps
  its names, arguments and errors, so the janus refusals (`CREDENTIALS_INVALID`, `TOKEN_*`, a non-JSON
  response) are answered as one `PASSKEY_INVALID` 401 (`asPasskeyInvalid`; `STORE_FAILED` stays 503).
  Registration lets janus's errors through (`janusMasking`). Cookie as `verifySignInCode`.
- **TOTP second factor (M4 M1)**: every tenant's janus is built with `secondFactor` (`users.tenant-janus.ts`), so a user who holds a factor gets a challenge instead of a session. The sealing keys come from the keyring (`src/modules/users/users.second-factor-keys.ts`: HKDF-SHA256 of each master key, info `second-factor`, key id = another 8 bytes of the same master key): the first key seals, every key opens, so a rotation of `CLAVIX_KEYS_MASTER_KEY` keeps TOTP working. `keys:reseal` seals the TOTP secrets again with janus's `secondFactor.reseal` (`src/modules/keys/keys.second-factor-reseal.ts`) and counts what is still under an older key (`secondFactor.behind` for secrets, `recoveryCodesBehind` for the recovery-code hashes, which cannot be re-hashed): keep the old key until `recoveryCodesBehind` is 0. `MfaService` (`src/modules/mfa/mfa.service.ts`) binds janus-graphql's `secondFactorResolvers` (bound once, `auth` a function of the context answering the request's tenant janus (nxgt-janus#914), `NOT_FOUND` for an unknown host, `freshWithin: '10m'`) behind our own SDL; its guard refuses `enroll` and `activate` with 403 `SECOND_FACTOR_DISABLED` when the policy's `mfa.totp` is off (a factor that exists is kept; disabling and new recovery codes stay allowed). The code, link and social completions answer a union (`SignInResult`, `SocialSignInResult`: the session or a `SecondFactorChallenge`), recorded as a sign-in only when a session opened; `confirmSecondFactor` / `recoverSecondFactor` record `session.signIn` by `totp` / `recoveryCode`, and `confirmSecondFactorWithPasskey` by `passkey` (janus-graphql's `passkeyResolvers().Mutation.confirmSecondFactorPasskey`, the same five attempts; clavix-api#293). `requestSecondFactorPasskeyOptions` re-reads the passkey options of a challenge: no attempt is counted, it shares `ctx.passkeyThrottle`, and runs `requireLive` then `requireMethod("passkey")`. A passkey sign-in stays `SignedIn` (a passkey is multi-factor). Console: `updateMfaPolicy` (`edit`, event `mfaPolicy.update`), `TenantUser.secondFactor`, `resetUserSecondFactor` (`edit`, event `user.resetSecondFactor`). `TenantUser.secondFactor` reads through a per-request DataLoader (`secondFactorLoader` in `users.data-loader.ts`, `ConsoleUsers.secondFactors`: one `findMany`, the recovery codes of the holders only); the users module resolvers are wrapped in `freshPerMutation`, so a field read after a reset sees the write.
- janus (0.55+) accepts
  `http://<name>.localhost` origins, so a development tenant on http (`<slug>.clavix.localhost`) gets its
  real rpId and origin like any other: no http special case.
- Specs use `softwareAuthenticator` from `@softistx/janus-passkeys/testing`.
- The anonymous `passkeySignInOptions` has its own limits (`src/modules/passkeys/passkeys.throttle.ts`, README
  "Passkey sign-in and registration"): per IP and tenant (60 / 10 min) and per tenant (600 / hour),
  `CLAVIX_PASSKEY_*`, over the shared core `createThrottle` / `ipAndTenantLimits` of
  `src/http/throttle/core.ts` (never copy it); the throttles ride on the context (`ctx.signInThrottle`,
  `ctx.passkeyThrottle`, set by `createBase`). `passkeySignInOptions` resolves the tenant first (unknown host: `NOT_FOUND`, no budget spent). Refusal = `PASSKEY_THROTTLED` 429 with `Retry-After`; Redis down:
  fail open, logged. `appPorts` binds it (Redis, `noThrottle` without it); `createApp({ passkeyThrottle })` overrides it (specs).
  Spec: `src/modules/passkeys/passkeys.throttle.spec.ts`.

## Consent

`src/modules/consent/` is the API of the hosted `/consent` page, served on E1's `/graphql`
(janus-oauth's `oauthResolvers` and `oauthTypeDefs`, merged in `src/http/schema.ts`). `oauthContext`
(a graxia plugin, `onContext`, added in `createApp` when `oauth.serverFor` exists) puts the issuers in the context, and
the resolver picks the request host's tenant's OAuth server; the session is that tenant's too.
The same-origin guard is not in this module: it is the HTTP-layer plugin below, so a consent operation refused there still sees `NOT_FOUND`.
`approveOAuthRequest` is fresh-only (5 min, `STEP_UP_REQUIRED`). Step-up (M2): `beforeApprove` runs
`assessment` (`consent.authentication.ts`, over the pure `src/oauth/authentication-level.ts`) for the code and device flows and
refuses with `UNMET_AUTHENTICATION_REQUIREMENTS` (403, extension `missing`); `approveOptions` passes `amr`, `acr` and
`authTime`. A request nothing can meet (`missing` empty: an `acr` Clavix does not issue) is not left pending: `approveOAuthRequest`
is wrapped (`ConsentService.approveOrDenyUnmet`; `consent/consent.unmet.ts`) and denies it with `unmet_authentication_requirements`
(janus-oauth 0.24), answering `{ redirectTo }` with `error`, `state` and `iss`; a gap the user can close (`SECOND_FACTOR`,
`FRESH_PROOF`, `ENROLMENT`) stays the 403 and the request stays pending for the step-up. The access-token `claims` hook
(`oauth/building.ts`) puts the grant's `acr`, `amr` and `auth_time` in the JWT, the ID token's values (janus 0.76).
A recovery-code sign-in adds `rec` and `mfa` to the first factor's amr (RFC 8176), not `otp`: janus stores it on the session itself (@softistx/janus 0.77), and `src/modules/mfa/mfa.second-factor.spec.ts` asserts it. A passkey step-up needs no
authenticator app with `passkeys.firstFactor` (janus 0.76). A scope's `label` is the tenant's description of it (`consent.scope-labels.ts`: the
resource's scope, else the standard one; `Accept-Language` French else English, then the other
language, then janus's label), set by our `OAuthRequest.scopes` and `OAuthConnectedApp.scopes`
resolvers because janus-oauth's `scopeLabels` is one static map. Passkeys are the next section.

## Same-origin guard and shutdown

`useSameOriginJson` (`src/http/same-origin.ts`, the second graxia plugin of `/graphql`, after `useClientHeader` below, an `onRequest` of this API's own: `sameOrigin()` of `@softistx/alxia-graphql` is gone, and graxia's `csrf` option answers a fixed 403, so it is not used for this; graxia's CSRF header check stays on and runs before it, so a GET or a non-JSON POST carries `x-graphql-csrf: 1` to reach it) guards **every**
`/graphql` operation once: a foreign `Origin`, `Origin: null` or a non-JSON POST is answered before
parsing, with no CORS header: consent operations (`CONSENT_FIELDS`) get 404 `NOT_FOUND`, all others 403
`FORBIDDEN`. Origin and request are compared by host (TLS-terminating proxy); no Origin passes (the cookie
is `__Host-`). A new operation needs no guard of its own; never add a CORS plugin without revisiting this, and `onRequest` does not guard a WebSocket upgrade (`ws` is off: keep it so or guard the upgrade).
On stop, `server.ts` has an `onStop` hook that awaits `drain()` (`src/modules/auth/auth.outbox.ts`, 10 s)
so a code mail in flight is not lost; `stopTimeout` is set above it.

`useClientHeader` (`src/http/csrf.ts`, first plugin of `/graphql` and of `/console/graphql` in `app.ts`, so it runs before `useSameOriginJson` and `useInviteBudget`) answers 403
`CLIENT_HEADER_REQUIRED` before parsing when `x-clavix-client` is missing or blank (any non-empty value
passes, no allow list; a GET of the IDE page is exempt, and the IDE sandbox sends `apollo-sandbox`). It runs first on both endpoints, so the refusal is the same 403 everywhere: a consent operation without the header sees this 403, never the `NOT_FOUND` of the same-origin guard (that one needs the header present). It takes an
explicit boolean: `createApp({ requireClientHeader })`, defaulting to `CLAVIX_REQUIRE_CLIENT_HEADER`
(`false`). It stays OFF until clavix-ui's U3 sender (`clavix-ui`) is deployed; it is then turned on, and later
becomes the default. Every spec request to these paths sends `clientHeaders` (`test/client-header.ts`).

## Signing keys

`src/modules/keys/` holds the per-tenant signing keys on janus and `KeysService` (`keys.service.ts`, built in
`src/config/keys.ts` over `createTenantKeys`, the clock and `warn`; a tenant's partition is its hex id): `signingKeysFor`,
`jwksFor`, `generations`, `ensureSigningKey(tenantId)` (a tenant's first key, called by `TenantsService.create`'s hook), `rotateAll(tenantIds)`
(the hourly pass: `server.ts` gives it `tenantsService.activeIds()`) and `rotateNow(tenantIds, { dropOld })` (the emergency
rotation of `keys:rotate`), the rotation policy and the hourly `key-rotation` queue (files: `keys.service.ts`,
`keys.signing-keys.ts`, `keys.generations.ts` (the per-tenant counter of key changes), `keys.rules.ts`, `keys.queue.ts`, `keys.worker.ts`, `keys.reseal.ts`, `keys.second-factor-reseal.ts`, `keys.types.ts`,
`keys.utils.ts` and `keys.cli.ts`; `index.ts` is the import surface (`KeysService`, `createTenantKeys`, `createKeyGenerations`, the reseal and the CLI parsers); specs build a service with `quietKeys` (`test/ports.ts`); registered as `services().keys`) (Redis only; without it the pass at server start is the only one). `CLAVIX_KEYS_MASTER_KEY` encrypts them: one key or a comma-separated keyring, first = current (README, "Signing keys"; rotation runbook in `docs/operations.md`: `bun run keys:reseal`, which must cover **every store sealed under the keyring** (signing keys, TOTP secrets, and the `createSecretBox` stores in `SECRET_STORES`, `src/modules/keys/keys.types.ts`, run by `keys.reseal.ts`: each service's `resealSecrets(tenantId)`; a new sealed store adds its entry there, and the old key is dropped only when the report's `oldKeyNeededBy` is empty), and `bun run keys:rotate <tenant>|--all [--drop-old]` for the emergency rotation). `withPublicDocuments` (`src/oauth/public-documents.ts`) serves the JWKS and discovery documents from memory (key `<tenantId>.<version>.<keys generation>`, 60 s TTL, ETag and 304); `createTenantKeys` bumps the generation on every key insert, promote or retire, so a key write goes through `signingKeysFor`; a write from another process (the `keys:rotate` CLI, another instance) shows only when the TTL ends. Sign and
verify through the janus store; never log a key record, never read `oauthSigningKeys` raw
outside the specs.

## Tenants by script

`bun run tenants:create` (`src/scripts/tenants-create.ts`, README "Tenants") creates a tenant by script (the console API's
`createTenant` does too). It only parses flags (`src/modules/tenants/tenants.cli.ts`) and calls `TenantsService.register`,
which goes through `TenantsService.create` (the one place for slug rules,
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
  role on `clavix` never writes there (`console/modules/platform-writes.spec.ts`). Deleting a `clavix` user
  also removes their console relations (`access.removeUser`); every mutation that changes the account of a `clavix` user
  who holds a platform role or owns a tenant needs platform `manage` (`keepOwners`, `src/modules/users/users.owners.ts`: disable, enable,
  delete, `revokeUserSessions`, `setUserEmailVerified`, `resetUserSecondFactor`). A new user mutation goes through it with its `OwnerChange` kind.
- **A slice adds a module** under `src/modules/<name>/` (`<name>.console.graphqls`, `<name>.console-resolver.ts`,
  `<name>.console-guards.ts` with the guards and the audit action of each mutation: "Admin events" below) and lists it in
  `src/console/modules/index.ts`. A16 folded the admins, audit, branding, oauth-policy, me and tenants modules the same way, so `src/console/modules/` keeps only the registry (`index.ts`), the shared helpers (`ids.ts`, `refusal.ts`, `user-key.ts`, `reserved.ts`, `catalog-support.ts`, `issuer.ts`) and the cross-module specs (me: `me.console-resolver.ts`, `-support`, `-guards`, `me.utils.ts`, `me.types.ts`, `index.ts`; admins: `AdminsService` in `admins.service.ts` (the console's plugin builds the one instance over its own ports, as `ctx.members`; no config wiring or registry entry, since only the console uses it and its specs override those ports), `.types`, `.hooks`, `.janus`, `.utils` (`roleOf` too), `.errors`, `index.ts`, with the console resolver split into `-queries`, `-mutations` and `-support`); `codegen.ts` leaves every `*.console.graphqls` out of the hosted types, as the hosted schema does.
- **`clients` and `resources`** (issue #9) are thin: their console resolvers (A14: `<name>.console-resolver.ts`, with
  `-guards`, `-support`, and for resources `-queries` and `-mutations`; the SDL is `<name>.console.graphqls`, the shapes
  and the input mapping `<name>.utils.ts`) call `ClientsService`
  (`src/modules/clients`, wired in `src/config/clients.ts`) and `ResourcesService`
  (`src/modules/resources`), after `liveTenant` (`catalog-support.ts`: a suspended tenant is
  readable, its writes are refused by the guard; a trashed one is `NOT_FOUND`). Queries are `onTenant("view")`, mutations `onTenant("edit")`; each mutation records
  its admin event (`client.create`, `client.rotateSecret`, `resource.delete`, `scope.update`, ...:
  the target is the client id or the document id, never a secret; a delete records on a repeat
  too, and `deleteResource` one `scope.delete` per scope it removed). The `operators:grant` script records
  `operator.grant` the same way (platform target, no tenant). `test/console.ts`
  (`consoleAs(userId)`) runs the real console app with a stubbed token check.
- **The console's own client and resource** (`console` in the `clavix` tenant, the migration's) are
  refused by `console/modules/reserved.ts`: no update, rotation or deletion of the client, no deletion of
  the resource or its scopes through the API (it would lock every operator out); scripts still can.
- **Clients are listed from the janus store** (`ClientsService`, `src/modules/clients`): the
  tenant's partition store answers `listClients` in id order, and each record is mapped to a
  `ClientView` there, so a `secretHash` never reaches a resolver or a GraphQL type. The store has
  no search: `q` is applied by `listClientViews` (`clients.search.ts`), which reads what the page still lacks until it is full
  (at most 20 reads, then a short page with its cursor), so the store's cursor stays the page's. `totalCount` (`countClientViews`, same filter, every page read at 100) ignores the cursor.
  `deleteClient` deletes the client, then calls `revokeClientGrants` (grants and tokens), on a
  repeat too. `Client.grantTypes` shows what the record holds, and janus-oauth 0.13 enforces it (`unauthorized_client` on `/authorize`, the code exchange and the refresh grant); the console sends no list, so a console client takes the default `authorization_code` + `refresh_token`. The store
  has no insert-only write, so `createClient`, `updateClient`, `rotateClientSecret` and `deleteClient` run under `ctx.exclusive(clientsKey(tenant), ...)` (a racing delete never brings a client back; an update or rotation of a missing client is `NOT_FOUND`, from `ClientsService.require` inside the lock; `ClientsService.refuseAgent` answers `NOT_FOUND` first for an agent on `updateClient`, `rotateClientSecret` and `setClientTokenExchange`, before any validation; agent reads are bounded by the ids resolved: `kinds`/`registeredAt` take them, `AgentsFor(request, clientIds)`)
  (`console:clients:<hex>`, the same queue and Redis lock as the admins): the id check and the
  upsert of two creations of one id are never interleaved (one wins, the other is `CONFLICT`), and
  the `clients` quota (`assertClientQuota`: `usageService.count` against `quotasOf`, `QUOTA_EXCEEDED`)
  is read under it, so concurrent creations cannot pass the limit together. `deleteClient` leaves a
  record that is not a registered one (`source` other than `registered`: a metadata-document client)
  alone and answers false, and records `client.delete` only for a registered client or for a valid id
  that names nothing (a retry may be the event the first run missed); an id no client can have, and an
  untouched foreign record, name nothing to record. A deleted client's grants are revoked, so its
  access and refresh tokens stop working (`src/modules/clients/clients.console.spec.ts`).
- **Admins of a tenant and invitations** (`src/modules/admins/`, README "Admins of a tenant"): a
  membership is a relation (`access.holders` / `grantTenant` / `revokeTenant`). Every write of a
  tenant's memberships runs under `ctx.exclusive(membersKey(tenantId), ...)` (`exclusive.ts`: a queue
  per key in the process, plus the app's Redis lock when there is one, `config/exclusive.ts`): the
  relation store has no conditional write, so the last-owner check (`LAST_OWNER`) only holds under it.
  Go through `AdminsService.changeRole` / `removeMember` (`admins.service.ts`, on the context as `ctx.members`); never grant or revoke a tenant role bare.
  **One owner rule** (`AdminsService.otherLiveOwners`, `admins.service.ts`): an owner counts only while they exist and can
  sign in (`directory.findUser(...).active`). `AdminsService.setRole` (private), `keepOwners` (`src/modules/users/users.owners.ts`: disable,
  delete and un-verify of a `clavix` user (`OwnerChange`; `touch` checks the caller only, no count), tenant ownerships and the last live platform owner, under
  `PLATFORM_OWNERS_KEY` then the members locks) and the accept hooks (`admins.hooks.ts`: no `owner` for a
  ghost, a deleted or disabled inviter) all use it. A repeat `disableUser` or un-verify is never `LAST_OWNER`.
  Invitations are **not** the console's own: `InvitationsService` (`src/modules/invitations/invitations.service.ts`;
  `bind(source)` gives the per-tenant `TenantInvitations`, wired by `invitationsOf` in `src/config/invitations.ts`) issues,
  mails, lists and revokes the invitations of any tenant's user pool, and a users slice reuses it
  (never copy it). An admin invitation is one of the `clavix` tenant under the scope
  `adminScope(tenantId)` (`src/modules/invitations/invitations.rules.ts`, `admin:<id>`); **only that scope grants a console
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
  `invite` is guarded by `InvitationsService.guardInvite` (`src/modules/invitations/invitations.service.ts`, rules in `invitations.rules.ts`, from the stored pending list, so no Redis and
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
  once by the migration (not in tests). `console-seed.ts` is frozen and self-contained: it imports nothing from `src/config`
  (the clock is `new Date()`, the client lists no detail types through a local `noDetailTypes`).
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
  sign-in resolvers through `recordingSignIn` / `recordSignOut` (`modules/auth/auth.events.ts`: code,
  magic link, passkey, social), and the per-tenant janus `events` listener (`events/janus-listener.ts`:
  second factor, recovery codes, passkeys; no address). A new type goes in `AUTH_EVENT_TYPES` (closed).
  OAuth events (M4 E3, D14): `createClavixOAuthIssuers({ eventsFor })` gives each tenant's issuer its own janus-oauth `events` listener (`events/oauth-listener.ts`, built per tenant and dropping an event of another issuer; wired in `config/oauth.ts`): `consent.granted` / `.denied`, `grant.revoked`, `refreshToken.reused`, `device.approved` / `.denied`, `token.exchanged`, `client.registered`, with client and user, no address, no client name; `oauth.client.loginFailed` is not recorded (telemetry's).
  Reads: console `authEvents` (`edit`, an admin: addresses) and `adminEvents` (`view`), and by id
  `authEvent(tenantId, id)` / `adminEvent(tenantId, id)` (same permissions; `null` for an unknown or
  another tenant's id, `find` on the reader and the service),
  `platformAdminEvents` (operators). The full IP stays in `authEvents` only (D15). Retention
  (`modules/audit/audit.retention.ts`, queue `audit-retention`, 04:17 UTC, `config/audit-retention.ts`) cuts by the
  tenant's current plan (`Plan.auditRetentionDays`) as `system:audit:retention`, with no event per deletion.
- **Export (M4 E2, D17)**: `GET /console/audit/export` (`src/console/audit-export/`: `export.ts` handler, `params.ts`, `columns.ts`, `body.ts`, `serveAuditExport`, mounted
  by `createApp` beside `/console/graphql`, in the Caddyfile `@api` matcher) authenticates like the GraphQL API
  (`authenticated` in `plugin.ts`, the DPoP proof's `htu` being the export path), then a verified e-mail, `view`
  for `log=admin`, `edit` for `log=auth` (through `permitted`, so the platform's `edit` on the `clavix` tenant). The range is cut to the plan's retention, at most 100 000 rows
  (`ConsoleDeps.auditExport` is required: `throttle` is bound by `src/config/console.ts` (`unthrottled` without Redis), `maxRows` is optional and a spec overrides it; `exceeds` reads at most one row past the limit, no full count), a per-tenant budget (`throttle.ts`, limit `auditExport`, `CLAVIX_EXPORT_TENANT_*`, 429; Redis only, down: allowed and logged), streamed with `reader.stream` / `authEventsService.stream`
  (`modules/audit/audit.utils.ts`, 500 rows per batch, one row per pull). `auditLog.export` is recorded, awaited,
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

## End-user roles (`src/modules/roles`)

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
  `RolesService` (`roles.service.ts`) holds every method, `roles.rules.ts` the input checks, `roles.utils.ts` the claim join and the
  sorting, `roles.errors.ts` the refusal builders, `catalog-support.ts` the one `refusing` for `CatalogError` and
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
  role check, through `requireVerifiedEmail` (`src/modules/users/users.verified-email.ts`, reusable by the
  future e-mail change) and `ConsoleDirectory.emailVerified(id)` (false for an unknown user, throws when the clavix tenant is unavailable), read once per request
  (`callerProved`). `Me.memberships` and `Me.switchableTenants` call `verifiedCaller` themselves: they
  are tenant data under the open `me`. `signedIn()` also needs the proof; a new field never opts out. Operators are held to it (the
  ADR-0039 exception is about the target tenant). Accepting an invitation proves the address (janus
  `invitations.accept`; `src/modules/admins/admins.lock.console.spec.ts` covers it). Specs: `consoleAs(id)` and `verifiedCallers(deps)`
  in `test/console.ts` count the caller as proved; `src/console/console.spec.ts` covers the gate over the real
  wiring.
- `test/oauth-flow.ts` runs a real authorize/approve/token flow against the test database (specs that
  read a token's content; its request and code-flow steps are in `test/oauth-flow-steps.ts`).

## Branding (`src/modules/branding`, with its `branding.console-*` files)

A tenant's brand is one tenant-owned document (`branding`, unique on `tenantId`), reached only through
`BrandingService` (`branding.service.ts`, built in `config/branding.ts`), which scopes every read and write with `scopeToTenant`.
- **The theme is compiled on write, served as stored** (`branding.theme.ts`): `validateThemeInput`, then
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
- **The logo** (`src/modules/branding/branding.logo.ts`, `branding.logo-route.ts`) is a PNG, JPEG or WebP of at most 256 KiB, checked by its
  magic bytes and stored inline; never SVG (it runs script on the tenant's own host). Its sha256 is the
  `ETag`, and `immutable` is sent only when `?v=` names the current image (`logoUrl`).
- **Two schemas**: the console's `branding` / `updateBranding` (guards `view` / `edit` on the tenant)
  live in `src/modules/branding` (`branding.console-resolver.ts`, `-guards`, `-support`); the anonymous `tenantBranding` by host is in
  `src/modules/branding` and shows only what a hosted page draws (no seed, no tenant id).

## Tenants, plans, usage and the trash (`src/modules/tenants`, `src/modules/usage`; its console files are `tenants.console-*`)

- Layout (A5): `tenants.model.ts`, `.plan.ts`, `.trash.ts`, `.hooks.ts`, `.rules.ts` (slug rules), `.utils.ts`
  (hosts, issuers, partitions, list filters, `stateOf`), `.errors.ts`, `.types.ts`, `.cli.ts`, the purge queue and
  worker (`.purge-queue.ts`, `.purge-worker.ts`), and `tenants.service.ts`: one service per domain (owner,
  2026-11-20), `TenantsService` (`config/tenancy.ts`: `tenantsService`), holding every business method: create and
  `register` (script), the status flips, `update`, `setPlan`, `updateSignIn` / `updateOAuth`, `replaceSocial`,
  `find` / `get` (trash included, a purging tenant is gone), `list`, `count`, `trash`, `restore`, and the purge
  (`purgeDue`, `claimPurge`, `markPurged`, `purge`). Every write drops the tenant's hosts from the resolver's
  cache. No split by action; the cap is per method (50 lines or more is a finding, 80 the hard cap); its spec
  `tenants.service.spec.ts` sits beside it. `index.ts` is the import surface for other modules (the purge queue
  and worker are imported by file in `server.ts` and `config/redis.ts`, so the barrel never loads the queue), and
  `src/modules/services.ts` wires `tenants`.
- **State**: `stateOf` = `active` | `suspended` | `deleted` (the trash), or `null` once the purge started.
  The resolver returns suspended and deleted tenants (`ResolvedTenant.status`); a caller that serves a
  tenant checks `isLive` (`tenancy/live.ts`: `requireLive`, `TENANT_SUSPENDED`, 403). Enforced on
  `requestSignInCode`, `verifySignInCode`, `requestMagicLink`, `confirmMagicLink`, `requestEmailVerification`, `confirmEmailVerification`, the passkey sign-in, `requestSecondFactorPasskeyOptions`,
  `socialSignInStart`, `socialSignInComplete`, `acceptInvitation` (on the tenant's own host: an end-user invitation of a suspended tenant is refused before the code is read),
  and `/authorize` and `/token` (`oauth/tenant-state.ts`, a 403 JSON `access_denied`, not a redirect).
  Discovery, jwks, userinfo, introspect, revoke, `signOut` and `currentUser` keep answering: tokens
  already issued live to expiry, and the console stays readable.
- **Plans** (`tenants.plan.ts`): `free`, `pro`, `enterprise`; `effectiveQuotas` = plan, then the tenant's
  `quotaOverrides` (setting a key to `null` removes the override; an override cannot express "no limit").
- **Usage** (`UsageService`, `config/usage.ts`): monthly active users are a Redis unique counter
  (`clavix:usage.mau`, 400 days), counted at sign-in, passkey and social sign-in and a successful `/token` (the `sub`
  of a user's access token, so refreshes count; a client_credentials token, whose `sub` is its client id, counts nobody) and an `acceptInvitation` that signs the new account in (#176); `recordActive` never throws. Without `REDIS_URL` nothing is counted (the stored month is read). The month is snapshotted in
  `usageCounters` (tenant-owned) when read, never lowered. Clients are counted in
  `oauthPartitionedClients` by `partition`; domains are counted from `domainsService`. `assertWithinQuota`
  / `QuotaExceededError` (`QUOTA_EXCEEDED`, 409) is for the hard quotas, used by the creations of
  clients (A2) and domains (A4); MAU is a soft meter (`exceeded`), it blocks nothing.
- **Trash and purge**: `deleteTenant` soft-deletes; `purgeAt` = `deletedAt` + 30 days. `TenantsService.purge`
  claims (`purgeStartedAt`: it resolves nowhere, cannot be restored), purges the janus
  partition, the tenant-owned collections (`ownedPurgers`, by `isOwned`: `adminEvents` is the platform's
  record and stays), the roles and platform link (`access.removeTenant`), then `markPurged` leaves a
  tombstone (slug, `deletedAt`, `purgedAt`) that keeps the slug reserved. The Redis MAU counters (hashed, no user ids) are not deleted: they expire on their own after 400 days.
  A failing tenant stays
  claimed and the next run resumes it. **The janus part** is `createPartitionPurger(oauthDb)`
  (`src/config/partition-purger.ts`, the `PartitionPurger` port): `purgeMongoOAuthPartition`,
  `purgeMongoStoresPartition` and `purgeMongoInvitationsPartition` for the tenant's partition (its hex
  id), refusing `default` and empty; it answers the counts per collection, which the job logs. **Scheduled**
  by the `tenant-purge` queue (`tenants.purge-queue.ts`, daily cron `17 3 * * *`, `tenants.purge-worker.ts`
  `startTenantPurge` in `src/server.ts`, one pass at start; without Redis only that pass). Only
  tenants deleted 30 days ago or more are touched. A new tenant-owned
  collection needs nothing here, but is a purge target: keep it behind `tenantOwned`.
- **Console API**: `tenants`, `tenant`, `plans`, `usage` and the seven mutations are in
  `src/modules/tenants` (`tenants.console-resolver.ts` with its `-queries`, `-mutations`, `-support`, `-errors`, `-parent` and `-guards`), with their audit actions (`tenant.create`, `.update`, `.setPlan`,
  `.suspend`, `.resume`, `.delete`, `.restore`). Only `updateTenant` is open to a tenant admin (refused with `TENANT_SUSPENDED` while the tenant is suspended); the rest
  is platform-only. The `Tenant` parent is `TenantParent` (codegen mapper), so `Me.memberships` keeps
  working with the extended type.
- **Still public for a suspended or deleted tenant**: the anonymous `tenantBranding` and the logo by host
  (a hosted page can show its suspended screen); `createTenant` repeated with the same slug, name, plan
  and sign-up returns the tenant and records the event again (a retry after a failed record).
  Dynamic registration is per tenant (`oauth.agents.dynamic`); `tenant-state.ts` refuses `/register` for a suspended tenant (`REFUSED_PATHS`).
  `subjectAgents` (a client's token exchange rules) lets it exchange the tokens of the tenant's agents; `AgentCheckFor` (`src/oauth/ports.ts`) tells an agent apart, from the tenant's own scope.

## Custom domains (`src/modules/domains`, console side folded in by A15: `domains.console.graphqls`, `domains.console-resolver.ts`, `-guards`, `-support`)

A tenant adds a host (`addDomain`), publishes `_clavix.<host> TXT clavix-verify=<token>`, then
`verifyDomain` reads it through the `TxtResolver` port (`domains.dns.ts`; specs inject a fake, only
`src/config/domains.ts` wires the real resolver). `DomainsService` (`domains.service.ts`) is the
only way into the `domains` collection and runs the periodic recheck (`recheckAll`) too; the DNS
comparison is `domains.check.ts`.
- Layout (A9): `domains.model.ts`, `.errors.ts` (the codes and the refusal builders), `.rules.ts` (the host rules
  `normalizeDomainHost` / `txtNameOf`, the cooldown, the recheck grace decision `recheckOutcome`, the cache host
  lists), `.utils.ts` (`mintToken`), `.check.ts`, `.dns.ts`, `.events.ts`, `.notice.ts`, `.tls-ask.ts`, `.tls-limit.ts`,
  `.well-known.ts`, `.recheck-queue.ts`, `.recheck-worker.ts`, and `domains.service.ts`: one service per domain
  (owner, 2026-11-20), `DomainsService`, holding every business method (reads, `add`, `verify`, `setPrimary`,
  `remove`, `deleteOwnedBy`, `recheckAll`; the former `DomainRecheck` and `promoteClaim` are merged into it), its spec
  beside it. There is no resolver (the console module is the caller). `index.ts` is the import surface;
  `domains.recheck-queue.ts` (Redis) is imported by file from `src/config/redis.ts`, `domains.recheck-worker.ts` from
  `src/server.ts` and `src/config/domains-job.ts` (wiring, so the barrel never loads
  Redis), and `domains.errors.ts` by `src/i18n/codes.ts` as every module's errors are. The service is built in
  `src/config/domains.ts` (`createDomainsService`, called by `src/config/tenancy.ts`, which gives it the resolver's
  invalidation) and registered as `services().domains`. `domains` stays a platform collection.
- Layout (A10): `auth`, `mfa` and `passkeys` are flat `<name>.<role>.ts` modules, one service per domain (owner,
  2026-11-20): `AuthService` (`auth.service.ts`: current user, sign-in code, magic link, e-mail verification, sign-out),
  `MfaService` (`mfa.service.ts`: the second factor, step-up, passkey confirm; it builds janus-graphql's
  `secondFactorResolvers` and `passkeyResolvers`) and `PasskeysService` (`passkeys.service.ts`: list, sign-in,
  registration, removal), each built in `src/config/<name>.ts`, registered in `services()` and called by a thin
  `<name>.resolver.ts`. Each module also has `.errors.ts` (codes and refusal builders), `.types.ts` (ports), `.utils.ts`
  and specs beside every file that holds code; auth adds `.events.ts`, `.outbox.ts`, `.throttle.ts`,
  `.verification-throttle.ts` and `.plugin.ts`, mfa `.challenge.ts`, passkeys `.throttle.ts`. The barrels (`index.ts`)
  are the only cross-module entry and leave out the resolvers (`modules/index.ts` imports them by file). Deep imports are the
  ones listed under "Cross-module imports" above (A29). Behaviour,
  throttles, error codes, timing and cookies are unchanged.
- Layout (A11): `consent`, `invitations` and `branding` are flat `<name>.<role>.ts` modules, one service per domain
  (owner, 2026-11-20): `ConsentService` (the `/consent` and device hooks, the step-up refusal, the labels, the revocation
  of replaced grants and its worker), `InvitationsService` (preview, accept, and `bind(source)` for a tenant's pool) and
  `BrandingService` (read, `view`, `update`), each built in `src/config/<name>.ts`, registered in `services()` and called
  by a thin `<name>.resolver.ts` (consent's builds janus-oauth's `oauthResolvers`). Each has `.errors.ts` (codes and
  refusal builders), `.types.ts`, `.utils.ts` (invitations and consent), `.rules.ts` (invitations) and specs beside
  every file that holds code. The barrels (`index.ts`) leave out the resolvers (`modules/index.ts` and `http/schema.ts`
  import them by file). Deep imports are the ones listed under "Cross-module imports" above (A29): `consent.device-throttle`, `consent.queue`,
  `consent.plugin` (`app.ts`), and `.errors` files (`i18n/codes.ts`); the leaf readers, `invitations.rules`,
  `invitations.types` and `branding.logo-route` are now exported by their barrels. Behaviour, throttles, error codes and mail timing are unchanged.
- Layout (A12, roles): `roles` is a flat `<name>.<role>.ts` module with one service, `RolesService` (every method of
  the roles and their assignments: the CRUD, `assign`, `members`, `memberCounts`, the `roles` claim), built in
  `src/config/roles.ts` and registered in `services()`. The four helper files that imported their types back from the
  service (`role-assignments`, `role-claims`, `role-counts`, `role-crud`, the four roles import cycles) are folded into
  it; the types are in `roles.types.ts`, the input checks in `roles.rules.ts`, the pure claim, sort and count helpers in
  `roles.utils.ts`, the refusal builders and codes in `roles.errors.ts`, each with its spec, and `roles.service.spec.ts`
  runs the service on the test database. No hosted resolver: the roles are console-only (A14 folded
  `src/console/modules/roles` into the module: `roles.console.graphqls`, `roles.console-resolver.ts` with its `-support` and
  `-guards`, `roles.console.spec.ts`; the member and count shapes and the audit target are in `roles.utils.ts`). The barrel (`index.ts`) exports the service, the error and the types; `i18n/codes.ts`
  imports `codes` through the barrel. Behaviour, error codes and throttles are unchanged.
- Layout (A12, audit, agents, usage): the three modules are flat `<name>.<role>.ts`, each with one service built in
  its `src/config/<name>.ts` and registered in `services()` (`audit`, `agents`, `usage`). `AuditService`
  (`audit.service.ts`: `record`, `page`, `find`, `exceeds`, `stream`, `deleteBefore`; the config export is still
  `authEventsService`), `AgentsService` (`agents.service.ts`; export `agentClientsService`) and `UsageService`. The
  filter, the stored-event mapping, the keyset drain and the batch sizes are in `audit.utils.ts`, the types in
  `*.types.ts`, the collections in `audit.model.ts` and `agents.model.ts`; usage keeps `usage.utils.ts` (month,
  meter, `messageOf`), `usage.rules.ts` (`assertWithinQuota`), `usage.errors.ts` (`QuotaExceededError`) and
  `usage.counter.ts` (the MAU counter). The jobs follow the webhooks precedent: `agents.prune*.ts` and
  `audit.retention*.ts` (job, queue, worker) stay separate role files, their queues and workers outside the barrels
  (the barrels export `pruneAgents`, `enforceRetention`, `authRecorder`, `monthlyActiveUsers`). Neither audit nor agents raises a coded error, so neither has an `.errors.ts`. Modules
  that check quotas import `usage.errors`, `usage.rules` and `usage.utils` through the usage barrel. No hosted resolver (console-only until A13/A14). Behaviour is unchanged.
- Layout (A22, clients): `clients.service.ts` (one `ClientsService`: listing, writes, token exchange rules and deletion, `refuseAgent` and `require` private), `clients.types.ts`, `clients.rules.ts` (+ spec), `clients.validate.ts` (+ spec), `clients.register.ts` (`registerClient`, `registerForTenant`), `clients.detail-types.ts`, `clients.search.ts`, `clients.utils.ts`, `clients.cli.ts`, the console files (`clients.console.graphqls`, `clients.console-resolver.ts` with its `-guards` and `-support`), and `index.ts`, the entry other modules import (`registerClient`, `ClientsService`, `clientsKey`, the grants, the CLI parser; the console resolvers stay imported by file from `console/modules`). `services()` has a `clients` entry (`config/clients.ts`).
- Layout (A12, client-policies, oauth-policy, health): `client-policies` and `oauth-policy` are flat
  `<name>.<role>.ts` modules with one service each (`ClientPoliciesService`, `OAuthPolicyService`), built in
  `src/config/client-policies.ts` and `src/config/oauth-policy.ts` and registered in `services()` (`clientPolicies`,
  `oauthPolicy`; the console's `wiring.ts` is gone). Rules: `client-policies.rules.ts` (`validateTokenExchange`),
  `oauth-policy.rules.ts` (`applyAgentsInput`, `sameAgents`, `agentsNeedPushOrProof`). `oauth-policy` also has
  `oauth-policy.types.ts` and `oauth-policy.errors.ts` (`tenantNotFound`, `badAgentsInput`, `policyConflict`: same codes
  and messages as before). `oauth-policy.schema.ts` and `health.resolver.ts` are imported by file, not
  through the barrels (the tenants model, the OAuth ports and `config/telemetry` would close a cycle). `health` needs no
  service: it is a probe (`health.ready.ts`), a version (`health.version.ts`) and a resolver (`health.resolver.ts`).
  Behaviour is unchanged.
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
  `usage.domains` is `domainsService.count`. These slice decisions stand (issue #127): pending
  claims count toward the quota; a lapsed primary keeps resolving but the TLS ask refuses it;
  recheck every 6 h with a 7-day grace.
- `verifyDomain` is held to one check per claim per 60 s (`VERIFY_COOLDOWN_SECONDS`, from the
  claim's `checkedAt`): `VERIFY_COOLDOWN` (429) with `extensions.retryAfter`, no lookup made.
- The platform's own changes are admin events too: `domain.lapse` (recheck, actor
  `system:domains:recheck`) and `domain.evict` (a verification removing another tenant's claim,
  actor `system:domains:verify`), recorded through `DomainsServiceOptions.record` (`domains.events.ts`,
  wired in `src/config/domains.ts`); a failure to record is logged, never fails the write.
- The primary is explicit (`setPrimaryDomain`, ADR-0032); the issuer follows it (resolver
  `toResolved`), the passkey rpId stays the slug host (`slugIssuer`, `src/modules/users/users.rp.ts`,
  ADR-0036). The primary cannot be removed. The slug host keeps serving.
- `recheckAll` runs every 6 hours (`domains.recheck-queue.ts`, started in `src/server.ts`). A record
  missing for 7 days makes the domain `unverified` (it stops serving and no certificate is
  issued) and the tenant's owners are e-mailed once (`domains.notice.ts`). A lapsed primary keeps its
  flag and keeps resolving: the issuer never moves silently. A DNS failure changes nothing.
- A host that maps to a non-live tenant behaves like the default host: callers check `isLive`.
- **TLS ask** (`domains.tls-ask.ts`, `GET /internal/tls/ask?token=&domain=`): 200 only for a verified
  domain of a live tenant or a platform host (apex, `console.`, the slug host of a live tenant: `allowedPlatformHost`), 429 past `CLAVIX_TLS_ASK_LIMIT`/min (`@softistx/redis`; **fails closed**
  when Redis is down: refused, with a warning, `tlsAskGate`; **spent after the lookup**, by known hosts only, so a flood of unknown names
  cannot use up the budget real domains need, #328), a bare 404 for everything else (wrong or unset `CLAVIX_TLS_ASK_SECRET`,
  proxied requests carrying `X-Forwarded-*`, `X-Real-IP` or `Forwarded`, garbage, unknown, pending, lapsed, suspended).
  The app has one listener: keep `/internal/` off the public proxy (`deploy/Caddyfile` does). No ACME client lives here. Going live (Dockerfile, `deploy/`, `scripts/mongo-*.ts`, `/readyz`) is in `docs/operations.md`.
- `/.well-known/webauthn` on a live tenant's slug host lists its verified domains' origins
  (Related Origins). The passkey layer accepts the same origins (`relatedOriginsOf`, `src/modules/domains/domains.well-known.ts`).

## Webhooks (`src/modules/webhooks`, console side folded in by A15: `webhooks.console.graphqls`, `webhooks.console-resolver.ts`, `-guards`, `-support`, `-parent`; `src/config/webhooks.ts`)

A tenant posts its events to its own endpoints (M4 W1, D19-D22, issue #22).
- Layout (A6): `webhooks.model.ts` (both collections), `.errors.ts`, `.rules.ts` (input rules, the roll),
  `.utils.ts`, `.types.ts`, `.events.ts`, `.notice.ts`, `.url-policy.ts`, `.delivery.ts`, the secrets-prune
  files (`.secrets-prune.ts`, `.secrets-prune-queue.ts`, `.secrets-prune-worker.ts`), and `webhooks.service.ts`:
  one service per domain (owner, 2026-11-20) holding the endpoint methods (`listEndpoints`, `createEndpoint`,
  `rollSecret`, `deliveryEndpoints`, `resealSecrets`, `recordDelivered`, `recordGiveUp`, ...) and the attempt
  log (`recordAttempt`, `listAttempts`, `deleteAttempts`). `index.ts` is the import surface; the prune queue and
  worker are imported by file. Registered as `services().webhooks`.
- `webhookEndpoints` and `webhookDeliveries` are tenant-owned: reached only through `WebhooksService`
  (`scopeToTenant`; the files allowed in `guards.spec.ts` are `src/modules/webhooks/` and
  `src/config/webhooks-service.ts`). Its quota is `webhooks` (free 2, pro 10, enterprise 50),
  checked on create under `ctx.exclusive("console:webhooks:<tenantId>")`.
- One process-wide `webhooks()` (`webhooks.delivery.ts`, wired in `src/config/webhooks.ts`) serves every
  tenant: its endpoint resolver reads the endpoints of `event.data.tenantId` at each attempt, so a
  rolled secret or a switched-off endpoint is honoured by a retry, and another tenant's events never
  reach an endpoint. It is a bus subscriber (`relay`); the queue is Redis (`createRedisWebhookQueue`,
  prefix `clavix:webhooks:`) when `REDIS_URL` is set, memory otherwise; `server.ts` closes it on stop.
- **Queue caps (G2-03, nxgt-janus #974/#982)**: `webhookQueueLimits` (`src/modules/webhooks/webhooks.delivery.ts`, applied in `src/config/webhooks.ts`) gives both
  queues (Redis and memory) `maxInFlight` (`CLAVIX_WEBHOOKS_MAX_IN_FLIGHT`, 4), `maxPending`
  (`CLAVIX_WEBHOOKS_MAX_PENDING`, 5000) and `groupOf`. **Assumed, not answered**: the caps are per tenant, not
  per endpoint, because janus-webhooks counts per group once `groupOf` is set (one queue cannot cap both). So the
  queue's endpoint name is `<tenantId>.<endpointId>` (`queueEndpointId`, `webhookGroupOf`, `endpointIdOf` in
  `webhooks.delivery.ts`): the resolver adds the prefix and every callback strips it before it touches a store. The
  claim also rotates over endpoints, so one endpoint of a tenant does not take the tenant's whole share.
- **Console budgets (`src/console/budgets.ts`, #328)**: `ctx.budgets` (`ConsoleDeps.budgets`; undefined without Redis) holds the
  `@softistx/redis` limits of the console mutations that act outside the platform. `sendTestWebhook` spends
  `budgets.testWebhook` (5/min per endpoint, then 20/min per tenant, `CLAVIX_WEBHOOK_TEST_*`) once the endpoint is found
  and enabled, before the address check and the queue. `inviteUser` / `inviteAdmin` spend `budgets.invitation` (200/h per
  tenant, both together, `CLAVIX_INVITE_TENANT_*`) just before the invitation is issued, and the per-caller budget
  (60/h per mutation, `CLAVIX_INVITE_CALLER_*`) is `@softistx/alxia-graphql`'s `fieldRateLimit` (`useInviteBudget`, right after `useClientHeader` in the
  console's plugins in `app.ts`), which counts every aliased selection before anything runs. Refusal: `RATE_LIMITED` 429,
  `extensions.retryAfter` and `Retry-After`. Redis down: allowed and logged, as the audit export. A new console mutation
  that sends a mail or queues outbound work gets its budget here, never a counter of its own.
- The catalogue (D22, `webhooks.events.ts`) is janus's 16 user events (without `user.apiKeyCreated` / `user.apiKeyRevoked`, which never fire until API keys are adopted, and `user.passwordReset` / `user.passwordChanged`, which cannot fire while password sign-in is unavailable; #336) plus `session.signedIn`; `data` holds ids
  only, never an address or an e-mail (D15). `tenantId` is in `data` because the wire body has no
  top-level field for it. Console admin events are not delivered. `webhook.test` is outside the
  catalogue and goes to one endpoint, whatever its types.
- Secrets (D19): `whsec_`, sealed with `webhookSecretBox` (its own subkey label) with the context
  `<tenantId>:<endpointId>`, returned once by `createWebhookEndpoint` and `rollWebhookSecret`. A roll with
  `keepPrevious` keeps the old secret signing for 24 h (both signatures sent); without it, it is dropped
  at once. `webhookSecretsPrune` (daily 04:37) removes expired ones; they are ignored at send time anyway.
- URL policy (D21, `webhooks.url-policy.ts`): `https`, no credentials, public addresses only, checked on save
  and again by `guardedFetch` on every send (a DNS rebinding is refused; redirects are never followed).
  `CLAVIX_WEBHOOKS_ALLOW_PRIVATE` lifts the address check for development and is refused in production.
  A check and the connection resolve the name separately (documented in `webhooks.url-policy.ts`).
- Auto-disable (D20): 5 given-up deliveries in a row (`retriesRanOut` only; a 2xx resets the run)
  switch the endpoint off, record the admin event `webhook.disable` (actor `system:webhooks:disable`)
  and e-mail the owners (`webhooks.notice.ts`, origin only). An admin switches it on again with
  `updateWebhookEndpoint(enabled: true)`, which re-checks the address.
- Deliveries log (W2): `onAttempt` writes `webhookDeliveries` through `WebhooksService.recordAttempt`
  (tenant-owned, same allowed files): event id and type, attempt, status or failure name, duration,
  `delivered`, `willRetry`, `at`; never the URL, a header or a body. A TTL index on `at` (7 days) and a trim
  to the newest 100 per endpoint on each write; a failed write is only logged. `WebhookEndpoint.deliveries(first:)`
  reads them (parent `WebhookEndpointParent` carries the tenant id); deleting an endpoint deletes its attempts.
- Admin events: `webhook.create|update|delete|rollSecret|test`; none carries a secret.

## Enterprise OIDC connections (`src/modules/connections`, console side folded in by A15: `connections.console.graphqls`, `connections.console-resolver.ts` with its `-queries`, `-mutations`, `-guards`, `-support`; `src/config/connections.ts`)

- Layout (A4): `connections.resolver.ts` (+ `.resolver-support.ts`), `.errors.ts`, `.rules.ts`, `.utils.ts`,
  `.types.ts`, `.record.ts`, `.discovery.ts`, `.sso-gate.ts`, and `connections.service.ts`: one service per domain
  (owner, 2026-11-20), `ConnectionsService`, holding every business method of the domain and the single entry point,
  with no split by action and no facade; the 250-line cap is per method there (a method of 50 lines or more is a
  finding, 80 is the hard cap), and pure parts go to `.rules.ts` / `.utils.ts` / `.errors.ts`; its spec
  `connections.service.spec.ts` sits beside it. `index.ts` is the import surface for other modules, and
  `src/modules/services.ts` wires `connections` (D10; the service stays built in `src/config/connections.ts`, which
  holds the specs-only seams, so `services()` returns the process-wide instance until a consumer needs a per-request
  one: D10 follow-up). Deep imports allowed: `src/config/connections.ts` (the wiring that builds the service) and
  `src/i18n/codes.ts` (the code inventory). `modules/index.ts` imports `connections.resolver.ts` by file, because the
  barrel would close an import cycle with the config wiring.
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
- `ConnectionsService.sourceOf(tenantId)` is the janus `ConnectionSource`; `users.social.ts` wires it as
  `social.resolveProvider` through `oidcConnections` (one redirect URI per connection:
  `<issuer>/sign-in/social/<id>/callback`, the hosted UI's callback route). Every tenant's janus instance carries it, so the static-social
  gate in `sign-in-methods` also checks the tenant's offered providers.
- Domain ownership: `addConnectionDomain` returns a TXT name `_clavix-sso.<domain>` and token;
  `verifyConnectionDomain` reads the TXT (60 s cooldown) and can be asked again. A domain is claimed
  by one enabled connection per tenant (`DOMAIN_TAKEN`).
- Quota `connections` (free 1, pro 5, enterprise unlimited; `tenants.plan.ts`, usage, console `Quotas`).
  A connection with linked users is not deleted (`CONNECTION_IN_USE`).
- **IdP mix-up (RFC 9207, nxgt-janus#979, G2-05)**: the record's `requireIssParameter` is stored as `requireIss`
  (`connections.service.ts`): pinned at create, and again when the issuer changes, from the issuer's metadata
  (`advertisesIss`, janus's `advertisesIssParameter`; unreadable means not pinned; connections created before are not backfilled, the library still requires `iss`
  whenever the metadata advertises it). Each connection has its own redirect URI
  (`ssoCallbackUrlOf(issuer, id)`: janus-social's function form, nxgt-janus#975), and `socialResolvers`'s
  `bindCallback` (janus-graphql 0.35, nxgt-janus#987; `sign-in-methods.resolver-support.ts`) binds the callback to the
  connection whose URL received it (`bindSsoCallback`), so an identity provider cannot pass a visitor's flow to another
  one even without `iss`. The id is the path of `callbackUrl` (`connectionIdOfCallbackUrl`) and must equal the
  `x-sso-connection` header the BFF sets from its own `:provider` route parameter (it forwards no browser header);
  a missing or disagreeing pair binds nothing, which a connection's flow refuses (fail closed). Register
  `<issuer>/sign-in/social/<id>/callback` with each identity provider.
- Admin events: `connection.create|update|setSecret|delete|addDomain|verifyDomain|removeDomain`.
- **Home-realm discovery and sign-in (F2)**: hosted `hostedHomeRealm(email)` (`modules/connections`) names the one
  enabled connection owning the address's verified domain (`ownerOf` in `connections.service.ts`: two claimants answer none), else null; it
  spends its own `homeRealmThrottle` (IP and tenant; `socialSignInStart` spends `ssoStartThrottle`: `sign-in-methods.sso-throttle.ts`,
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
  `recordingSignIn` so it is a failed sign-in (`connections.sso-gate.ts`). Limits: a static social app (Google, GitHub) and
  `acceptInvitation`'s sign-in are not gated. `login_hint` waits for J2; the callback route is F3.
- `domainOfEmail` is janus-social's (exported since 0.9); `federation.spec.ts` injects `resolveHost`. janus has no
  API to mark `mfa` amr from a federated step-up proof for tenant connections (`oidcConnections` takes no `federatedAmr`
  by design): D6 uses the acr check, and `trustingUpstreamMfa` (`users.social.ts`) wraps the resolved provider with
  `federatedAmr` for a connection whose `stepUp.acrValues` is set, so such a session is `["fed", "mfa"]` (acr `mfa`).

## OAuth clients

`src/modules/clients/` registers a client on a tenant (`registerClient` in `clients.register.ts`, split into steps under 80 lines; `clients.rules.ts` holds the offered grants, the size limits and `clientIdOf`, `clients.validate.ts` the input checks, `clients.types.ts` the types, `clients.utils.ts` the views, the agent reader and the optional-settings spread, `clients.search.ts` the listing and the count, `clients.cli.ts` the flags; `clients/index.ts` is the entry other modules import; the script `clients:create`
in `src/scripts/clients-create.ts`, README "OAuth clients"). It writes through the janus store of
the tenant's partition (`createMongoOAuth(oauthDb, { partition })`), with its own client id as
the idempotency key (janus has no lookup by name); a secret is minted with janus's
`mintOAuthSecret`, shown once and stored as `hashOAuthSecret`. Tenants are read through
`tenantBySlug` (`src/config/tenancy.ts`). `--grants` is stored on the client (`grantTypes`, shown by the console) and enforced by janus-oauth 0.13, which takes an explicit list as written: the script offers five grants (code, refresh, device, token exchange, client_credentials), and a list must name one of `authorization_code`, the device URN, the token-exchange URN or `client_credentials` (`refresh_token` alone is refused), plus `refresh_token` for a client that refreshes. The migration `2026-11-15-client-grants` (`db:migrate`) repairs stored lists written before 0.13. A client keeps its type: re-running a
public client with `--confidential`, a confidential one without it, or `--rotate-secret` on a public
one is refused (docs/troubleshooting.md).

## Green bar

`bun run verify` = `generate` (scalars and validation SDL, then both codegen configs), `schema:print --check`, `check:ci` (`biome ci`),
`typecheck` (`bun check`), `test` (`bun test --timeout=30000`); run `bun run build` too before a PR (CI does: `generate`, then the bundle).
CI (`.github/workflows/ci.yml`, on pull requests into `develop` only) runs `verify`, then `build`. `bunx biome ci .` on the head catches
what a lint-only run misses (import order, format). The `@softistx/*` packages come from npmjs (public): `bun install` needs no token.

## Tests and the machine

A spec connects to no service the CI runner lacks. The skeleton has no store; the slice
that adds MongoDB or Redis starts an in-memory one in `test/setup.ts` (as schoolz-api's
does) rather than reading `.env`. A slice runs the specs of the code it changed.

## Errors

Every refusal is `fail(code, message, { status, field, retryAfter, headers, extra })` (`src/shared/errors.ts`), never a
hand-built `GraphQLError` (graxia plugins such as `src/http/coercion.ts` aside). A 401, 403 or 404 is `fail` too, with its `status` (`fail("NOT_FOUND", "No such tenant", { status: 404 })`): janus-graphql's `denial()` is not used, `fail` gives the same code, status and text. The refusals janus-graphql builds itself (`janusGraphQLError`, the resolvers of `secondFactorResolvers`, `passkeyResolvers`, `socialResolvers`) keep its shape. `code` is an `ErrorCode`: each module
declares its codes in its `<name>.errors.ts` (`export const codes = defineCodes("<name>", [...])`), the answers all modules
share (`BAD_USER_INPUT`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`) are in `src/i18n/codes.ts`, which
unions every group, and `src/i18n/codes.spec.ts` lists each code once. A new code goes in its module's file; tsc refuses an
unknown one. Values stay UPPER_SNAKE (the contract with the UI and the SDK; renaming them is a later effort, D3).

## graxia plugins of this API

An error's `extensions.http.status` and `headers` (a throttle's `Retry-After`) answer the JSON result through graxia
itself (`errorHttp`, on by default since 0.10: highest status wins, `http` is stripped from the body, `spec: true` ignores
the status under `application/json`); no plugin of this API carries it. `useWithoutQuotedValues`
(`src/http/coercion.ts`) scrubs the coercion errors in `onResultChunk` (streams) and `onResponse` (plain JSON). The console is
`useConsole` (`onRequest` verifies the token, `onContext` adds the principal), with its own cost limit (`CONSOLE_MAX_COST`, 50 000 in `app.ts`: the UI's nested reads of stored lists cost more than graxia's default 5 000, and a refused document is a 200 with no `data`; `src/modules/resources/resources.cost.console.spec.ts`); `useInviteBudget` is
`fieldRateLimit`, whose 429 and `Retry-After` are graxia's. A client that sends a GET or a non-JSON POST sends
`x-graphql-csrf: 1`. The JSON plugins match `application/json` and `application/graphql-response+json` (parameters
ignored); a `text/event-stream` answer carries no status, as it is sent before any error is known. Unexpected resolver errors and janus 5xx errors go to the app's telemetry
logger (`src/http/unexpected.ts`, `report` of `janusGraxiaMaskError`).
