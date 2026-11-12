# Troubleshooting

Find the message you see, then read when it appears, why, and the fix.
- [`temporarily_unavailable`: the issuer has no signing key yet](#temporarily_unavailable-the-issuer-has-no-signing-key-yet)
- [`CLAVIX_TRUSTED_PROXIES is required in production`](#clavix_trusted_proxies-is-required-in-production-set-the-number-of-reverse-proxies-in-front-of-the-app-0-if-none)
- [Client registration refusals (`clients:create`)](#client-registration-refusals-clientscreate)
- [`FORBIDDEN` and `NOT_FOUND` on `/graphql`](#forbidden-and-not_found-on-graphql)

## `temporarily_unavailable`: the issuer has no signing key yet

**When:** an OAuth endpoint answers `503` with the body
`{"error":"temporarily_unavailable", ...}` (janus-oauth's `NoSigningKeyError`; the response carries no `Retry-After`).
It happens right after a tenant is created, or when a tenant has no current key.

**Why:** a tenant signs with its own keys. The first key is created when the tenant is created; if that
call failed it was only logged, and the hourly `key-rotation` job (and the pass at server start) creates
it. Until a key exists, the tenant's JWKS is empty and the endpoints treat that as transient.

**Fix:** wait and retry; nothing needs to change for a new tenant. If it lasts more than an hour, check
that the server started its `key-rotation` pass (without `REDIS_URL` only the pass at start runs, so
restart the server) and that `CLAVIX_KEYS_MASTER_KEY` is set. See "Signing keys" in the README.

```sh
openssl rand -base64 32   # a value for CLAVIX_KEYS_MASTER_KEY
```

## `CLAVIX_TRUSTED_PROXIES is required in production: set the number of reverse proxies in front of the app (0 if none)`

**When:** at startup, with `NODE_ENV=production` and `CLAVIX_TRUSTED_PROXIES` unset.

**Why:** the client IP (`ctx.ip`) drives the sign-in code limits. Behind a reverse proxy the connection's
address is the proxy, so every user would share one limit; trusting `X-Forwarded-For` without a proxy
lets a client spoof its address. The app refuses to guess.

**Fix:** set the exact number of proxies in front of the app (a whole number, at least 0).

```sh
CLAVIX_TRUSTED_PROXIES=1   # one load balancer in front
CLAVIX_TRUSTED_PROXIES=0   # none: ctx.ip is the connection's address
```

With `0`, `ctx.ip` is the connection address; with `n > 0` it is read from the forwarded chain. A number
too high lets a client choose its own IP; too low rate-limits the proxy itself. See "Sign-in code limits"
in the README.

## Client registration refusals (`clients:create`)

`bun run clients:create` registers or updates an OAuth client and exits with one of these messages.
A client keeps its type (public or confidential) for life.

### `"<client-id>" is a confidential client: re-run with --confidential, or use another client id (a client keeps its type)`

**When:** updating an existing confidential client without `--confidential`.
**Why:** the flag is the type; omitting it asks for a public client.
**Fix:**

```sh
bun run clients:create --tenant acme --name "Back office" \
  --redirect-uri https://office.example.com/callback --confidential
```

### `"<client-id>" is a public client: it cannot become confidential (a client keeps its type); register a confidential client under another client id`

**When:** `--confidential` on a client id that exists as public.
**Why:** a public client has no secret and the type is not converted.
**Fix:**

```sh
bun run clients:create --tenant acme --name "Back office" --client-id back-office-conf \
  --redirect-uri https://office.example.com/callback --confidential
```

### `--rotate-secret needs a confidential client: "<client-id>" is public and has no secret`

**When:** `--rotate-secret` without `--confidential`, or on a public client.
**Why:** only a confidential client has a secret to rotate.
**Fix:** add `--confidential` on a confidential client's id. The new secret is printed once; janus keeps
only its hash.

```sh
bun run clients:create --tenant acme --name "Back office" \
  --redirect-uri https://office.example.com/callback --confidential --rotate-secret
```

### `"<client-id>" is not a registered client`

**When:** the id belongs to a client that was not created by `clients:create`.
**Why:** the script only updates clients it registered; others are not its to change.
**Fix:** use another `--client-id`.

### `grant "<grant>" is not offered: ...`

**When:** a grant outside the ones janus-oauth offers (the message lists them).
**Why:** every client gets the same grants.
**Fix:** drop the grant; the default is the offered set.

### `redirect URI "<uri>": <problem>` and `a client needs at least one redirect URI`

**When:** a `--redirect-uri` breaks janus's rules, or none is given.
**Why:** redirect URIs are matched exactly: HTTPS, no fragment, `http` only on loopback.
**Fix:** pass each URI exactly as the client will send it; the flag repeats.

```sh
bun run clients:create --tenant acme --name "Web app" \
  --redirect-uri https://app.example.com/callback \
  --redirect-uri http://127.0.0.1:5173/callback
```

Also refused: an unknown tenant slug or a suspended tenant, a missing `--name`, and a client id that is not
1-64 characters of `a-z`, `0-9` and `-` (not starting or ending with `-`).

## Resource registration refusals (`resources:create`)

### `resource URI "<uri>" is not in canonical form: write it as <canonical>`

**When:** `--uri` is a valid URL but not spelled the way URLs normalise: upper-case scheme or host, a default
port (`:443`), dot segments, or a bare origin without its `/`.
**Why:** the URI is the `aud` of the access tokens and the key of idempotency. Two spellings of one URL would
create two audiences. It is refused rather than rewritten, because the rewrite can change the audience a
client already requests (`https://api.example.com` becomes `https://api.example.com/`).
**Fix:** pass the spelling the error prints, and have clients request that same value.

```sh
bun run resources:create --tenant acme --uri https://api.example.com/ --scope read
```

## `FORBIDDEN` and `NOT_FOUND` on `/graphql`

**When:** a `/graphql` request is answered before it runs, with
`{"errors":[{"message":"Cross-origin requests are not allowed","extensions":{"code":"FORBIDDEN"}}]}`
(HTTP 403), or, when it asks only for the consent operations (`oauthRequest`, `approveOAuthRequest`,
`denyOAuthRequest`, `connectedApps`, `revokeConnectedApp`), with `"message":"Not found"` and code
`NOT_FOUND` (HTTP 404).

**Why:** the session cookie is the credential and a sibling host is same-site, so every request must come
from the tenant's own origin. Refused: an `Origin` whose host differs from the request's, `Origin: null`
(a sandboxed frame), and a `POST` whose `Content-Type` is not `application/json` (a CORS-simple form
post). The refusal carries no CORS header, so a foreign page cannot read it. A request with no `Origin`
(a server or CLI client) passes the origin check.

**Fix:** call the API from the tenant's own host, with a JSON body.

```ts
await fetch("/graphql", {
  method: "POST",
  credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query }),
});
```

Behind a TLS-terminating proxy only hosts are compared, so `http` against `https` is not the cause; check
that the proxy keeps the original `Host`.

## `EMAIL_UNVERIFIED` (403) when registering a passkey

**When:** `passkeyRegistrationOptions` or `registerPasskey` is answered with HTTP 403 and
`"extensions":{"code":"EMAIL_UNVERIFIED"}`.

**Why:** since janus 0.57, enrolling a sign-in factor (a passkey, or any second factor) is refused
while the user's e-mail is unproved, so a factor cannot be bound to an address nobody confirmed. The
code is stable and passes through unchanged; the hosted UI shows it as "unverified". Sign-in with
`signInWithPasskey` still answers the single `PASSKEY_INVALID` (401).

**Fix:** prove the e-mail first. Signing in with an e-mailed code (`verifySignInCode`) proves it;
then register the passkey again.

```graphql
mutation {
  passkeyRegistrationOptions {
    challenge
    options
  }
}
# 403 EMAIL_UNVERIFIED -> sign in with the e-mailed code, then repeat
```

## `EMAIL_CHANGE_NEEDS_PROOF` (409) when changing a user's e-mail

**When:** server code calls janus `update` with a new `email` for a user who holds a passkey or a
second factor, and it throws `EMAIL_CHANGE_NEEDS_PROOF` (HTTP 409, nothing written).

**Why:** since janus 0.58, `update` no longer moves the e-mail of such a user, so a factor cannot
silently follow an address nobody proved. Clearing an optional e-mail is still allowed. clavix-api
itself never changes a user's e-mail through `update`; the code is stable and, as a janus error,
passes through unchanged (409).

**Fix:** use `changeEmail`, which proves the new address and keeps the factor.

```ts
const { token } = await auth.changeEmail.send(user, "new@example.test");
// the user follows the e-mailed link, then:
await auth.changeEmail.confirm(token);
```

## `MAGIC_LINK_DISABLED` (404) on `requestMagicLink` or `confirmMagicLink`

**When:** the operation is answered with HTTP 404 and `"extensions":{"code":"MAGIC_LINK_DISABLED"}`.

**Why:** magic-link sign-in is off, which is the default. Nothing was counted, written or mailed, and a
link mailed earlier is not spent.

**Fix:** set `CLAVIX_MAGIC_LINK=true` (or `1`) and restart; every tenant then has it. The hosted page
should hide its "e-mail me a link" button when the operation answers 404.

## `MAGIC_LINK_INVALID` (401) on `confirmMagicLink`

**When:** the hosted page POSTs the token and gets HTTP 401 `MAGIC_LINK_INVALID`.

**Why:** the link is unknown (also another tenant's), already used, expired (15 minutes), superseded
by a newer request (only the last link works), sent to an address the user has since changed, or
the user is deactivated. All look alike on purpose. A mail scanner that opened the link and signed in on
`GET` would also have spent it: the page must sign in only on a POST from a button.

**Fix:** offer a new link with `requestMagicLink`, and tell the user to open the latest e-mail.

## Console API refusals (`/console/graphql`, `operators:grant`)

### `401 UNAUTHENTICATED: A valid console token is required`

The request has no bearer token, or it is forged, expired, revoked or for another audience. Ask
the `clavix` tenant's issuer for a token with `resource=https://console.<CLAVIX_DOMAIN>/api`.

### `503 SERVICE_UNAVAILABLE: Try again later`

The token store or the `clavix` tenant could not be reached. Retry; check MongoDB and that the
`clavix` tenant is active.

### `FORBIDDEN: Not allowed`

The caller's role does not give the permission the field needs (a viewer cannot edit, a tenant's
admin cannot touch another tenant), or the field has no guard. Grant the role, for a platform
role `bun run operators:grant --email <address> --role <role>`.

### `operators:grant`: `no user with e-mail ... in the clavix tenant`, `--email is required`, `--role must be owner, admin or viewer`

The script never creates a user: the person signs in once to the `clavix` tenant (or is invited)
first. Pass `--email`, and a `--role` of owner, admin or viewer.
