# Migrating from embedded janus to Clavix

This guide is for an application that today owns its users and sessions with an embedded
`@softistx/janus` instance (sign-in, passwords, passkeys, sessions in its own database) and moves
to Clavix as its identity provider, becoming an OpenID Connect relying party (RP). Each application migrates in its own project.

Two status words are used below. **Built** means it works today, in clavix-api or in a
released package. **Not built** means it does not exist yet; every such item is listed in
[Gaps](#gaps). Nothing here is a promise of a date.

## What changes for the application

| Before                                                     | After                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The app's janus holds the users, credentials and sessions. | Clavix holds the users and the credentials (passkey, e-mail code) of the app's tenant.                                                       |
| The app shows its own sign-in page.                        | The app sends the visitor to its tenant's host (`https://<slug>.<CLAVIX_DOMAIN>`), which shows the hosted sign-in page, then redirects back. |
| The API trusts the app's own session or token.             | The API verifies the JWT access token (ES256 by default) Clavix signed, with the tenant's public keys.                                       |

Facts to hold on to (all Built, see the clavix-api README):
- **One tenant per application**. The tenant's issuer is
  `https://<slug>.<CLAVIX_DOMAIN>` (plus `:CLAVIX_PUBLIC_PORT` when set). It serves its own
  `/.well-known/openid-configuration`, `/jwks.json`, `/authorize`, `/token`, `/revoke`,
  `/userinfo` and `/introspect`.
- **One user pool per tenant**. The same e-mail in two tenants is two users.
- **Clavix sessions are Clavix's.** Its cookie `__Host-clavix-session` is host-only on the
  tenant's host, 14 days sliding and 30 days at most. The app never reads it.
- **The app may keep an embedded janus** for its own session after Clavix has authenticated the
  visitor. That is the path of the preset in [step 3](#3-sign-the-user-in).
- A sign-up on a tenant is a per-tenant flag, `signUp`; it is closed on the `clavix` tenant
  (invitation only). Sign-in methods today: passkey and e-mail one-time code. Password sign-in
  is not offered.

## 0. Prerequisites

- A tenant for the application. Create it with `bun run tenants:create --slug <slug> --name <name>` (see the README, "Tenants"); the console API's `createTenant` does the same, and the `clavix` tenant is seeded by a migration. See [Gaps](#gaps).
- The hosted pages (sign-in, consent) are a later clavix-ui release
  ([clavix-ui#1](https://github.com/softistx/clavix-ui/issues/1)); check that issue's state.
  The API behind them (e-mail code, passkeys, consent) is Built.
- A resource for the API's tokens (`bun run resources:create`), see [step 4](#4-verify-access-tokens-on-the-api).

## 1. Register the application as a client

A client is registered on a tenant in the console API (`createClient`, which shows the secret
once) or by script, from a clavix-api checkout with the deployment's environment:

```sh
# the application's web back end: a confidential client (client_secret_basic)
bun run clients:create --tenant acme --name "Acme app" \
  --redirect-uri https://app.example.com/auth/clavix/callback --confidential
```

The output is JSON (`created`, `clientId`, `issuer`, `redirectUris`, `type`, and `clientSecret`).
`clientSecret` is **printed once**: copy it into the application's secret store at once, because
janus keeps only its SHA-256. Re-running is idempotent on the client id and prints
`clientSecret: null`; `--rotate-secret` mints another.
- **Redirect URIs** are matched exactly (janus's rules: HTTPS, no fragment, loopback `http`
  allowed). List every environment's callback with a repeated `--redirect-uri`.
- A browser-only app registers a public client (omit `--confidential`): PKCE `S256` only, no
  secret.
- **Grants**: authorization code and refresh only. `--grants` refuses anything else; what it
  records is shown by the console and not enforced.
- A client belongs to its tenant: another tenant's `/authorize` answers `invalid_client`.

Full flag table: "OAuth clients" in the [README](../../README.md#oauth-clients).

## 2. The redirect flow

The flow is the authorization code grant with PKCE (`S256`), on the tenant's issuer:
1. The app redirects the browser to the tenant's `/authorize` with `response_type=code`,
   `client_id`, `redirect_uri`, `scope=openid email profile`, `state`, `nonce` and
   `code_challenge` (S256).
2. Clavix signs the user in on its hosted page (passkey or e-mail code), shows consent, then
   redirects to the `redirect_uri` with `code` and `state`.
3. The app checks `state`, then posts the code and the PKCE `code_verifier` to `/token`
   (a confidential client authenticates with `client_secret_basic`). It gets an `id_token`,
   an access token (JWT, RFC 9068) and a refresh token.
4. The app validates the `id_token` (`iss`, `aud`, `exp`, `nonce`; it carries `sub`, `auth_time`,
   `at_hash`) and uses `sub` as the user's identity.

Lifetimes (current defaults, `src/oauth/lifetimes.ts`; they may change): access token 15 min; refresh token 30 days
sliding, 90 days at most.

## 3. Sign the user in

Two ways. The first is the recommended one: the application keeps its embedded janus for its own session.

### 3a. With the Clavix preset of `@softistx/janus-social`

`@softistx/janus-social` 0.3.0 and later (on npmjs) has
`oidcStepUp()` (`clavix()` still works as a deprecated alias). It does the redirect, PKCE, the code exchange and the ID token checks of
[step 2](#2-the-redirect-flow), and plugs into the app's embedded janus as a social provider:

```ts
import { oidcStepUp } from "@softistx/janus-social";

export const provider = oidcStepUp({
  issuer: "https://acme.clavix.example.com", // the tenant's issuer
  clientId: process.env.CLAVIX_CLIENT_ID!,
  clientSecret: process.env.CLAVIX_CLIENT_SECRET!,
  redirectUri: "https://app.example.com/auth/clavix/callback", // registered byte for byte
});
// then: janus({ ..., social: { providers: { clavix: provider } } })
```

The app's callback route calls `auth.social.start` and `auth.social.complete` as in the janus
[social guide](https://github.com/softistx/nxgt-janus/blob/develop/packages/janus/docs/guide/social.md)
and the preset's own page,
[`docs/guide/oidc-step-up.md`](https://github.com/softistx/nxgt-janus/blob/develop/packages/janus-social/docs/guide/oidc-step-up.md).
The preset asks for `openid email profile`. The identity it hands janus is `accountId` = the
ID token's `sub`, `email`, `emailVerified`, `name`, `picture`. Its optional `acrValues` and
`maxAge` use the tenant's MFA and step-up, which are shipped (see the [roadmap](../roadmap.md)): a client asks
for `acr_values`, `max_age` or `prompt=login` and the ID token and JWT access token carry `acr`, `amr` and
`auth_time`; a passkey step-up needs no authenticator app.

The app keeps its own janus session cookie after `complete` answers `signedIn`.

### 3b. Plain OIDC

Any OIDC client library works against the discovery document. Point it at the tenant's issuer,
use code + PKCE, and verify the ID token against `/jwks.json`. Then the app creates its own
session from `sub`. No Clavix-specific library is required, but the app must write the
session, the logout and the user mapping itself.

## 4. Verify access tokens on the API

Use `@alxia/clavix` 0.1.0 (npm) on an alxia API. It verifies an RFC 9068 access token with the
keys of the token's own issuer, allowing only issuers you list or that match
`https://<one label>.<domain>`:

```ts
import { alxia, health } from "@alxia/core";
import { clavix, requireScope } from "@alxia/clavix";

const auth = clavix({
  domain: "clavix.example.com", // dedicated to Clavix tenants
  audience: "https://api.example.com",
  warm: ["https://acme.clavix.example.com"], // /ready waits for these keys
});

alxia()
  .plugin(health({ checks: { clavix: auth.ready } }))
  .use(auth.bearer())
  .get("/invoices", requireScope("invoices:read"), ({ user, reply }) =>
    reply(200, { tenant: user.tenant, subject: user.subject }),
  )
  .listen(3000);
```

`user` is a `ClavixPrincipal`: `subject` (`sub`), `tenant`, `issuer`, `clientId`, `scopes`,
`roles`, `claims`. A bad token is a 401 with a `reason`; a missing scope is a 403
`insufficient_scope`. A custom domain goes in `issuers` as `{ issuer: tenant }`. See the
package's guide ([`packages/clavix/docs`](https://github.com/softistx/alxia/tree/develop/packages/clavix/docs)).

Constraints to know before relying on it:
- **The token's `aud` must contain the API's identifier, and that identifier is a Clavix
  resource.** Register it with
  `bun run resources:create --tenant <slug> --uri <api audience> --scope <scope>` (or `createResource` in the console API). Sign-in itself works without one (a request with no `resource` is
  for the tenant's userinfo, so the token's `aud` is the userinfo URL); a client that asks
  `resource=<uri>` gets a token whose `aud` is that URI, and an unregistered URI is refused
  (`invalid_target`).
- **`roles`** is the sorted list of the role names the user holds in the tenant (tenant-wide roles, plus those scoped to the token's resource), managed in the console (README "Roles of a tenant's end users"). `permissions` come with access rules, later.
- **`scopes`** are the scopes granted on the resource, configured in the console API (README "Clients, resources and scopes").
- A non-alxia API can verify the token itself: the JWT is signed by the tenant's key
  (ES256 default), published at `/jwks.json`; or it calls `/introspect` as a confidential
  client of the same tenant.
- Keys rotate every 90 days, the next key published 48 h ahead, a retired key kept 24 h: an
  API must refetch the JWKS (the `@alxia/clavix` verifier does), never pin a key.

## 5. Map old janus user ids to Clavix subjects

Clavix users have their own ids and `sub`; **nothing maps an old janus id to a Clavix `sub` for
you.** What exists:
- **With the preset (3a)**, the app's janus links the account on its own: the first time a
  visitor signs in through Clavix, `social.complete` looks for a janus user of the app with the
  same e-mail. If the Clavix ID token says the e-mail is verified **and** the app's user had
  verified it, the account is linked (an event `user.socialLinked`) and the visitor signs in as
  the existing user, so the old user id, and every record keyed on it, stays. Later sign-ins use
  the stored link (`accountId` = `sub`). If either side does not vouch for the e-mail, janus
  refuses with `EMAIL_NOT_VERIFIED_FOR_LINK`. A visitor whose e-mail matches nobody is created
  only when `social.signUp` is set.
- **With plain OIDC (3b)**, the app adds a column or document holding the `sub` for each user,
  fills it on the first Clavix sign-in by matching a verified e-mail, and keys its sessions
  and records on its own id as before.
- Either way, the user must exist in the tenant first: see "User import" in [Gaps](#gaps).
  Without import, users are created in the tenant by sign-up (a tenant flag, closed on the
  `clavix` tenant) or invitation.

Do not use the e-mail alone as the identity once the link exists: key on `sub`.

**What a Clavix `sub` is.** The janus user id of the user in that tenant, passed through
unchanged (the id_token and `/userinfo` both carry it). Janus mints it when the user is created:
a lowercase, hyphenated UUIDv7 (36 characters), time-ordered. It is stable for the life of the
user and independent of the e-mail, so an e-mail change does not move it. It is unique per
tenant only: the same person in two tenants has two unrelated `sub`s. Store it as an opaque
string (currently 36 characters; do not rely on the shape), together with the issuer (`iss`) when the app can see several tenants.
Nothing maps an old janus id to the new `sub`, which is why a mapping column is needed.

## 6. Sessions and signing out of the old app

- **Sessions do not move.** A session of the old embedded janus is not a Clavix session, and a
  Clavix session is not the app's. After the cut-over each user signs in once through Clavix.
- Run the two sign-ins side by side only as long as needed: keep the old sign-in route
  closed to new sessions, and let the old sessions expire, or end them through the app's own
  janus (check its session revocation in the janus docs; nothing in Clavix does it).
- **Sign-out has two sides.** The app ends its own session (its janus sign-out). To end the
  Clavix session on the tenant host the user signs out there; the API for it is the hosted
  pages' `signOut` mutation on the tenant's `/graphql`, which a browser calls from the tenant's
  own origin (it refuses foreign origins).
- **There is no RP-initiated logout (`end_session_endpoint`) in Clavix**: the paths clavix-api
  mounts are `/authorize`, `/token`, `/revoke`, the discovery documents, `/jwks.json`,
  `/userinfo` and `/introspect`. An app that wants "sign out everywhere" has no single call
  for it today.
- To cut the app's API access on sign-out, revoke the refresh token at `/revoke`. An access
  token already issued stays valid until `exp` (15 min) unless the API introspects it.

## What is not covered yet

- **User import** (old users into a tenant, with their e-mail verified flag, passkeys and
  credentials): not built. Passkeys and password hashes cannot be carried over; the user
  registers a passkey, or signs in by e-mail code.
- **The console**: tenants, clients, resources, scopes and users are managed in the console
  API (or by script).
- Also later: permissions and access rules.

MFA, step-up and social federation (Google, GitHub, enterprise OIDC connections) are shipped: see the
[roadmap](../roadmap.md).

## Gaps

For the Clavix maintainers to decide or file an issue on clavix-api, nothing here is invented to cover it:
1. **No user import.** No script, GraphQL operation or file format loads existing users into a
   tenant. Needed: a bulk create that keeps the e-mail (verified) and returns old id to new
   `sub`, so an application can fill its mapping without waiting for each first sign-in.
2. **Tenants** are created in the console API (`createTenant`) or by `tenants:create`.
3. **Resources and scopes** are managed in the console API or by script (`resources:create`),
   which gives the token for an application's own API that
   [step 4](#4-verify-access-tokens-on-the-api) verifies.
4. **No end-session endpoint** and no "sign out everywhere".
5. **`client_credentials` is opt-in**: a back end calling the API as itself needs a confidential client
   with the grant and `allowedScopes`, and a resource that opted in (`allowClientCredentials`). See the
   [client credentials guide](client-credentials.md).
6. **`@softistx/janus-social` is on npmjs** (public): `bun install` needs no token.
