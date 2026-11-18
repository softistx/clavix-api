# Roadmap

What clavix-api does and what comes next, from the point of view of the applications and
tenants that use it. The spec is in `../spec/`.
A "Next" entry says what the effort will cover, not how. An effort that waits on an
nxgt-janus release says which.

## Now

- **Rich authorization requests and MCP agents** ([#17](https://github.com/softistx/clavix-api/issues/17),
  [#18](https://github.com/softistx/clavix-api/issues/18)) — a tenant describes the authorization
  detail types of an API (a payment, a transfer) and lets a client ask for them with a pushed
  request, Clavix checks each request against the type and the user sees every detail in words
  before allowing it. In the same effort an AI agent (an MCP client) can register itself on a tenant
  that allows it, signs in with code and PKCE, and shows as an unreviewed agent on the consent page;
  admins list, delete and prune agents, read an API's RFC 9728 document, and let an MCP server
  exchange an agent's token. Done so far: the detail types of a resource are stored and served to the
  token server, and the console API creates, changes and deletes them. Next: clients opt in.

- **Self-service e-mail verification** (API shipped, UI in progress) — a signed-in user asks for
  a verification mail and confirms it with the link's token (stable codes for invalid, throttled
  and done); the OIDC `email_verified` claim follows the flag; the console is refused with
  `EMAIL_UNVERIFIED` until the address is proved (`me { user platformRole emailVerified }` stays open; the tenant lists under `me` need the proof), as passkey
  and second-factor setup already are; the future e-mail change will need it too
  ([#179](https://github.com/softistx/clavix-api/issues/179)).

- **MCP clients and agents** (in progress) — a tenant can opt in to dynamic registration (`/register`, RFC 7591) and
  Client ID Metadata Documents, with a throttle and an `agents` quota ([guide](guide/mcp.md)). Console exposure of the
  policy, RFC 9728 resources and consent per agent follow.

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

**Follow-ups**
- Follow-ups of custom domains ([#127](https://github.com/softistx/clavix-api/issues/127)) and
  going live ([#134](https://github.com/softistx/clavix-api/issues/134)).

**Federation, step-up and events**
- Enterprise OIDC connections and home-realm discovery.
- MFA policy and step-up (`acr_values`, `max_age`, `acr`/`amr`).
- Admin events and OAuth events: viewer, export and retention per plan ([#21](https://github.com/softistx/clavix-api/issues/21)); webhooks per tenant;
  telemetry.

**Before v1**
- A security review of the whole surface, a load test of the token and
  JWKS paths, and a restore drill.

**Authorization authoring**
- Roles, permissions and relations defined per tenant in the console, as the vocabulary
  the access rules refer to.

## Shipped

- **PAR and DPoP required on the platform tenant** ([#233](https://github.com/softistx/clavix-api/issues/233)) — the `clavix`
  tenant and its `console` client require PAR and DPoP (migration `2026-11-17-console-par-dpop`), the 409 guard on
  `updateOAuthPolicy` is lifted. The console (clavix-ui#228) signs in with PAR and DPoP ES256: deploy it first or together.

- **Pushed authorization requests** ([#13](https://github.com/softistx/clavix-api/issues/13)) — `/par` on every tenant host; a tenant
  can require it of every client (on for new tenants, off for existing ones) and a client can
  require it for itself, both from the console and the script; `/par` is routed and refused for a
  suspended tenant.

- **DPoP-bound tokens** ([#14](https://github.com/softistx/clavix-api/issues/14)) — every tenant host accepts DPoP proofs
  (single-use, with a server nonce): access tokens, and a public client's refresh tokens, are bound to
  the client's key; a tenant can require DPoP of every client (off by default) and a client can require
  it for itself, from the console and the script; userinfo, introspection and the console API take a
  `DPoP` token.

- **Device authorization grant** ([#15](https://github.com/softistx/clavix-api/issues/15)) — `/device_authorization` on every tenant
  host for a client that lists the device grant (no redirect URI needed); the hosted verification
  page shows the client, its host and the tenant's scope texts, and approving needs a fresh session;
  guessing user codes is throttled.

- **Token exchange** ([#16](https://github.com/softistx/clavix-api/issues/16)) — a confidential client that lists the
  exchange grant trades a user's token for one on another of the tenant's APIs (RFC 8693, delegation
  with `act`, scopes only narrow, no refresh token), under per-client rules set from the console.

- **Console hardening** — a suspended tenant refuses social sign-in and invitation acceptance
  ([#164](https://github.com/softistx/clavix-api/issues/164)); its console stays readable, while a
  tenant-admin write on it is refused with `TENANT_SUSPENDED`
  ([#167](https://github.com/softistx/clavix-api/issues/167)); client and domain writes are
  serialized ([#165](https://github.com/softistx/clavix-api/issues/165)); and console tokens are
  bound to their user, the last owner being kept
  ([#170](https://github.com/softistx/clavix-api/issues/170)).
- **M2 console** — the console API for operators and tenant admins is complete: tenants, admins,
  clients, resources and scopes, users, end-user roles, branding, domains, sign-in methods and
  admin events recording, each listed below.

- **Tenant admins** — an owner invites admins to a tenant, changes their role (owner, admin,
  viewer) and removes them; pending invitations can be resent or revoked
  ([#111](https://github.com/softistx/clavix-api/issues/111)).
- **Console API foundation** — the console's own GraphQL API at `/console/graphql`, behind a
  bearer token of the `clavix` tenant, with platform and tenant roles (owner, admin, viewer), a
  deny-by-default guard on every field, and `operators:grant` to name the first operators
  ([#99](https://github.com/softistx/clavix-api/issues/99)).
- **Tenants, plans, usage, suspension and trash** — operators manage tenants with plans, quotas and
  usage counters ([#8](https://github.com/softistx/clavix-api/issues/8)). A suspended tenant refuses
  sign-ins and new tokens (tokens already issued live to expiry, the console stays readable). A
  deleted tenant goes to a 30-day trash, can be restored, then is purged daily; its slug stays
  reserved ([#112](https://github.com/softistx/clavix-api/issues/112)).
- **Switchable tenants** — `me.switchableTenants` feeds the shell's tenant switcher: a member's
  tenants, or an operator's every live tenant, paged and searchable
  ([#120](https://github.com/softistx/clavix-api/issues/120)).
- **Clients, resources and scopes in the console** — a tenant manages its clients, resources and
  scopes with per-language consent texts.
- **Users in the console** — list, invite, disable and delete users, with their sessions (revoked
  one by one), grants and an e-mail verified flag, and an e-mail prefix search with a total
  ([#101](https://github.com/softistx/clavix-api/issues/101),
  [#132](https://github.com/softistx/clavix-api/issues/132)), and a `userLookup` for the role
  member picker, by e-mail or name prefix, for a role writer
  ([#208](https://github.com/softistx/clavix-api/issues/208)).
- **End-user roles** — roles per tenant, scoped to a resource or not, assigned to users and released
  in the `roles` claim ([#102](https://github.com/softistx/clavix-api/issues/102)); a `managed` marker
  on a role Clavix provides, refused for update and delete
  ([#207](https://github.com/softistx/clavix-api/issues/207)).
- **Branding** — a theme per tenant with an AA contrast check, a logo, and a public brand query by
  host; unsafe CSS is refused on save ([#10](https://github.com/softistx/clavix-api/issues/10)).
- **Custom domains** — add, verify by DNS TXT, remove and make primary; a 6-hourly recheck with a
  7-day grace, automatic TLS only for verified domains of active tenants, and the Related Origins
  document, also accepted by the passkey layer ([#11](https://github.com/softistx/clavix-api/issues/11)).
- **Going live** — a `Dockerfile`, a compose file with Caddy (on-demand TLS asking the API, a
  wildcard option), `/healthz` and `/readyz`, a MongoDB backup and restore script with a restore
  drill, and the runbook [operations.md](operations.md); no deploy pipeline, images are built by
  hand ([#108](https://github.com/softistx/clavix-api/issues/108)).
- **Admin events recording** — every change made from the console is recorded: who did it, what, on
  which tenant and target, and when, with no secret value ever stored
  ([#107](https://github.com/softistx/clavix-api/issues/107) for the viewer and export).

- **Key rotation without downtime** — the master key is a keyring (`CLAVIX_KEYS_MASTER_KEY`, first seals, any opens) re-sealed by `bun run keys:reseal`, and `bun run keys:rotate` rotates a tenant's signing keys now in an emergency
  ([#156](https://github.com/softistx/clavix-api/issues/156)); runbook in `docs/operations.md`.
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
  recorded, shown and enforced by janus-oauth 0.13 (an explicit list must name every grant the
  client uses); grants other than code and refresh are not offered yet.
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
