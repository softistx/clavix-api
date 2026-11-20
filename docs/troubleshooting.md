# Troubleshooting

Find the message you see, then read when it appears, why, and the fix.
- [`temporarily_unavailable`: the issuer has no signing key yet](#temporarily_unavailable-the-issuer-has-no-signing-key-yet)
- [`CLAVIX_TRUSTED_PROXIES is required in production`](#clavix_trusted_proxies-is-required-in-production-set-the-number-of-reverse-proxies-in-front-of-the-app-0-if-none)
- [Client registration refusals (`clients:create`)](#client-registration-refusals-clientscreate)
- [`BRANDING_CONTRAST` on `updateBranding`](#branding_contrast-on-updatebranding)
- [`BAD_USER_INPUT` field `css`: "the theme's CSS is not safe"](#bad_user_input-field-css-the-themes-css-is-not-safe)
- [`FORBIDDEN` and `NOT_FOUND` on `/graphql`](#forbidden-and-not_found-on-graphql)
- [`BAD_USER_INPUT` "invalid_authorization_details" on `approveOAuthRequest` / `approveOAuthDeviceRequest`](#bad_user_input-invalid_authorization_details-on-approveoauthrequest--approveoauthdevicerequest)

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

## `CLAVIX_KEYS_MASTER_KEY: not 32 bytes in base64 ...` / `the same key appears twice in the keyring`

The variable is one key or a comma-separated keyring of 32-byte base64 keys, none repeated. Fix the list and
redeploy. If signing fails after a rotation, the old key was dropped before `bun run keys:reseal` answered
`resealed: 0, skipped: 0, failed: 0` (or it exits 1): put the old key back after the new one and run it again.
See `docs/operations.md`, "Signing keys".

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

## `invalid_authorization_details` (400) at `/par` or `/authorize`

**When:** a request carries `authorization_details` (RFC 9396) and an entry is refused. The error
description names the entry and the reason.
**Why:** one of these:
- the `type` is not one the tenant describes on that `resource`, or the client does not list it
  (`authorizationDetailsTypes`);
- a key the type does not define (a detail is a strict object: only `type`, `locations`, `identifier`,
  `datatypes`, `actions` when the type lists some, and its own fields);
- a value outside its field's bounds: a `string` longer than `maxLength`, a number outside `min`/`max`, a
  value not in an `enum`'s `values`, a `string[]` with too many items, a missing `required` field;
- an `actions` value the type does not list.

A tenant that describes **no** type refuses the parameter altogether with `invalid_request`, not this error.
**Fix:** read the type in the console (`Resource.detailTypes`) and send exactly its fields; or add the field
or value with `updateDetailType`; and list the type on the client (`authorizationDetailsTypes` in the console,
`clients:create --detail-types`). Details are best pushed to `/par`. A type that was deleted while a client still listed
it (a race with the delete) is not served either: remove it from the client's list.

```graphql
query {
  resource(tenantId: "6731…", id: "6732…") {
    detailTypes {
      type
      fields {
        key
        kind
        required
        min
        max
        maxLength
        values {
          value
        }
      }
      actions {
        value
      }
    }
  }
}
```

### `oauthRequest.details` shows the type's name, or fewer rows than the request holds

**When:** the consent API's `details` (and `oauthDeviceRequest.details`) block has the type name as its `title`, an empty
`description`, or no row for a field the client sent.

**Why:** the blocks are built from the tenant's detail type texts. A type deleted after the request (or never written in
the viewer's language) falls back to its name and the other language, and a field the type does not define is never shown, since
no raw JSON reaches the page. A viewer that sends no `Accept-Language` gets English.

**Fix:** write the type's `name`, `description` and field `label`s in French and English (`updateDetailType`), and keep a type that
a pending request uses. The page must render every block: approval allows all of them or none, and is refused while
`detailsComplete` is false (see below).

### `BAD_USER_INPUT` "invalid_authorization_details" on `approveOAuthRequest` / `approveOAuthDeviceRequest`

**When:** the user presses Allow on the consent or device page and the mutation answers `BAD_USER_INPUT` (400), message
`invalid_authorization_details`; the page's request or device request has `detailsComplete: false`.

**Why:** a detail of the request cannot be fully described any more: its type was deleted, or the type changed after the
request (a field removed or renamed, an action or enum value gone), so the page would show a partial summary. Approval allows
all the details or none, so Clavix refuses rather than let the grant carry a detail the user was not shown. The request stays
pending.

**Fix:** the user denies it (`denyOAuthRequest`, `denyOAuthDeviceRequest`) and the client asks again; the hosted page must show
only Deny while `detailsComplete` is false. To avoid it, do not remove or rename a detail type's fields while requests that use
it are pending (they last minutes).

### `DETAIL_TYPE_IN_USE` (409) on `deleteDetailType`

A client still lists the type in its `authorizationDetailsTypes`. Remove it from those clients first (the message
gives their number), then delete the type. Deleting the whole resource does not need this: it removes its types
from the clients' lists.

### `BAD_USER_INPUT` (400) on `createDetailType` / `updateDetailType`

The definition breaks a bound: a type name of 1 to 64 letters, digits, `_ . : -` starting with a letter; at most
16 fields; a field key of 64 characters, not `type`, `locations`, `actions`, `identifier`, `datatypes` or
`privileges`, and unique; an `enum` with 1 to 50 values; a label over 100 characters or a description over 300; no
name in either language.

### `BAD_USER_INPUT` (400) on `createClient` / `updateClient` with `authorizationDetailsTypes`

The message says which rule broke, and nothing was written:
- `unknown detail type "x"`: the name is not a type of this tenant (a type of another tenant is unknown too). List
  them with `Resource.detailTypes`, or create it first.
- `a client that lists detail types must require PAR`: set `requirePushedAuthorizationRequests: true` (CLI
  `--require-par`) in the same call; turning PAR off on a client that lists types is refused likewise.
- `cannot let a client that uses /authorize or the device grant list detail types yet`: the consent pages (`/authorize` and the
  device review) do not show details yet, so the tenant must be in `CLAVIX_RAR_CONSENT_READY` (an operator sets it). A
  token-exchange-only client is exempt.
- `a client lists at most 50 detail types`.

The CLI prints the same message as `clients:create: …`.

### `CONFLICT` (409) on `createDetailType`

The tenant already has a type of that name, on this resource or another (a name is unique in the tenant).
Choose another name, or update the existing type.

## `SSO_REQUIRED` (403) on a hosted sign-in

The address belongs to a verified domain of an enabled enterprise connection with `requireSso`. Why: the tenant's admin requires its users to sign in through the company's identity provider. Fix: call `hostedHomeRealm(email)` and start `socialSignInStart(provider: connectionId)`; or turn `requireSso` off on the connection. `socialSignInStart` answers `SIGN_IN_METHOD_DISABLED` for a connection id that is unknown, not the tenant's or turned off, and a connection with `jit` off refuses a first sign-in of an unknown user (`SIGN_UP_DISABLED`).

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

The console API refuses an unverified caller with the same code (see "Console API refusals").

**Fix:** prove the e-mail first. A signed-in user asks for a link with `requestEmailVerification` and
confirms it with `confirmEmailVerification(token)`; signing in with an e-mailed code
(`verifySignInCode`) proves it too. Then register the passkey again.

```graphql
mutation {
  passkeyRegistrationOptions {
    challenge
    options
  }
}
# 403 EMAIL_UNVERIFIED -> requestEmailVerification + confirmEmailVerification (or sign in with the e-mailed code), then repeat
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

**Why:** magic-link sign-in is off for this tenant, which is the default. Nothing was counted, written
or mailed, and a link mailed earlier is not spent.

**Fix:** a tenant admin turns it on in the tenant's sign-in policy (console API
`updateSignInMethods(tenantId, methods: [{ type: MAGIC_LINK, enabled: true }])`); it applies at once,
without a restart. The `CLAVIX_MAGIC_LINK` variable no longer exists and is ignored. The hosted page
reads `hostedSignInMethods` and hides its "e-mail me a link" button when `MAGIC_LINK` is not listed.

## `SIGN_IN_METHOD_DISABLED` (404) on a sign-in operation

**When:** `requestSignInCode`, `verifySignInCode`, `passkeySignInOptions`, `signInWithPasskey`,
`socialSignInStart` or `socialSignInComplete` answers HTTP 404 with
`"extensions":{"code":"SIGN_IN_METHOD_DISABLED"}`.

**Why:** the tenant of the host turned that method off, or does not offer that social provider (not
configured, disabled, or its stored secret can no longer be opened). Nothing was counted or mailed.

**Fix:** offer only what `hostedSignInMethods` lists. To turn a method on, a tenant admin calls
`updateSignInMethods` or `setSocialProvider` on the console API. If a configured, enabled provider is
missing, look for `social: <provider> of tenant <id> is off (...)` in the server log: the master key
changed, so enter the client secret again with `setSocialProvider`.

## Sign-in policy refusals (console API)

### `NO_SIGN_IN_METHOD` (409)

The change would leave the tenant with no enabled sign-in method and no enabled social provider, so
nobody could sign in. Enable another method or provider first, then repeat the change.

### `PLATFORM_FIRST_PARTY_METHOD` (409)

`updateSignInMethods` on the platform tenant would leave neither `PASSKEY` nor `EMAIL_CODE` enabled.
The platform tenant signs the console's operators in and always keeps one of these two, even when a
social provider is enabled, because a provider depends on an outside service. Keep one of the two
on. Other tenants are not bound by this rule.

### `SIGN_IN_METHOD_UNAVAILABLE` (409)

The method cannot be enabled yet: `PASSWORD` is listed with `available: false` until password
sign-in ships. Leave it off.

### `SOCIAL_SECRET_REQUIRED` (400)

`setSocialProvider` configures a provider for the first time without `clientSecret`. Send the client
id and the secret together; later calls may leave the secret out to keep the stored one.

### `BAD_USER_INPUT` (400)

A method type is given twice in `updateSignInMethods`, a new provider has no `clientId`, or a
`clientId` or `clientSecret` is empty or longer than allowed.

### `CONFLICT` (409)

Other changes to the same tenant were stored between the read and the write, three times in a row.
Nothing was stored. Read the policy and send the change again.

### `EMAIL_UNVERIFIED` (403) on `socialSignInComplete` with Microsoft

The ID token has no `xms_edov` claim, so the account's e-mail does not count as verified. Add
`xms_edov` as an optional claim of the app registration (Token configuration) in Microsoft Entra.

### `SIGN_UP_DISABLED` (403) on `socialSignInComplete`

The provider account's e-mail belongs to no user of the tenant, and the tenant's sign-up is closed.
Invite the user, or open the tenant's sign-up.

### `FORBIDDEN` (403) "Sign-in could not be completed" on `socialSignInComplete`

The provider answered, but the sign-in did not end in a session: the flow finished in a state that is
not a plain sign-in, or the user it named can no longer be read. Nothing was opened and no cookie
was set. Start again with `socialSignInStart`; if it keeps happening for one account, look for the
user in the tenant (it may have been deleted since the flow began).

### `BAD_USER_INPUT` `Variable "$x" got an invalid value` without the value (graphql-js words it `got invalid value`)

**When:** a variable of `/graphql` or `/console/graphql` has the wrong type (a code sent as an object,
say).

**Why:** graphql-js would quote the value back in the message, and a variable can carry an e-mail
code, a passkey answer or a client secret. Both endpoints scrub it (`src/http/coercion.ts`): the
error keeps the variable name and the path, never the value.

**Fix:** send the variable with the type the schema declares.

## `MAGIC_LINK_INVALID` (401) on `confirmMagicLink`

**When:** the hosted page POSTs the token and gets HTTP 401 `MAGIC_LINK_INVALID`.

**Why:** the link is unknown (also another tenant's), already used, expired (15 minutes), superseded
by a newer request (only the last link works), sent to an address the user has since changed, or
the user is deactivated. All look alike on purpose. A mail scanner that opened the link and signed in on
`GET` would also have spent it: the page must sign in only on a POST from a button.

**Fix:** offer a new link with `requestMagicLink`, and tell the user to open the latest e-mail.

## `EMAIL_VERIFICATION_INVALID` (400) on `confirmEmailVerification`

**When:** the hosted `/verify` page POSTs the token of a verification link and gets HTTP 400.

**Why:** the token is unknown (also another tenant's), already used, expired (24 hours), sent to an
address the user has since changed, or issued to another account than the signed-in one (that token
is left unspent for its owner). All look alike on purpose.

**Fix:** offer a new link with `requestEmailVerification` and tell the user to open the latest
e-mail while signed in to the account the link was sent for.

## `MAIL_THROTTLED` (429) on `hostedHomeRealm` or `socialSignInStart`

**When:** a sign-in page looks up the home realm of an address, or starts a social or enterprise
sign-in, and the answer is HTTP 429 with `extensions.code: "MAIL_THROTTLED"`.

**Why:** these two anonymous operations send no mail, and each has its own budget, apart from the
sign-in code one: 60 per 10 minutes per client address and tenant, 2000 per hour per tenant
(`CLAVIX_SSO_IP_LIMIT`, `CLAVIX_SSO_IP_WINDOW_SECONDS`, `CLAVIX_SSO_TENANT_LIMIT`, `CLAVIX_SSO_TENANT_WINDOW_SECONDS`; the same values, counted separately for the lookup and for the start). The code is
the one `requestSignInCode` answers, so a page handles one throttled error. Spending one of the three
budgets never closes the other two: a flood of lookups leaves sign-in codes and SSO starts open.

**Fix:** wait `Retry-After` seconds and try again. Many users behind one address (an office NAT)
hitting it: raise `CLAVIX_SSO_IP_LIMIT`. Behind a proxy, check `CLAVIX_TRUSTED_PROXIES` first: set
too low, every user counts as the proxy's address.

## `EMAIL_VERIFICATION_THROTTLED` (429) on `requestEmailVerification`

**When:** the account asked for too many verification e-mails.

**Why:** a limit was hit: per user (10 per hour), per client address and tenant, per tenant
(`CLAVIX_VERIFY_*`), or janus's 5 per address and 10 minutes.

**Fix:** wait `retryAfter` seconds (also the `Retry-After` header) and ask again; the page shows the
wait. Raise the `CLAVIX_VERIFY_*` values only if real users hit them.

## Console API refusals (`/console/graphql`, `operators:grant`)

### `no user with e-mail "<address>" in the clavix tenant: re-run with --create to invite them`

`operators:grant` only grants a role to an account that exists, and a fresh database has none: the
`clavix` tenant is invitation-only, so signing in or signing up with an unknown address sends no
mail ("sign-up is closed"). Invite the first operator instead:

```sh
bun run operators:grant --email you@example.com --create
```

The tenant mails an invitation link and the account is made, with the role, when it is opened. No
mail arrives: check the SMTP settings and that the address is right, then re-run the command, which
resends the invitation. Do not set `signUp` on the tenant by hand.

### `401 UNAUTHENTICATED: A valid console token is required`

The request has no bearer token (or, for a DPoP token, no valid proof: see "DPoP refusals"), or it is forged, expired, revoked, for another audience, or a delegated token (RFC 8693 exchange, one that carries an `act` claim): the console takes an operator's own token only. Ask
the `clavix` tenant's issuer for a token with `resource=https://console.<CLAVIX_DOMAIN>/api`.

### `503 SERVICE_UNAVAILABLE: Try again later`

The token store or the `clavix` tenant could not be reached. Retry; check MongoDB and that the
`clavix` tenant is active.

### `FORBIDDEN: Not allowed`

The caller's role does not give the permission the field needs (a viewer cannot edit, a tenant's
admin cannot touch another tenant), or the field has no guard. Grant the role, for a platform
role `bun run operators:grant --email <address> --role <role>`.

### `EMAIL_UNVERIFIED` (403) on any console operation

**When:** every console call but `me { user platformRole emailVerified }` is answered with HTTP 403 and
`"extensions":{"code":"EMAIL_UNVERIFIED"}`, whatever the caller's roles.

**Why:** the signed-in operator's e-mail is not proved (an admin cleared the flag, or the account
predates verification; accounts are not migrated). Operators are held to it too.

**Fix:** `me { emailVerified }` shows the state. Sign in to the `clavix` tenant's hosted account
page and ask for a link (`requestEmailVerification`, confirmed with `confirmEmailVerification`);
signing in with an e-mailed code proves it too. The same console token works at once. Another
operator whose e-mail is proved can also call `setUserEmailVerified`. `me { user platformRole
emailVerified }` stays readable; the tenants under `me` (`memberships`, `switchableTenants`) do not.

### `NOT_FOUND: No such client`, `No such resource`, `No such scope`

The id is unknown in that tenant: it never existed or it belongs to another tenant. A query answers `null` and a delete `false` instead of this error. Read the ids
again with `clients(tenantId)`, `resources(tenantId)` or `scopes(tenantId)`.

### `CONFLICT` on `createClient`, `createResource`, `createScope`

The client id, the resource URI or the scope name (in that resource) already exists in the
tenant. Pass another `clientId`, or update the one that exists.

A repeat of a call that already stored the same thing is not a conflict: the first run stored the
change but its audit record failed, so the call failed and was retried. When the stored client,
resource, scope or role has exactly the values of the call (for a client: name, type and redirect
URIs), the call returns it and records the missed event. `createClient` then answers
`clientSecret: null`: the secret was shown once by the first run and only its hash is kept, so
call `rotateClientSecret` if it was lost. `createRole` answers `CONFLICT` only when the
description differs, `createResource` when the name differs, `createScope` when the description or
the claims differ.

### `BAD_USER_INPUT` on a client, resource or scope mutation

The message says which: a redirect URI or a resource URI janus refuses (HTTPS, no fragment), a
scope name with a space or a quote, a scope without `resourceId` that is not `openid`, `profile`
or `email`, an empty name, or `rotateClientSecret` on a public client (`A public client has no
secret to rotate`).

### `LAST_OWNER` (409) on `changeMembership`, `removeMembership`, `disableUser` or `deleteUser`

The change would leave the tenant with no owner. For `disableUser` and `deleteUser` on a `clavix`
user, the user is the only owner who can sign in of a tenant they own, or the only live platform
owner. One rule everywhere: a disabled or deleted owner does not count, so with owners X (disabled)
and Y, Y cannot step down or be removed. Disabling a user who is already disabled is never refused.
Name, invite or enable another owner first, then demote or remove this one. Of two owners removed at the same moment, the second is refused. `CONFLICT` (409)
on the same two mutations means the user's roles kept changing during the call: retry.

### `RATE_LIMITED` (429) on `inviteUser` or `inviteAdmin`

**When:** an invitation is refused with HTTP 429, `extensions.code: "RATE_LIMITED"` and
`extensions.retryAfter` (seconds, also the `Retry-After` header).

**Why:** each invitation sends a mail from the platform's address, so two budgets bound them:

| Budget                                              | Default      | Variables                                                           |
| --------------------------------------------------- | ------------ | ------------------------------------------------------------------- |
| per caller, for each of the two mutations           | 60 per hour  | `CLAVIX_INVITE_CALLER_LIMIT`, `CLAVIX_INVITE_CALLER_WINDOW_SECONDS` |
| per tenant, `inviteUser` and `inviteAdmin` together | 200 per hour | `CLAVIX_INVITE_TENANT_LIMIT`, `CLAVIX_INVITE_TENANT_WINDOW_SECONDS` |

The caller's budget counts every selection of the mutation in the request, aliases included: one
POST with 80 aliased `inviteUser` costs 80, is refused whole with the message
`Too many attempts, try again later`, and no invitation of it is issued. What was counted stays
spent. The tenant's budget is counted invitation by invitation as each one runs (message
`Too many requests`): in one request of several aliases, the ones before the limit are issued and
the rest carry the error.

**Fix:** wait `retryAfter` seconds. To invite a long list, send it in batches under the caller's
budget, or raise the two limits for the import and put them back. Without `REDIS_URL` (development)
there is no budget; with Redis down the invitation goes through and
`redis unavailable: console budgets skipped` is logged.

### `ALREADY_MEMBER` (409) on `inviteAdmin`

The address already holds a role on the tenant. Change it with `changeMembership`.

### `RESEND_TOO_SOON` (429) on `resendAdminInvitation`

The invitation was sent, or sent again, less than 60 seconds ago. Nothing was renewed and no mail
went out. `extensions.retryAfter` (and the `Retry-After` header) is the seconds to wait. The delay
is per invitation: a second invitation of the tenant can be resent at once. The mail may be slow
rather than lost; check the spam folder before sending again. If the mail itself failed (a 5xx
after the renewal), the old code is already dead: wait the 60 s and resend.

### `INVITATION_NOT_PENDING` (409) or `NOT_FOUND` (404) on `resendAdminInvitation`

`INVITATION_NOT_PENDING`: the invitation was accepted or revoked, so there is nothing to renew. If
it was revoked, invite the address again with `inviteAdmin`; if it was accepted, the address already
holds the role. `NOT_FOUND`: the tenant does not exist (or is in the trash), or the id is not one of
this tenant's invitations (an id of another tenant is as unknown). A lapsed pending invitation is
not an error: resending it renews it.

### `BAD_USER_INPUT` (400) `userId is not an id` / `invitationId is not an id`, and `NOT_FOUND` `No such tenant`, on the membership mutations

The id is empty or longer than 200 characters, or `tenantId` is not 24 hexadecimal characters.
Nothing was written. Send the id the console returned.

A membership mutation that fails after its change because its admin event could not be stored is
safe to repeat: it changes nothing twice and records the event it missed.

### `INVITATION_INVALID` (400) on `invitationPreview` or `acceptInvitation`

The code is unknown, already used, revoked or expired; the hosted API gives one answer for all four,
so a code cannot be probed. An admin invitation is also invalid while its tenant is suspended or
deleted, on any host but the `clavix` tenant's, and for an `owner` invitation whose inviter was
deleted or disabled since. An account deleted (any role) or disabled (owner role) between creation and grant gets no role (the
invitation is released: send a new one). The grant runs under the same user lock as `deleteUser`, so an accept racing a delete either
is swept by it or finds the account gone. Have an owner of the tenant send a new invitation with `inviteAdmin`
(inviting again replaces the pending one).

### `operators:grant`: `the account "<address>" is disabled`

The platform role is never granted to a disabled account. Enable the user (`enableUser`) and run the command again.

### `operators:grant`: `the account "<address>" changed while granting: run the command again`

The account was deleted, or deleted and created again, between the lookup and the grant (the command re-reads it under the user's lock). Nothing was granted. Run the command again.

### `operators:grant`: `no user with e-mail ... in the clavix tenant`, `--email is required`, `--role must be owner, admin or viewer`

The script never creates a user: the person signs in once to the `clavix` tenant (or is invited)
first. Pass `--email`, and a `--role` of owner, admin or viewer.

### `tenants: purge failed for N tenant(s)` in the logs

**When:** the daily purge of the trash (`tenant-purge`, 03:17 UTC) or the pass at server start could not
finish N tenants.

**Why:** a step failed for those tenants (a database error, a timeout). Each one is already claimed: it
resolves nowhere and cannot be restored any more. The pass throws so the queue retries it (3 attempts,
5 minutes of backoff); a failure at server start is only logged.

**Fix:** nothing is lost and nothing needs doing first: the purge is resumable and the next daily tick
(or a restart; without Redis only the start pass runs) picks up the claimed tenants again. If the same error comes back every day, read the
`tenants: purge of <id> stopped, the next run resumes it: <reason>` line (logged at info level, not warn) before it,
which names the tenant and the cause.

## `SLUG_TAKEN`, `PLATFORM_TENANT_PROTECTED`, `QUOTA_EXCEEDED` and `TENANT_SUSPENDED`

**`SLUG_TAKEN` (409)** on `createTenant`: the slug belongs to a tenant, one in the trash, or a purged one
(a purge leaves a tombstone, so a slug is never reused). Pick another slug, or `restoreTenant` the
one in the trash.

**`PLATFORM_TENANT_PROTECTED` (409)**: `suspendTenant` or `deleteTenant` on the `clavix` tenant, which
runs the console itself. `updateOAuthPolicy` on that tenant is accepted: the console pushes (PAR) and proves (DPoP), and the
`clavix` tenant requires both since migration `2026-11-17-console-par-dpop`.

**Enterprise connections** (console): `DOMAIN_TAKEN` (409), another enabled connection of the tenant already holds the
domain; `DOMAIN_NOT_VERIFIED`, the domain's TXT record `_clavix-sso.<domain>` is missing or wrong, add the token
and verify again; `VERIFY_COOLDOWN` (429, `retryAfter` in seconds), wait before verifying again (60 s);
`CONNECTION_IN_USE`, users are linked to the connection, so it is disabled, not deleted; `ISSUER_REFUSED`
(the issuer's discovery is refused: https, public address, matching issuer) and `ISSUER_UNREACHABLE` (it did not answer).

**`QUOTA_EXCEEDED` (409)**: a creation (a client, a domain, a connection) would pass the plan's limit
(`extensions.field` names the quota: `clients`, `domains` or `connections`). Change the plan or the override with `setTenantPlan`.
Monthly active users never block: `usage` only reports `exceeded`.

**`TENANT_SUSPENDED` (403)**: on the tenant's sign-in operations, on every console write of a tenant's own admins (clients, resources, roles, users, admins, domains, branding, sign-in methods, `updateTenant`: the console stays readable on a suspended tenant, platform operators can still write), and as `access_denied` JSON on
`/authorize` and `/token`, while the tenant is suspended or in the trash. `resumeTenant` or
`restoreTenant` lifts it at once (the tenant's slug host, its verified custom hosts and a lapsed primary host are dropped from the cache). Tokens already issued still work until they expire.

It is also the answer of `acceptInvitation` on a suspended tenant's own host: an end-user invitation cannot be accepted, and so cannot sign the new user in, until `resumeTenant`; the invitation is not spent (`invitationPreview` is not refused). An admin invitation is accepted on the `clavix` tenant, which cannot be suspended: for it a suspended managed tenant gives `INVITATION_INVALID` instead. Every console write of a tenant admin (see above, `createClient`, `updateRole`, ...) gives `TENANT_SUSPENDED` too, replays included.

## `invalid_request: pushed authorization request required` on `/authorize`

A client redirected to its `redirect_uri` with `error=invalid_request` and
`error_description=pushed authorization request required: push the request to the
pushed authorization request endpoint first`.

**Why**: the tenant (`oauthPolicy.par.required`) or the client
(`requirePushedAuthorizationRequests`) requires pushed authorization requests,
and `/authorize` was called with the parameters in the query instead of a
`request_uri`. New tenants require it; tenants that existed before the policy
do not.

**Fix**: push first, then authorize with the returned `request_uri` (one use,
60 seconds; reusing it gives `invalid_request_uri`).

```sh
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d "response_type=code&redirect_uri=$URI&scope=openid&code_challenge=$C&code_challenge_method=S256" https://<tenant-host>/par
# then: /authorize?client_id=$CLIENT_ID&request_uri=<request_uri>
```

To turn it off: `updateOAuthPolicy` with `par: { required: false }` for the
tenant, `updateClient` with `requirePushedAuthorizationRequests: false`, or
`clients:create --no-require-par` for a script-made client. The `clavix`
platform tenant requires it since migration `2026-11-17-console-par-dpop`; turning it off is always safe, and a console
that pushes keeps working either way.
A suspended tenant's `/par` answers 403 `TENANT_SUSPENDED` like `/authorize`.

## `/par` refusals (pushed authorization requests)

**`invalid_request_uri` on `/authorize`**: the `request_uri` was already used or is older than 60
seconds. It is one-use. Push the request again (`POST /par`) and authorize with the new `request_uri`.

**`invalid_request`: `request_uri must not be sent to the pushed authorization request endpoint`**:
the body of `POST /par` carries a `request_uri`. Send the authorization parameters themselves
(`response_type`, `redirect_uri`, `scope`, PKCE), not a reference.

**`invalid_request`: `client_id is required with request_uri`**: `/authorize?request_uri=...` without
`client_id`. Add the `client_id` of the client that pushed.

**`CONFLICT` (409) on `updateOAuthPolicy`**: the policy changed at the same time as the write (three
attempts were made). Read `oauthPolicy` and send the change again.

**`TENANT_SUSPENDED` (403)** on `/par`: the tenant is suspended or in the trash, like `/authorize`
and `/token`. `resumeTenant` or `restoreTenant` lifts it.

## DPoP refusals (`/token`, `/par`, `/userinfo`, the console)

**`use_dpop_nonce` (400 at `/token`, 401 with `WWW-Authenticate: DPoP` at a resource)**: expected on a
client's first request. The `DPoP-Nonce` header carries the nonce: sign a new proof (new `jti`) with
`nonce` set and retry once. The code or the refresh token is not spent by the refused request. A client
that does not retry never gets a token.

**`invalid_dpop_proof`: `htu does not match`**: the proof names another URL than the public one. At the
token endpoint it is `https://<slug>.<CLAVIX_DOMAIN>/token` (the issuer's), never the address behind the
proxy; for the console it is `https://console.<CLAVIX_DOMAIN>/console/graphql`. `htm` must match the method too.

**`invalid_dpop_proof`: `the proof was already used`**: a proof is single-use. Sign a new one with a
fresh `jti` for each request, including the retry after `use_dpop_nonce`.

**`invalid_dpop_proof`: `this server requires DPoP-bound access tokens: send a DPoP proof` / `this client
requires ...`**: the tenant (`oauthPolicy.dpop.required`) or the client (`dpopBoundAccessTokens`)
requires proofs and the request had none. Send a `DPoP` header, or turn it off with `updateOAuthPolicy`
(`dpop: { required: false }`), `updateClient` (`dpopBoundAccessTokens: false`) or
`clients:create --no-dpop-bound`.

**`invalid_dpop_proof`: `the proof algorithm is not allowed`**: Clavix accepts `ES256` and `EdDSA` only.

**`invalid_grant` on a refresh with no proof, `invalid_dpop_proof` with another key**: a public client's
refresh token is bound to the key of its code exchange: refresh with a proof from that same key.

**`invalid_token` with `WWW-Authenticate: DPoP` at `/userinfo` or the console**: a bound token was sent
as `Bearer`, or an unbound one as `DPoP`, or the proof's key is not the token's. Send
`Authorization: DPoP <token>` with a proof whose `ath` is the token's SHA-256 (base64url).

**A 500 on a token request after the deploy, `Document failed validation` (code 121) in the logs**: `db:sync`
was not run: the tokens validators do not know `jkt` yet, or `oauthDpopReplay` does not exist
(operations, "Deploying").

**The console answers 401 `invalid_dpop_proof` or `use_dpop_nonce` after the update**: the `clavix` tenant
requires PAR and DPoP (migration `2026-11-17-console-par-dpop`), so a console older than clavix-ui#228 is
refused at sign-in. Deploy clavix-ui first or together.

## Token exchange refusals

**`unauthorized_client` on the exchange**: the client does not list the grant, or is public. It needs `--confidential
--grants urn:ietf:params:oauth:grant-type:token-exchange` (or `grantTypes: [TOKEN_EXCHANGE]`) and a secret.

**`access_denied`**: the client has no rules (`setClientTokenExchange`), the `resource` is not in `targetResources`,
or the subject token's client is not in `subjectClients` (and neither `anySubjectClient` nor, for an agent's token, `subjectAgents` is on). Read the rules with
`Client.tokenExchange`.

**`invalid_grant`**: the subject token is unknown, expired, revoked, or another tenant's. A token exchanged earlier
dies with the subject's grant.

**`BAD_USER_INPUT` on `setClientTokenExchange`**: `anySubjectClient` with `subjectClients`, or no client, no `subjectAgents` and no `anySubjectClient`, more
than 20 targets or 50 clients, a target that is not a resource of the tenant, or a public client.

## Device authorization refusals

**`unauthorized_client` on `/device_authorization` or on the device `/token`**: the client does not list the
device grant. It is never implied: `clients:create --grants urn:ietf:params:oauth:grant-type:device_code` (re-run, it keeps the name and URIs) or
`updateClient(input: { grantTypes: [DEVICE_CODE] })`.

**`slow_down`**: the device polled before its `interval` elapsed. Add 5 seconds to the interval and keep it.

**`expired_token`**: the code lived 10 minutes without a decision. Ask for new codes. **`access_denied`**: the
user refused; stop. **`invalid_grant`**: the `device_code` is unknown, already spent or another client's.

**`a client needs at least one redirect URI`** on `clients:create` or `createClient`: the client uses
`authorization_code` (the default). A device-only client lists `--grants urn:ietf:params:oauth:grant-type:device_code` and needs none. A re-run of an existing device-only client without `--grants` keeps its stored grants and needs none either.

**`NOT_FOUND` on `oauthDeviceRequest`, `approveOAuthDeviceRequest` or `denyOAuthDeviceRequest`**: the user code is
unknown, expired, already decided, or belongs to another tenant (open the page on the tenant host that gave the
code), or an approved scope was not asked by the device.

**`DEVICE_CODE_THROTTLED` (429)**: too many code lookups by this user, address or tenant. Wait the `Retry-After`
seconds; operators tune `CLAVIX_DEVICE_*`. Every lookup counts, hit or miss.

**`STEP_UP_REQUIRED`** on approve: the session is older than 5 minutes. Sign in again, or prove again with `requestPasskeyStepUp` / `requestStepUp` and their `confirm*`; the request is
still pending. Reading and denying a request do not ask for a fresh session.

**`UNMET_AUTHENTICATION_REQUIREMENTS`** (403, `extensions.missing`) on approve: the session does not meet the request's
`acr_values`, `max_age` or `prompt=login`, or the tenant's `required` mode. `missing` says what: `SECOND_FACTOR` (prove with a
step-up), `FRESH_PROOF` (prove again), `ENROLMENT` (the user holds no second factor; enrol one first). An empty `missing` means
the request names only an `acr` Clavix does not issue: nothing can meet it, so the request is denied and the client is
redirected with `error=unmet_authentication_requirements` (`approveOAuthRequest` answers that `redirectTo`). In the other
cases the request stays pending for the step-up.

**`CODE_INVALID`** on `confirmStepUp` (with `attemptsLeft`) is a wrong code; **`PASSKEY_INVALID`** on `confirmPasskeyStepUp` is a failed
assertion. `SECOND_FACTOR_NOT_ENROLLED` on `requestPasskeyStepUp`: the passkey step-up is not available to the user (no passkey, or `passkeys.firstFactor` off); it needs no authenticator app.

**`TENANT_SUSPENDED` (403)** on `/device_authorization`: the tenant is suspended or in the trash.

**`404` on `/device_authorization` from outside**: the reverse proxy does not route the path to the API; the
`@api` matcher of `deploy/Caddyfile` must list it.

## Agent registration (`/register`)

**400 `invalid_request`**: the tenant's `oauth.agents.dynamic` is `off` (the default). **400 `invalid_redirect_uri`**: in `restricted` mode the callback is neither an MCP client's, a loopback address nor in `redirectUris`. **400 `invalid_client_metadata`**: the body is not a JSON object, or asks for the device or token exchange grant, which dynamic clients never get.

**403 `access_denied`**: the tenant reached its `agents` quota (free 100, pro 1000); raise it with `setTenantPlan` overrides or remove agents. **403** with `TENANT_SUSPENDED`: the tenant is suspended.

**429 `temporarily_unavailable`**: past `CLAVIX_REGISTER_IP_LIMIT` or `CLAVIX_REGISTER_TENANT_LIMIT`; wait `Retry-After` seconds (see "Agent registration throttle" in operations.md).

**`/authorize` or `/par` with a metadata-document `client_id`**: 429 `temporarily_unavailable` past `CLAVIX_METADATA_IP_LIMIT` or `CLAVIX_METADATA_TENANT_LIMIT` (wait `Retry-After`); 403 `access_denied` when the tenant is at its `agents` quota and the client is not recorded yet.

**An agent disappeared from the console**: the daily clean-up deletes a `DYNAMIC` or `METADATA` agent recorded more than 7 days ago that holds no standing grant (admin event `agent.prune`, actor `system:agents:prune`). The client registers again if it needs to. A `METADATA` agent is recorded again at its next use. The job runs only with `REDIS_URL`.

**`updateClient`, `rotateClientSecret` or `setClientTokenExchange` answers `NOT_FOUND` on an agent**: an agent, `DYNAMIC` (it registered itself) or `METADATA` (described by its document), is read-only in the console, whatever its id looks like; only `client`, `clients` and `deleteClient` apply to it. To change one, register a console client instead.

**`updateOAuthPolicy` answers `BAD_USER_INPUT`** with `agents`: a redirect URI the OAuth rules refuse, a host that is not a DNS name (or `*.name`), or a list over 50 entries.

**`404` on `/register` from outside**: the reverse proxy does not route the path to the API; the `@api` matcher of `deploy/Caddyfile` must list it.

## End-user roles refusals (`createRole`, `updateRole`, `assignRole`, `roleMembers`)

### `CONFLICT` (409) `A role named "<name>" already exists here`

On `createRole` or `updateRole`: a role of the same name already exists in the same scope. Names are
unique among the roles of the whole tenant, and among those of one resource, so `admin` may exist
once tenant-wide and once on each resource. Pick another name, or update the existing role.

### `ROLE_MANAGED` (403) `The role "<name>" is managed by Clavix and cannot be changed or deleted`

On `updateRole` or `deleteRole` of a role whose `managed` field is `true`: Clavix created it for the
tenant and keeps it as it is. Nothing was written. Hide Edit and Delete on such a role; assigning
it with `assignRole` still works. A tenant's own roles (`managed: false`) are not affected.

### `NOT_FOUND` `No such role`, `No such resource`, `No such user`

`No such role`: the id names no role of this tenant (another tenant's id is not found either), or the
role was deleted while `assignRole` ran. `No such resource`: `createRole` was given a `resourceId`
that is not a resource of this tenant, or the resource was deleted at that moment. `No such user`:
`assignRole` names a user who is not in this tenant's pool (or was deleted at that moment). Nothing
was written. List the roles, resources or users again and send an id from there. `deleteRole` and
`unassignRole` never answer `NOT_FOUND`: they are repeatable and answer `false` when there is nothing
to remove.

### `BAD_USER_INPUT` (400) on a role

The message says which: a name that is not 1 to 64 characters of letters, digits, `.`, `_`, `:` and
`-`; a description over 300 characters; a `userId` that is empty or over 200 characters; an `id`,
`roleId` or `tenantId` that is not an id; or, on `roleMembers` or `me.switchableTenants`, `The cursor is not valid` (send
`nextCursor` back as it came, with the same `q`). Nothing was written.

## `BRANDING_CONTRAST` on `updateBranding`

**When:** `updateBranding` answers `422` with `extensions.code: "BRANDING_CONTRAST"`.

**Why:** the theme built from the brand has a text/background pair below WCAG AA (4.5, or 3 for large
text and indicators) in light or dark. `extensions.failures` lists each pair (`foreground`, `background`,
`mode`, `ratio`, `minimum`). Nothing was stored. The generator already moves a seed to reach AA, so this
means a pair that could not be solved.

**Fix:** pick a seed closer to mid lightness and less saturated, or drop the background preset, and
send the call again. A colour the library cannot read, an unsafe radius, an unknown preset or motif, unsafe generated CSS (see below), or
a logo that is not a PNG, JPEG or WebP of at most 256 KiB (checked by its bytes) is `BAD_USER_INPUT`
with `extensions.field` instead. `CONFLICT` (409) means other calls changed the brand at the same
time: read it and send the call again.

## `BAD_USER_INPUT` field `css`: "the theme's CSS is not safe"

**When:** `updateBranding` answers `400` with `extensions.field: "css"`.

**Why:** the stylesheet a tenant brand would store contains `<`, `@import`, `url(`, `image-set(`, `src(` or
a backslash (case-insensitive; `<` and the backslash even inside a comment, the other tokens once CSS
comments are stripped); `image(` and `cross-fade(` are refused too. The hosted pages put the CSS in a `<style>`,
so none of these may be stored; the UI refuses them at read too. The generator never writes them for a
valid brand, so this means a changed generator or an injected compiler. Every write path (the console
mutation and any script) goes through `buildTheme`, so nothing was stored. A brand stored earlier is
not migrated.

**Fix:** send a plain seed, radius, preset and motif; the message names the token found. If a
`@softistx/material-core` upgrade now emits one, file it upstream.

## `BAD_USER_INPUT: Unknown cursor` on `clients`

**When:** `clients(after: ...)` answers `400` with this message.

**Why:** `after` is not a `nextCursor` this API handed out (or it is too long or was edited).

**Fix:** start again without `after`, and pass back only the `nextCursor` of the previous page. A page
may hold fewer than `first` items, even none, with a `nextCursor`: follow it until it is `null`.

## A refusal on the console's own client or resource

**When:** `updateClient`, `rotateClientSecret`, `deleteClient` or a resource mutation names the
`console` client or the console resource.

**Why:** they belong to the console itself; changing them would lock operators out.

**Fix:** leave them alone. Manage them with the `2026-11-12-console` migration, not through the API.

## Custom domains: `BAD_USER_INPUT` on `host`, `DOMAIN_TAKEN`, `DOMAIN_PRIMARY`, `DOMAIN_NOT_VERIFIED`, `VERIFY_COOLDOWN`

- **`BAD_USER_INPUT` (field `host`)**: the host is not a public domain name. IPs, `localhost`,
  wildcards, a scheme, port or path, reserved suffixes (`.local`, `.internal`, `.test`, ...) and
  the platform domain with its subdomains are refused. Send `auth.acme.com`; case, a trailing dot
  and IDN names (converted to punycode) are fine.
- **`DOMAIN_TAKEN`**: another tenant already verified that host. Only a verified claim blocks,
  so a pending claim never does: whoever publishes the TXT record first wins.
- **`verifyDomain` returns `failure`**: `NO_RECORD` (no `_clavix.<host>` TXT yet; DNS may take
  minutes to propagate), `MISMATCH` (the record does not hold this domain's token; each tenant has
  its own), `LOOKUP_FAILED` (the resolver did not answer; retry).
- **`VERIFY_COOLDOWN` (429)**: a claim is checked at most once every 60 seconds. No DNS lookup was
  made; `extensions.retryAfter` is the seconds left. Wait, then call `verifyDomain` again.
- **`DOMAIN_PRIMARY`**: make another verified domain primary first, then remove this one.
- **`DOMAIN_NOT_VERIFIED`**: only a verified domain can be made primary.
- **A domain turned `UNVERIFIED`**: its TXT record was missing for 7 days. It stopped serving and
  no certificate is issued or renewed; the owners were e-mailed. Publish the record and verify
  again. A lapsed primary keeps its flag, so the issuer does not change by itself.
- **`/readyz` answers 503**: the body's `checks` names `mongo` or `redis` as `down`; see
  [operations.md](operations.md), "Troubleshooting". `/healthz` stays 200 meanwhile.
- **The TLS ask always answers 404**: `CLAVIX_TLS_ASK_SECRET` is unset or Caddy's `token` differs;
  the request went through a proxy (`X-Forwarded-*`, `X-Real-IP` and `Forwarded` are refused: Caddy must call the app directly);
  the domain is pending, unverified, unknown, or its tenant is suspended or in the trash. **429**:
  the host is one a certificate may be issued for, and more than `CLAVIX_TLS_ASK_LIMIT` such asks
  were answered this minute, **or Redis is down**: the limit fails closed
  (every ask for a known host is refused and `tls ask: rate limit unavailable, refusing` is logged). Restore Redis;
  Caddy retries and certificates already issued keep serving. An ask for an unknown host is a 404
  and spends nothing of the limit, so a flood of random names cannot make a real domain answer 429.
- Caddy: `on_demand_tls { ask http://api:3000/internal/tls/ask?token=<secret> }` (Caddy
  appends `&domain=<host>`). Never route `/internal/` from the public listener.
- **`NOT_FOUND` on a domain mutation**: the tenant is unknown or in the trash, or the id belongs to
  another tenant. Pending claims count toward the `domains` quota: remove an abandoned one to free it.
- Caddy's access log must not record the ask URL: its `token` is the secret.
### `USER_EXISTS` (409) on `inviteUser`

The address already has an account in that tenant's pool. Find the user with `users(tenantId, email:)` and
manage them there; an invitation is only for an address with no account.

### `RATE_LIMITED` (429) on `sendTestWebhook`

**When:** a test event is refused with HTTP 429, `extensions.code: "RATE_LIMITED"` and
`extensions.retryAfter` (seconds, also the `Retry-After` header).

**Why:** a test event takes a place in the delivery queue every tenant shares, so it is budgeted:
5 per minute per endpoint and 20 per minute per tenant, all its endpoints together
(`CLAVIX_WEBHOOK_TEST_ENDPOINT_LIMIT`, `CLAVIX_WEBHOOK_TEST_TENANT_LIMIT`,
`CLAVIX_WEBHOOK_TEST_WINDOW_SECONDS`). Nothing was queued and no admin event was recorded. A call
refused for another reason (unknown or switched-off endpoint) spends nothing.

**Fix:** wait `retryAfter` seconds; the budget refills evenly (one test per 12 s per endpoint at
the defaults). To see why an endpoint fails, read its `deliveries` rather than sending more tests.
Without `REDIS_URL` (development) there is no budget; with Redis down the test goes through and
`redis unavailable: console budgets skipped` is logged.

### `503 SERVICE_UNAVAILABLE: Try again later` on a membership write or on accepting an admin invitation

The tenant's membership lock is held by another API process past its wait, or Redis is down. Nothing
changed (an invitation being accepted is released): ask again, with the same link for an invitation.
The token-store 503 with the same message has another cause (see above).
