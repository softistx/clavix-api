# Troubleshooting

Find the message you see, then read when it appears, why, and the fix.
- [`temporarily_unavailable`: the issuer has no signing key yet](#temporarily_unavailable-the-issuer-has-no-signing-key-yet)
- [`CLAVIX_TRUSTED_PROXIES is required in production`](#clavix_trusted_proxies-is-required-in-production-set-the-number-of-reverse-proxies-in-front-of-the-app-0-if-none)
- [Client registration refusals (`clients:create`)](#client-registration-refusals-clientscreate)
- [`BRANDING_CONTRAST` on `updateBranding`](#branding_contrast-on-updatebranding)
- [`BAD_USER_INPUT` field `css`: "the theme's CSS is not safe"](#bad_user_input-field-css-the-themes-css-is-not-safe)
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

The request has no bearer token, or it is forged, expired, revoked or for another audience. Ask
the `clavix` tenant's issuer for a token with `resource=https://console.<CLAVIX_DOMAIN>/api`.

### `503 SERVICE_UNAVAILABLE: Try again later`

The token store or the `clavix` tenant could not be reached. Retry; check MongoDB and that the
`clavix` tenant is active.

### `FORBIDDEN: Not allowed`

The caller's role does not give the permission the field needs (a viewer cannot edit, a tenant's
admin cannot touch another tenant), or the field has no guard. Grant the role, for a platform
role `bun run operators:grant --email <address> --role <role>`.

### `NOT_FOUND: No such client`, `No such resource`, `No such scope`

The id is unknown in that tenant: it never existed, it belongs to another tenant, or the tenant
is suspended. A query answers `null` and a delete `false` instead of this error. Read the ids
again with `clients(tenantId)`, `resources(tenantId)` or `scopes(tenantId)`.

### `CONFLICT` on `createClient`, `createResource`, `createScope`

The client id, the resource URI or the scope name (in that resource) already exists in the
tenant. Pass another `clientId`, or update the one that exists.

### `BAD_USER_INPUT` on a client, resource or scope mutation

The message says which: a redirect URI or a resource URI janus refuses (HTTPS, no fragment), a
scope name with a space or a quote, a scope without `resourceId` that is not `openid`, `profile`
or `email`, an empty name, or `rotateClientSecret` on a public client (`A public client has no
secret to rotate`).

### `LAST_OWNER` (409) on `changeMembership` or `removeMembership`

The change would leave the tenant with no owner. Name or invite another owner first, then demote or
remove this one. Of two owners removed at the same moment, the second is refused.

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
holds the role. `NOT_FOUND`: the tenant does not exist (or is suspended), or the id is not one of
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
deleted, and on any host but the `clavix` tenant's. Have an owner of the tenant send a new invitation with `inviteAdmin`
(inviting again replaces the pending one).

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
runs the console itself.

**`QUOTA_EXCEEDED` (409)**: a creation (a client, a domain) would pass the plan's limit
(`extensions.field` names the quota: `clients` or `domains`). Change the plan or the override with `setTenantPlan`.
Monthly active users never block: `usage` only reports `exceeded`.

**`TENANT_SUSPENDED` (403)**: on the tenant's sign-in operations, on `updateTenant` by a tenant admin (platform operators can still edit), and as `access_denied` JSON on
`/authorize` and `/token`, while the tenant is suspended or in the trash. `resumeTenant` or
`restoreTenant` lifts it at once (the host cache is dropped). Tokens already issued still work until they expire.

## End-user roles refusals (`createRole`, `updateRole`, `assignRole`, `roleMembers`)

### `CONFLICT` (409) `A role named "<name>" already exists here`

On `createRole` or `updateRole`: a role of the same name already exists in the same scope. Names are
unique among the roles of the whole tenant, and among those of one resource, so `admin` may exist
once tenant-wide and once on each resource. Pick another name, or update the existing role.

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
  past `CLAVIX_TLS_ASK_LIMIT` asks per minute, **or Redis is down**: the limit fails closed
  (every ask is refused and `tls ask: rate limit unavailable, refusing` is logged). Restore Redis;
  Caddy retries and certificates already issued keep serving.
- Caddy: `on_demand_tls { ask http://api:3000/internal/tls/ask?token=<secret> }` (Caddy
  appends `&domain=<host>`). Never route `/internal/` from the public listener.
- **`NOT_FOUND` on a domain mutation**: the tenant is unknown or suspended, or the id belongs to
  another tenant. Pending claims count toward the `domains` quota: remove an abandoned one to free it.
- Caddy's access log must not record the ask URL: its `token` is the secret.
### `USER_EXISTS` (409) on `inviteUser`

The address already has an account in that tenant's pool. Find the user with `users(tenantId, email:)` and
manage them there; an invitation is only for an address with no account.

### `503 SERVICE_UNAVAILABLE: Try again later` on a membership write or on accepting an admin invitation

The tenant's membership lock is held by another API process past its wait, or Redis is down. Nothing
changed (an invitation being accepted is released): ask again, with the same link for an invitation.
The token-store 503 with the same message has another cause (see above).
