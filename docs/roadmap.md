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
- **Tenants** — a tenant model, the tenant a host belongs to, a repository that cannot
  read another tenant's data, and the `clavix` tenant seeded (1.1).
- **Signing keys per tenant** — keys kept encrypted by janus's Mongo key store, rotated on
  a schedule, published as a JWKS per issuer (1.2). Waits on janus: JWT access tokens and
  signing keys.
- **An authorization server per issuer** — authorization code with PKCE, refresh,
  revocation and discovery for each tenant (1.3). Waits on janus: several issuers in one
  process.
- **OpenID Connect** — id_token, userinfo, `openid-configuration`, JWT access tokens
  (RFC 9068) and introspection (1.4). Waits on `@softistx/janus-oidc`.
- **Users and sessions per tenant** — passkey and e-mail code sign-in (1.5).
- **Clients registered by script** — until the console exists (1.7, with the UI).

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
- Tenant: clients, resources, scopes, users and admin roles (2.3).
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

## Shipped

Nothing yet.
