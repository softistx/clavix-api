# Roadmap

What clavix-api does and what comes next, from the point of view of the applications and
tenants that use it. The spec is in `../spec/`; the slices are `../spec/milestones.md`'s.
A "Next" entry says what the effort will cover, not how. An effort that waits on an
nxgt-janus release says which.

## Now

- **M0, skeleton** — the repository builds, lints, type checks and tests in CI: a `health`
  query and `GET /healthz`.

## Next

**M1, dogfooding: our applications sign in through Clavix**
- **Signing keys per tenant** — keys kept encrypted by janus's Mongo key store, rotated on
  a schedule (90 days, published 48 h ahead, retired 24 h), published as a JWKS per issuer
  (1.2, [#2](https://github.com/softistx/clavix-api/issues/2)); adopted from janus-oauth 0.8.
- **An authorization server per issuer** — authorization code with PKCE, refresh with
  rotation, revocation and discovery for each tenant (1.3, `src/oauth`, janus-oauth 0.8
  `createOAuthIssuers`). Built and mounted by `server.ts` with the real `authFor`/`claimsFor`;
  a request with no `resource` is for the userinfo resource, always the tenant's `defaultResource`; an API audience needs a registered resource (M2). Sign-in surface (E1) and consent (E2a) are built.
- **OpenID Connect** — id_token, userinfo, `openid-configuration`, JWT access tokens
  (RFC 9068) and introspection (1.4, [#4](https://github.com/softistx/clavix-api/issues/4),
  `src/oauth`, janus-oidc 0.3). Built: each tenant host serves its own discovery, JWKS,
  userinfo and introspection; the user claims come from the tenant's own user pool. The `roles` claim moved to M2.
- **Users and sessions per tenant** — passkey and e-mail code sign-in (1.5,
  [#5](https://github.com/softistx/clavix-api/issues/5)). Slice B built: one janus instance and
  one partitioned user pool per tenant, host-only `__Host-` session cookie (14 days sliding),
  the passkey rpId (`rpIdOf`) and the real `authFor`/`claimsFor`, served by `server.ts`. Slice E1
  built: e-mail code sign-in with the GraphQL surface for the hosted pages (`requestSignInCode`,
  `verifySignInCode`, `signOut`, `currentUser`), a platform sender over SMTP, per-tenant `signUp`
  (closed on `clavix`, invitation only, no account enumeration). Slice E2a built: the consent API
  on `/graphql` (`src/modules/consent`). Slice E3 built: passwordless passkey sign-in and
  registration (`passkeySignInOptions`, `signInWithPasskey`, `passkeyRegistrationOptions`,
  `registerPasskey`, `myPasskeys`, `removePasskey`; janus 0.53 first-factor passkeys, rpId = the
  tenant's host, `PASSKEY_INVALID` 401). The 30-day absolute session cap is built (janus 0.53).
- **Clients registered by script** — `bun run clients:create` registers or updates a public
  (PKCE) or confidential client on a tenant, idempotently, the secret shown once (1.7,
  [#6](https://github.com/softistx/clavix-api/issues/6)). Built; grants other than code and
  refresh wait on a per-client grant list in janus-oauth.
- **Migration guide** — how an application moves from embedded janus to Clavix as an OIDC
  relying party: client registration, the code + PKCE flow, token verification with
  `@alxia/clavix`, user mapping, sessions and sign-out, and the gaps (1.8,
  [#7](https://github.com/softistx/clavix-api/issues/7)).
  [Written](guide/migrating-from-embedded-janus.md).

**M5, access rules (ADR-0031)**
- **Access rules (M5, ADR-0031)** — an application publishes its OpenAPI and SDL from CI
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

**M2, console**
- Platform: tenants, plans and quotas, usage counters (2.2).
- Tenant: clients, resources, scopes, end-user roles and memberships (2.3).
- Branding: a theme per tenant, with a live preview and an AA contrast check (2.4).
- Custom domains: DNS TXT verification and automatic TLS (2.5).
- Sign-in methods and social providers per tenant (2.6).

**M3, advanced protocols**
- PAR mandatory by default (3.1); DPoP-bound tokens (3.2).
- Device authorization and its verification page (3.3); token exchange (3.4).
- Rich authorization requests and their consent (3.5).
- MCP and agents: dynamic registration policy, RFC 9728, consent per agent (3.6).

**M4, federation, step-up and events**
- Enterprise OIDC connections and home-realm discovery (4.1).
- MFA policy and step-up (`acr_values`, `max_age`, `acr`/`amr`) (4.2).
- Audit log, viewer and export (4.3); webhooks per tenant (4.4); telemetry (4.5).

**M5, authorization (after v1)**
- Roles, permissions and relations authored per tenant in Clavix, published as signed
  rules that each API pulls and evaluates locally, with no remote decision point
  (5.1–5.10).

## Shipped

- **Tenants** — a tenant model, the tenant a host belongs to (resolved from the `Host` and
  cached in Redis, a suspension applying within 60 s at worst), a repository that cannot
  read another tenant's data, slugs reserved for good, and the `clavix` tenant seeded (1.1).
