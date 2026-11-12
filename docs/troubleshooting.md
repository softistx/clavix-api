# Troubleshooting

Find the message you see, then read when it appears, why, and the fix.
- [`temporarily_unavailable`: the issuer has no signing key yet](#temporarily_unavailable-the-issuer-has-no-signing-key-yet-retry-shortly)
- [`CLAVIX_TRUSTED_PROXIES is required in production`](#clavix_trusted_proxies-is-required-in-production-set-the-number-of-reverse-proxies-in-front-of-the-app-0-if-none)
- [Client registration refusals (`clients:create`)](#client-registration-refusals-clientscreate)
- [`FORBIDDEN` and `NOT_FOUND` on `/graphql`](#forbidden-and-not_found-on-graphql)

## `temporarily_unavailable`: the issuer has no signing key yet, retry shortly

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
