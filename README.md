# clavix-api

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider: one issuer per
tenant at `https://<slug>.<CLAVIX_DOMAIN>`, with its own users, clients, resources and signing keys.
The product spec lives with the project's planning folder, outside this repository.

Today it serves:
- the OAuth 2.1 / OpenID Connect endpoints of each tenant (authorization code with PKCE, refresh,
  JWT access tokens, discovery, userinfo, introspection, JWKS);
- on `POST /graphql`, `GET /healthz`, `GET /readyz` and `health { status version }`, the e-mail code sign-in, the
  passkey sign-in and registration, and the consent API of the hosted pages;
- on `POST /console/graphql`, the console API (`me`, tenants with plans, quotas, usage, suspension and
  trash, the admins of a tenant, a tenant's clients, resources, scopes and branding), behind a bearer or DPoP token;
- scripts that create tenants, OAuth clients and API resources. The trash is emptied after 30 days by a
  daily scheduled purge (see "Tenants, plans and usage"); the console's refusals are in `docs/troubleshooting.md`.

## Documentation

| Page                                                                                       | What is in it                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| This README                                                                                | run, environment, and each feature below            |
| [docs/guide/migrating-from-embedded-janus.md](docs/guide/migrating-from-embedded-janus.md) | moving an application from embedded janus to Clavix |
| [docs/guide/magic-link.md](docs/guide/magic-link.md)                                       | the operations the hosted sign-in link page calls   |
| [docs/guide/sign-in-methods.md](docs/guide/sign-in-methods.md)                             | a tenant's sign-in methods and social providers     |
| [docs/operations.md](docs/operations.md)                                                   | deploy, upgrade, backup, restore, TLS, health       |
| [docs/troubleshooting.md](docs/troubleshooting.md)                                         | the errors you can meet, with causes and fixes      |
| [docs/roadmap.md](docs/roadmap.md)                                                         | what is shipped and what comes next                 |
| [AGENTS.md](AGENTS.md)                                                                     | rules for contributors and agents                   |

## Run

```sh
export NPM_REGISTRY_TOKEN   # read token for npm.softistx.com (the @softistx packages)
bun install
cp .env.example .env
bun run generate   # GraphQL types, gitignored; also run by build and verify
bun dev            # http://localhost:3000/graphql and /healthz
```

## Scripts

| Script                    | Does                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `generate`                | scalar/validation SDL, then GraphQL codegen                                                       |
| `dev`, `build`, `start`   | watch server; bundle into `dist/`; run the bundle                                                 |
| `test`                    | `bun test`                                                                                        |
| `typecheck`               | `bun check`                                                                                       |
| `lint`, `fix`, `check:ci` | Biome                                                                                             |
| `db:sync`, `db:migrate`   | collections, indexes and relations; pending migrations (deployment steps)                         |
| `tenants:create`          | create a tenant (see "Tenants")                                                                   |
| `clients:create`          | register or update an OAuth client on a tenant (see "OAuth clients")                              |
| `resources:create`        | register or update a tenant's API resource and scopes (see "Resources")                           |
| `operators:grant`         | give a clavix-tenant user a platform role for the console (`--email`; refuses a disabled account) |
| `verify`                  | `generate`, `check:ci`, `typecheck`, `test` (what CI runs, plus `build`)                          |

Every script reads `MONGO_URI` and validates the rest of the environment below at start, so with `NODE_ENV=production` a script also needs the production-required variables. What each
one needs on top:

| Script                       | Environment it needs                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db:sync`, `db:migrate`      | `MONGO_URI` with a role that may create indexes and validators (`dbAdmin`)                                                                                                                                   |
| `tenants:create`             | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_SCHEME` (and `CLAVIX_PUBLIC_PORT`) for the issuer it prints, `CLAVIX_KEYS_MASTER_KEY` for the first signing key; `REDIS_URL` when set, to drop the tenant cache |
| `clients:create`             | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_SCHEME` (and port) for the issuer it prints                                                                                                                     |
| `resources:create`           | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_SCHEME` (and port), to refuse a tenant's own userinfo URL                                                                                                       |
| `keys:reseal`, `keys:rotate` | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_KEYS_MASTER_KEY` (the keyring, for `keys:reseal`)                                                                                                                      |
| `operators:grant`            | `MONGO_URI`, `CLAVIX_DOMAIN`, `CLAVIX_KEYS_MASTER_KEY` (reads the clavix tenant's users; `--create` also needs `CLAVIX_SMTP_URL`)                                                                            |
| `start`                      | all of the environment; in production `REDIS_URL`, `CLAVIX_DOMAIN`, `CLAVIX_KEYS_MASTER_KEY`, `CLAVIX_SMTP_URL` and `CLAVIX_TRUSTED_PROXIES` are required                                                    |

## Environment

`.env.example` lists the variables; a malformed one stops the app at start, naming it.

| Variable                                                               | Default / rule                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                 | 3000                                                                                                                                                                                                                                           |
| `MONGO_URI`                                                            | required; a replica set (transactions)                                                                                                                                                                                                         |
| `REDIS_URL`                                                            | required in production; unset elsewhere, the tenant cache is off, monthly active users are not counted and the console's membership lock is per process (with it, shared by every API process; a lock that cannot be taken is a retryable 503) |
| `CLAVIX_DOMAIN`                                                        | required in production; `clavix.localhost` elsewhere                                                                                                                                                                                           |
| `CLAVIX_PUBLIC_SCHEME`                                                 | `https`; `http` is refused in production                                                                                                                                                                                                       |
| `CLAVIX_PUBLIC_PORT`                                                   | optional; set when issuers are not on the scheme's own port                                                                                                                                                                                    |
| `CLAVIX_SMTP_URL`                                                      | `smtp://` or `smtps://` URL of the mail relay; required in production; unset elsewhere, mails stay in memory                                                                                                                                   |
| `CLAVIX_KEYS_MASTER_KEY`                                               | required in production (32 bytes, base64, or a comma-separated keyring while rotating: the first seals, any opens); a public development default elsewhere                                                                                     |
| `CLAVIX_CODE_IP_LIMIT` / `CLAVIX_CODE_IP_WINDOW_SECONDS`               | sign-in code requests per client address and tenant: 20 per 600 s                                                                                                                                                                              |
| `CLAVIX_CODE_TENANT_LIMIT` / `CLAVIX_CODE_TENANT_WINDOW_SECONDS`       | sign-in code requests per tenant: 200 per 3600 s                                                                                                                                                                                               |
| `CLAVIX_PASSKEY_IP_LIMIT` / `CLAVIX_PASSKEY_IP_WINDOW_SECONDS`         | `passkeySignInOptions` requests per client address and tenant: 60 per 600 s                                                                                                                                                                    |
| `CLAVIX_PASSKEY_TENANT_LIMIT` / `CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS` | `passkeySignInOptions` requests per tenant: 600 per 3600 s                                                                                                                                                                                     |
| `CLAVIX_VERIFY_USER_LIMIT` / `CLAVIX_VERIFY_USER_WINDOW_SECONDS`       | `requestEmailVerification` per signed-in user: 10 per 3600 s                                                                                                                                                                                   |
| `CLAVIX_VERIFY_IP_LIMIT` / `CLAVIX_VERIFY_IP_WINDOW_SECONDS`           | `requestEmailVerification` per client address and tenant: 20 per 600 s                                                                                                                                                                         |
| `CLAVIX_VERIFY_TENANT_LIMIT` / `CLAVIX_VERIFY_TENANT_WINDOW_SECONDS`   | `requestEmailVerification` per tenant: 200 per 3600 s                                                                                                                                                                                          |
| `CLAVIX_DEVICE_USER_LIMIT` / `CLAVIX_DEVICE_USER_WINDOW_SECONDS`       | device user-code lookups per signed-in user: 20 per 600 s (see "Device authorization grant")                                                                                                                                                   |
| `CLAVIX_DEVICE_IP_LIMIT` / `CLAVIX_DEVICE_IP_WINDOW_SECONDS`           | device user-code lookups per client address and tenant: 30 per 600 s                                                                                                                                                                           |
| `CLAVIX_DEVICE_TENANT_LIMIT` / `CLAVIX_DEVICE_TENANT_WINDOW_SECONDS`   | device user-code lookups per tenant: 300 per 3600 s                                                                                                                                                                                            |
| `CLAVIX_TLS_ASK_SECRET`                                                | optional, at least 32 characters: the token of Caddy's `ask` URL; unset, `/internal/tls/ask` answers 404 to everyone (see "Custom domains")                                                                                                    |
| `CLAVIX_TLS_ASK_LIMIT`                                                 | asks per minute, all callers together, default 120; past it 429                                                                                                                                                                                |
| `CLAVIX_TRUSTED_PROXIES`                                               | reverse proxies in front of the app; required in production (0 if none), default 0 elsewhere (see "Sign-in code limits")                                                                                                                       |

## Sign-in code limits

`requestSignInCode` is limited three ways; going over any of them is `MAIL_THROTTLED` (HTTP 429,
`Retry-After` in seconds), the same answer in all three cases:

| Limit                             | Default       | Variables                                                       |
| --------------------------------- | ------------- | --------------------------------------------------------------- |
| per address (the e-mail), janus's | 5 per 10 min  | not configurable                                                |
| per client IP, per tenant         | 20 per 10 min | `CLAVIX_CODE_IP_LIMIT`, `CLAVIX_CODE_IP_WINDOW_SECONDS`         |
| per tenant, all clients           | 200 per hour  | `CLAVIX_CODE_TENANT_LIMIT`, `CLAVIX_CODE_TENANT_WINDOW_SECONDS` |

They stop anyone sending codes to many addresses through the shared no-reply sender (#59). The `CLAVIX_CODE_*` values are whole numbers of at least 1;
`CLAVIX_TRUSTED_PROXIES` a whole number of at least 0.
- They use `@softistx/redis` rate limits (GCRA: the bucket starts full and refills evenly over the
  window), under the `clavix` prefix: `clavix:signin-ip:<tenantId>/<ip>`, `clavix:signin-tenant:<tenantId>`.
  Keys carry the tenant id, so a tenant's traffic never spends another's budget, and one address has
  one bucket per tenant. The IP is counted first: a refused address does not spend the tenant's budget.
- **The anonymous `passkeySignInOptions` follows the same rules** with its own buckets and variables (see "Passkey sign-in and registration").
- **They need `REDIS_URL`** (required in production). Without it (development) only janus's per-address
  limit applies. If Redis is down or slow (250 ms), the request is let through and a warning is logged;
  janus's per-address limit still holds.
- **Client IP and the trusted-proxy assumption.** The IP is `ctx.ip`. By default it is the connection's
  address, which behind a reverse proxy is the proxy: set `CLAVIX_TRUSTED_PROXIES` to the number of
  proxies in front of the app (`1` for one load balancer). The client is then the entry that many
  places from the right of `X-Forwarded-For` (what the proxies appended; what the client wrote left of
  them is never read). Only set it when every request reaches the app through those proxies, or a
  client could pick its own address. A request with no known address shares one `unknown` bucket.

## Signing keys

Each tenant has its own signing keys (ADR-0010), kept in the `oauthSigningKeys` collection by
`@softistx/janus-oauth-mongo`: the private JWK is encrypted with `CLAVIX_KEYS_MASTER_KEY`
(AES-256-GCM) and the store of a tenant, partitioned by its id, cannot read another's. Janus signs;
Clavix adds no `jose`.
- `signingKeysFor(tenantId)` and `jwksFor(tenantId)` (`src/config/keys.ts`; `tenantId` is the
  tenant's id in hex, `partitionOf`) give the OAuth endpoints the `SigningKeyStore` and the public JWKS.
- A tenant gets its first key when it is created (`TenantsService.create`). If that call fails it is
  logged and the tenant stands; the hourly job creates the key within the hour.
- Any deployment that holds real tenants (staging included) must set `CLAVIX_KEYS_MASTER_KEY`: the
  default is public. A tenant with no key yet has an empty JWKS: the OAuth endpoints treat it as transient.
- `CLAVIX_KEYS_MASTER_KEY` is generated with `openssl rand -base64 32`.
- Rotation: ES256 keys sign for 90 days; the next key is published 48 h before it takes over and
  a retired key stays published 24 h (`src/keys/policy.ts`). An hourly `key-rotation` job on
  `@softistx/redis` (cron `0 * * * *`) runs the step over every active tenant, and the server runs
  one pass at start, which also gives the seeded `clavix` tenant its key. Without `REDIS_URL`
  (development) only the pass at start runs.
- **Losing the master key** makes the stored keys unreadable (signing fails; the JWKS still
  serves, and each hourly pass logs a failure per tenant). Keep it in a secret manager, apart from
  the database. To recover, drop the tenants' `oauthSigningKeys` documents and let the rotation
  create new keys: tokens signed by the lost keys stop verifying once the JWKS no longer lists
  them. Changing a master key you still hold is not a loss: it rotates without downtime
  (`CLAVIX_KEYS_MASTER_KEY` takes a comma-separated keyring, first = current; `bun run keys:reseal`).
- **Rotating** the master key and the **emergency rotation** of the signing keys
  (`bun run keys:rotate <tenant>|--all [--drop-old]`) are in `docs/operations.md`, "Signing keys".
- `bun run db:sync` creates the collection's indexes (one `current` and one `next` key per tenant).

## Console API

`POST /console/graphql` is the console's own GraphQL API (SDL in `src/console`). It reads no
cookie and resolves no tenant from the host: the credential is an access token of the `clavix`
tenant whose audience is `https://console.<CLAVIX_DOMAIN>/api`, sent as `Authorization: Bearer`, or as `Authorization: DPoP` with a proof for the console URL (see
"DPoP-bound tokens").
No token, or a forged, expired or other-audience one, is a 401; the store down is a 503. It
exposes `me { user platformRole memberships { tenant { slug } role } }`, a tenant's clients,
resources and scopes, the admins of a tenant (below), the branding fields (see "Branding") and a
tenant's sign-in policy (see "Sign-in methods and social providers"). Tenants, their plans and their
trash are managed here too (below); `tenants:create` stays for scripted setups. The console shell's
tenant switcher, `me { switchableTenants }`, is described under "Switchable tenants" below.

**The console needs a verified e-mail** (ADR-0041). Every operation but `me { user platformRole emailVerified }` is refused to a caller
whose e-mail is not proved: HTTP 403, `extensions.code` `EMAIL_UNVERIFIED`, whatever the caller's
roles (platform operators included) and before any role check. `me { user platformRole emailVerified }` stays open and tells the UI
why; the tenant lists under `me` (`memberships`, `switchableTenants`) need the proof. The caller proves the address on the `clavix` tenant's hosted account page
(`requestEmailVerification`, then the link; see "E-mail verification"); the same token works at once.
Accepting an admin invitation proves the address, so a new admin is never refused. Accounts that
were unverified before are not migrated. Passkey and second-factor setup stay gated by janus with
the same code.

Roles are `owner`, `admin` and `viewer`, on the platform (inherited by every tenant) or on one
tenant; every field is refused unless its guard allows it.

### Switchable tenants

`me { switchableTenants(q, after, first) { items { role tenant { id slug name status } } nextCursor totalCount } }`
is the console shell's tenant switcher. For a tenant admin it lists the tenants of their roles; for a
platform operator, every tenant not in the trash. Each item carries the role they act with there (the
stronger of their direct role and their platform role). Items are ordered by slug and paged by cursor
(`first` is clamped to 1 to 100, default 25; `totalCount` is how many tenants the caller can switch to that match `q`, whatever the cursor or `first`; pass `nextCursor` as `after`: any other cursor is `BAD_USER_INPUT` (400), `The cursor is not valid`); `q` matches the start of the slug or part
of the name, case-insensitively. A suspended tenant stays listed (`tenant.status` is `SUSPENDED`; the
console stays readable on it); a tenant in the trash is left out, and a caller with no role gets an
empty page. Any signed-in caller whose e-mail is proved may ask (an unproved one gets `EMAIL_UNVERIFIED`); it never lists a tenant the caller holds no role on.
`me.memberships` lists direct roles only; a suspended tenant is listed with its `status`, a trashed one is left out.

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"{ me { switchableTenants(q: \"acme\", first: 10) { items { role tenant { slug name status } } nextCursor totalCount } } }"}'
```

### Admins of a tenant

A tenant's admins are users of the `clavix` tenant holding `owner`, `admin` or `viewer` on it.
`memberships(tenantId)` and `adminInvitations(tenantId)` need `view` on the tenant; `inviteAdmin(tenantId,
email, role)`, `changeMembership`, `removeMembership`, `resendAdminInvitation` and `revokeAdminInvitation` need `manage` (the
tenant's owner or a platform owner). An invitation is a janus invitation of the `clavix` tenant (scope =
`admin:<the managed tenant's id>`, role = the console role; any other scope grants no console role) and the e-mail links to `<clavix issuer>/invitation?code=`.
That hosted page calls `invitationPreview(code)` and `acceptInvitation(code)` on `/graphql` (the clavix
host): accepting makes the account (e-mail proved), grants the relation (`onAccepted`, once; a spent,
revoked or lapsed code is `INVITATION_INVALID`, 400) and, for a new account, opens the session and counts the user as active for the month. The grant runs under the same user lock as `deleteUser`, so an accept racing a delete either is swept by it or finds the account gone. Inviting an address that is
already a member is `ALREADY_MEMBER` (409); a second invitation to a pending address replaces it (new id, new inviter).
`resendAdminInvitation(tenantId, invitationId)` instead renews the same invitation: a new code and
lifetime, a new mail naming the caller, the old code stops working, a lapsed invitation is allowed.
It is `NOT_FOUND` (404) for an id that is not this tenant's, `INVITATION_NOT_PENDING` (409) once
accepted or revoked, and `RESEND_TOO_SOON` (429, `retryAfter` seconds) within 60 s of the last send of
that invitation. Invitations expose `invitedBy { id name }`, the operator who first invited (null when
a script did); a resend keeps it. The
last owner who can sign in (a disabled or deleted owner does not count) can be neither demoted nor
removed, nor disabled or deleted, on a tenant or on the platform: `LAST_OWNER` (409). An `owner`
invitation is refused once its inviter is deleted or disabled. Role changes of one
tenant run one at a time (a lock in the app's Redis, `REDIS_URL`; without Redis, outside production,
within the process), so two concurrent removals cannot leave a tenant with no owner. An invitee who
already has an account is not signed in by accepting (`signedIn: false`): the role is granted and they
sign in as usual. An invitation to a suspended or deleted tenant is `INVITATION_INVALID` until it is back.

Each of the five mutations that succeeds records an admin event (see "Admin events"), repeats included:
`membership.invite`, `membership.resendInvitation` and `membership.revokeInvitation` (target: the invitation's id, never the
address), `membership.change` and `membership.remove` (target: the user's id). Accepting an
invitation is the invitee's act on the hosted API and records none. A `userId` or `invitationId`
longer than 200 characters is `BAD_USER_INPUT` (400); a `tenantId` is 24 hexadecimal characters, in
any case.

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"mutation { inviteAdmin(tenantId: \"65f1c0de00000000000000a1\", email: \"ada@example.com\", role: ADMIN) { id email role expiresAt } }"}'
```

A membership write whose lock cannot be taken (held by another process past 5 s, or Redis down) is a
503 `SERVICE_UNAVAILABLE` and changes nothing: ask again. Accepting an invitation in that state fails the
same way and releases the invitation, so the invitee retries the same link. `removeMembership`, like
the other writes, is `NOT_FOUND` for a tenant that is gone or in the trash, and `TENANT_SUSPENDED` while it is suspended.

Deployment order: `bun run db:sync`, `bun run db:migrate` (the `2026-11-12-console` migration
registers the console resource and its confidential client `console` in the `clavix` tenant and
prints the client secret once: save it; the `2026-11-13-scopes` migration turns each resource's
scope strings into `Scope` documents), then name the first
operator. A fresh database has no user and the `clavix` tenant is invitation-only, so invite
the first one with `--create` (mailed link; the account and role are made when it is opened):

```sh
bun run operators:grant --email ada@example.com --create   # first operator on a fresh database
bun run operators:grant --email ada@example.com            # platform owner (account exists and is active; the grant runs under the user lock, like an accept)
bun run operators:grant --email bob@example.com --role viewer
```

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"{ me { platformRole } }"}'
```

### Users of a tenant

The end users of a tenant are the users of its own pool (ADR-0008), not its admins. Reads need
`view` on the tenant, every mutation `edit` (a tenant admin or a platform admin); a user, session,
grant or invitation id of another tenant is unknown, never touched.

| Operation                                                                           | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users(tenantId, after, first, email, emailPrefix)`                                 | A page (25, at most 100), oldest first, `nextCursor` null on the last, and `totalCount` (all the users matching, not the page size). `email` finds that exact address (any case); `emailPrefix` keeps the users whose address or username starts with it (any case, plain text; blank = no filter). Both at once, or a cursor janus refuses, is `BAD_USER_INPUT` (400).                                                                                                                                                                      |
| `userLookup(tenantId, query, first)`                                                | For the role member picker. Needs `edit` (the permission that assigns roles; a viewer is refused). `query` matches the start of the e-mail or username, or of the display name (any case, plain text); blank gives `[]`, over 254 characters is `BAD_USER_INPUT` (400). `first` defaults to 10, at most 20. E-mail matches first, then names, each user once; returns only `id`, `email`, `name`.                                                                                                                                            |
| `user(tenantId, id)`                                                                | One user, or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `inviteUser(tenantId, email)`                                                       | A janus invitation into the tenant's pool (scope `users`), mailed in the tenant's name; accepting on the tenant's hosted `/invitation` page makes the account (e-mail proved) even when sign-up is closed. A pending one of the same address is replaced; an address that already has an account is `USER_EXISTS` (409).                                                                                                                                                                                                                     |
| `userInvitations(tenantId)` / `revokeInvitation(tenantId, invitationId)`            | The pending, unlapsed ones; revoking is true also when there is none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `updateUser(tenantId, userId, input)`                                               | Renames the user (`input.name`, 1 to 200 characters once trimmed, else `BAD_USER_INPUT` 400; unknown user `NOT_FOUND`). The e-mail address is not editable: it changes through the user's own verified flow.                                                                                                                                                                                                                                                                                                                                 |
| `setUserEmailVerified(tenantId, userId, verified)`                                  | Sets or clears the verified flag and nothing else (no session, password or second factor changes); answers the user. Idempotent; unknown user `NOT_FOUND`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `disableUser` / `enableUser`                                                        | Idempotent. Disabling ends the user's sessions (a repeat ends any new one); an unknown user is `NOT_FOUND`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `revokeUserSessions(tenantId, userId)`                                              | Ends every session; answers how many (0 on a repeat or an unknown user).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `userSessions(tenantId, userId)` / `revokeUserSession(tenantId, userId, sessionId)` | The user's standing sessions, newest first: `id`, `device` (the User-Agent of the sign-in, cut at 256 characters; `null` on an older session or a sign-in without one), `createdAt`, `authenticatedAt`, `lastUsedAt` (moves at most once a day, `null` on an older session) and `expiresAt`; never the token. There is no `current` flag: the console reads another pool. `revokeUserSession` is true when it ended the session, false for one that is not this user's, is already ended or does not exist; an unknown user has no sessions. |
| `userGrants(tenantId, userId)` / `revokeGrant(tenantId, userId, grantId)`           | The OAuth grants the user gave (standing only, with the client's name), and taking one back with the tokens it opened. `revokeGrant` is true also when already revoked, false for a grant that is not this user's.                                                                                                                                                                                                                                                                                                                           |
| `deleteUser(tenantId, userId)`                                                      | Revokes the user's grants (and tokens), ends their sessions, removes their role assignments, deletes the user. True also when already gone.                                                                                                                                                                                                                                                                                                                                                                                                  |

Each mutation records an admin event, repeats included (`user.invite`, `user.revokeInvitation`,
`user.update`, `user.setEmailVerified`, `user.disable`, `user.enable`, `user.delete`, `user.revokeSessions`, `user.revokeSession`, `user.revokeGrant`; target: the
user, session, invitation or grant id, never an address).

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"mutation { inviteUser(tenantId: \"65f1c0de00000000000000a1\", email: \"bob@example.com\") { id expiresAt } }"}'
```

### Roles of a tenant's end users

A role is a name a tenant gives to some of its end users; it is released in their tokens as the
`roles` claim (not a console admin role). Reads need `view` on the tenant, mutations `edit`. A role
may be scoped to one of the tenant's resources (`resourceId`), else it applies to the whole tenant.
A name is 1 to 64 characters of letters, digits, `.`, `_`, `:` and `-`, unique per tenant and resource.

| Operation                                            | Does                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `roles(tenantId, resourceId)` / `role(tenantId, id)` | The roles by name (only a resource's with `resourceId`), with `memberCount` and `managed`; one role or `null`.                                         |
| `createRole(tenantId, input)` / `updateRole(...)`    | `{ name, description, resourceId }`; update changes the name or description. `CONFLICT` for a taken name, `NOT_FOUND` for an unknown resource or role. |
| `deleteRole(tenantId, id)`                           | Deletes the role and its assignments. True also when already gone. `ROLE_MANAGED` (403) for a managed role.                                            |
| `assignRole(tenantId, roleId, userId)`               | Idempotent. The user must be in the tenant's pool, else `NOT_FOUND`.                                                                                   |
| `unassignRole(tenantId, roleId, userId)`             | True when the user held it, false on a repeat.                                                                                                         |
| `roleMembers(tenantId, roleId, after, first)`        | A page (25, at most 100) of `{ user, assignedAt }`, oldest assignment first, with `totalCount` (all the holders, whatever the cursor).                 |
| `userRoles(tenantId, userId)`                        | The roles a user holds.                                                                                                                                |

`managed: Boolean!` is `true` for a role Clavix itself provides: `updateRole` and `deleteRole` refuse
it with `ROLE_MANAGED` (403) (assigning it stays allowed), so a UI hides Edit and Delete and shows a
badge. A role made with `createRole` is never managed.

Each mutation records an admin event (`role.create`, `role.update`, `role.delete`, `role.assign`,
`role.unassign`; an assignment records the role and the user). Deleting a user or a resource removes
the assignments and the resource-scoped roles that depended on them.

### Clients, resources and scopes

Every field takes the `tenantId` it works on. Queries need `view` on that tenant (any role),
mutations need `edit` (`owner` or `admin`); a viewer, or an admin of another tenant, gets
`FORBIDDEN`. Errors carry `extensions.code`: `NOT_FOUND` (an unknown or trashed tenant), `TENANT_SUSPENDED` (403: a suspended tenant's console stays readable, every write of its admins is refused; platform operators still write), `CONFLICT`, `QUOTA_EXCEEDED`,
`BAD_USER_INPUT`, `FORBIDDEN`. An id of another tenant is unknown: a query answers `null`, an
update `NOT_FOUND`, a delete `false`. Deleting twice answers `true` then `false`.

| Field                                                | What it does                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clients(tenantId, q, after, first)`                 | a page of clients in id order (`q` matches the name or the id), `nextCursor`, `totalCount` (all matches, whatever the cursor)                                                                                                                                                                                                                            |
| `client(tenantId, id)`                               | one client, or `null`                                                                                                                                                                                                                                                                                                                                    |
| `createClient(tenantId, input)`                      | `{ client, clientSecret }`; the secret of a confidential client, shown once. `redirectUris` may be empty with `grantTypes: [DEVICE_CODE]` or `[TOKEN_EXCHANGE]` (confidential only), and `updateClient` takes `grantTypes`. An id taken is `CONFLICT` (also when two calls race: one wins); past the plan's `clients` quota it is `QUOTA_EXCEEDED` (409) |
| `updateClient(tenantId, id, input)`                  | the name, the redirect URIs, `requirePushedAuthorizationRequests`; a client keeps its id and its type                                                                                                                                                                                                                                                    |
| `setClientTokenExchange(tenantId, id, input)`        | replaces the client's token exchange rules (`targetResources`, `subjectClients` or `anySubjectClient`); confidential clients only; audited as `client.tokenExchange.set`. `Client.tokenExchange` reads them (`null` = none)                                                                                                                              |
| `rotateClientSecret(tenantId, id)`                   | a new secret, shown once; the old one stops working; refused on a public client                                                                                                                                                                                                                                                                          |
| `deleteClient(tenantId, id)`                         | removes the client and revokes its grants and their tokens; a record that is not a registered client is left untouched (`false`)                                                                                                                                                                                                                         |
| `resources(tenantId)`, `resource(tenantId, id)`      | the tenant's APIs, each with its `scopes`                                                                                                                                                                                                                                                                                                                |
| `createResource`, `updateResource`, `deleteResource` | a resource keeps its URI; deleting it deletes its scopes                                                                                                                                                                                                                                                                                                 |
| `scopes(tenantId, resourceId)`                       | every scope of the tenant, or those of one resource                                                                                                                                                                                                                                                                                                      |
| `createScope`, `updateScope`, `deleteScope`          | a scope keeps its name and its resource                                                                                                                                                                                                                                                                                                                  |

```graphql
mutation {
  createClient(
    tenantId: "6731…"
    input: {
      name: "Back office"
      type: CONFIDENTIAL
      redirectUris: ["https://office.example.com/callback"]
    }
  ) {
    client {
      id
      name
      type
      redirectUris
    }
    clientSecret # shown once: janus keeps only its hash
  }
}
```

```graphql
mutation {
  createScope(
    tenantId: "6731…"
    input: {
      name: "invoices:read"
      resourceId: "6732…"
      description: { fr: "Lire vos factures", en: "Read your invoices" }
    }
  ) {
    id
    name
    description {
      fr
      en
    }
    resourceId
    claims
  }
}
```

- **A client id** is `input.clientId` (`a-z0-9-`) or the name in that form; one that exists is a
  `CONFLICT`. Redirect URIs follow the rules of `clients:create` (below).
- **A scope** belongs to a resource, where its name is unique: two resources may each have a
  `read`. Without `resourceId` it is a standard OpenID Connect scope and its name must be `openid`,
  `profile` or `email`: this is how a tenant writes the consent text of those. `claims` is stored
  only; no claim is emitted from it yet.
- **The consent page** shows a scope's `description` as its label, in the viewer's language
  (`Accept-Language`: French, else English), then in the other language, then the scope's name.
- **A change serves at once**: the scopes a resource offers are read on every OAuth request.
- **Limits**: a name has at most 100 characters, a description 300, a scope 50 claims, a client 20
  redirect URIs, a search 100 characters; more is `BAD_USER_INPUT`.
- **The console's own client and resource** (`console` in the `clavix` tenant) cannot be changed
  or deleted here (`BAD_USER_INPUT`): use `clients:create --client-id console --rotate-secret`.
- **Listing**: clients come in id order; a client made by `clients:create` is listed too. With
  `q`, a page may hold fewer than `first` items (even none) and still give a `nextCursor`: follow
  it until it is `null`.
- **`grantTypes`** on a client is what was recorded when it was registered (`authorization_code` and
  `refresh_token` by default, or the script's `--grants` or the console's `grantTypes`, which may add `DEVICE_CODE` or `TOKEN_EXCHANGE`), and the token endpoint enforces it: a client that does not
  list a grant gets `unauthorized_client` on it. A list that omits `refresh_token` cannot refresh.
- **Deleting a client** signs its users out of it: the grants they gave it and the tokens those
  opened are revoked.

### Tenants, plans and usage

Queries: `tenants` needs `view` on the platform (any operator role); `tenant` and `usage` need
`view` on that tenant; `plans` is open to any signed-in caller with a proved e-mail. Mutations: `updateTenant` needs
`edit` on the tenant (`owner` or `admin`, a tenant admin included); the other six need `edit` on the
platform (`owner` or `admin` operator). Every mutation is audited (`tenant.create`, `.update`,
`.setPlan`, `.suspend`, `.resume`, `.delete`, `.restore`, see "Admin events"). Errors carry
`extensions.code`: `NOT_FOUND`, `BAD_USER_INPUT`, `SLUG_TAKEN`, `PLATFORM_TENANT_PROTECTED`,
`TENANT_SUSPENDED`, `FORBIDDEN`.

| Field                                   | What it does                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tenants(q, status, after, first)`      | a page of tenants by slug, the trash included (status `DELETED`), purged ones left out, `totalCount` follows `q` and `status` |
| `tenant(id)`                            | one tenant; a tenant in the trash is `null` unless the caller is a platform operator                                          |
| `plans`                                 | `free`, `pro`, `enterprise`, with their quotas (`mau`, `clients`, `domains`; `null` is no limit)                              |
| `usage(tenantId, month)`                | monthly active users, clients and domains against the quotas that apply                                                       |
| `createTenant(input)`                   | slug (for ever), name, `signUp`, `plan`; `SLUG_TAKEN` for a slug in use, in the trash or purged                               |
| `updateTenant(id, input)`               | the name and `signUp`; the slug never changes                                                                                 |
| `setTenantPlan(id, input)`              | the plan and the whole set of quota overrides (`null` follows the plan)                                                       |
| `suspendTenant(id)`, `resumeTenant(id)` | sign-in, authorize and token are refused with `TENANT_SUSPENDED` until resumed; idempotent                                    |
| `deleteTenant(id)`, `restoreTenant(id)` | the trash (below)                                                                                                             |

The `Tenant` type carries `status` (`ACTIVE`, `SUSPENDED`, `DELETED`), `plan`, `quotas`, `deletedAt`
and `purgeAt`. The `clavix` tenant cannot be suspended or deleted (`PLATFORM_TENANT_PROTECTED`).

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"mutation { suspendTenant(id: \"6731…\") { status } }"}'
```

**The trash.** `deleteTenant` puts the tenant in the trash: it behaves as suspended, is hidden from
its own admins and keeps `deletedAt`; `purgeAt` is 30 days later. Until then a platform operator can
`restoreTenant` it, with the status it had. At `purgeAt` the scheduled purge empties it for good.
The job (`tenant-purge`, a Redis queue with a daily cron at 03:17 UTC, plus one pass at server start;
without Redis only the start pass runs) takes only tenants whose 30 days are over, never a live,
suspended or restored one. Per tenant it claims it first (from then on it resolves nowhere and
cannot be restored), then removes:
- the janus partition: OAuth clients, requests, codes, grants, access and refresh tokens and the
  signing keys, then users, sessions, tokens, social links, passkeys and invitations (the counts per
  collection are logged);
- the tenant-owned collections (branding, usage counters, ...);
- its roles and platform link in the console's permissions.

`adminEvents` stay (the platform's record; the purge itself records no event: it has no actor, `tenant.delete` already
recorded who trashed the tenant, and the per-collection counts are logged), and the Redis active-user counters are not deleted (they
hold hashed ids and expire after 400 days). A purge is not a transaction: a failing tenant stays
claimed, the tick fails and the next run resumes it; a second run finds nothing to remove. What is
left is a tombstone (slug, `deletedAt`, `purgedAt`): the slug stays reserved for good, so
`createTenant` with it is `SLUG_TAKEN`.

### Admin events

Every console mutation records what it did in the `adminEvents` collection (ADR-0037): the actor
(the token's user), the action (`tenant.create`), the tenant it was about (`null` for the platform),
the target's type and id, the time and the id of the request. Events are only ever added, and they
hold identifiers alone: never a secret, a token or the old and new values of a field. `bun run
db:sync` creates the collection and its two indexes (by tenant and by actor, newest first). Nothing
reads it yet: the viewer and the export come with M4.

A mutation declares its action beside its module's guards (the declaration is spread into `audits`
in `src/console/modules/index.ts`) and records it once its change is stored; AGENTS.md "Admin
events" has the rules:

```ts
// src/console/modules/tenants/index.ts
export const tenantsAudits: Audits = {
  "Mutation.renameTenant": "tenant.rename",
};

// in the resolver, after the write
await ctx.audit("tenant.rename", { type: "tenant", id: tenantId, tenantId });
```

`ctx.audit` is awaited: when the event cannot be stored, the mutation fails (and may be retried)
rather than leave a change with no record. `src/console/audit.spec.ts` fails for a mutation whose
module declares no action.

## Sign-in methods and social providers

Each tenant chooses how its users sign in
([docs/guide/sign-in-methods.md](docs/guide/sign-in-methods.md) has every operation and error).
- **Methods**: `PASSKEY` and `EMAIL_CODE` are on for a new tenant, `MAGIC_LINK` is off, and
  `PASSWORD` is listed but not available yet. A method that is off answers 404
  `SIGN_IN_METHOD_DISABLED` (`MAGIC_LINK_DISABLED` for the link) on the tenant's host.
- **Social providers**: Google, GitHub and Microsoft through `@softistx/janus-social`, each tenant
  with its own client id and secret. The redirect URI to register at the provider is the
  `callbackUrl` the console returns: `https://<tenant host>/sign-in/social/<provider>/callback` (the host is the tenant's issuer: its primary custom domain when set, else the slug host).
- **At least one way in**: a change that would leave no enabled method and no enabled provider is
  refused, 409 `NO_SIGN_IN_METHOD`.
- **Secrets**: a client secret is sealed with AES-256-GCM under a key derived from
  `CLAVIX_KEYS_MASTER_KEY` (HKDF-SHA256, label `social-secrets`) and stored as the envelope
  `{ v, kid, iv, ct }`, bound to its tenant and provider. No query returns it (`hasSecret` only)
  and it is never logged. Losing the master key, or dropping the old key from the keyring while a secret is still sealed under it (see docs/operations.md, "Signing keys"), makes it unreadable: the provider is
  left out with a warning that names the tenant and provider, and the admin enters the secret again.

```sh
curl -s https://api.clavix.example/console/graphql \
  -H "authorization: Bearer $CONSOLE_ACCESS_TOKEN" -H "content-type: application/json" \
  -d '{"query":"mutation ($t: ID!) { updateSignInMethods(tenantId: $t, methods: [{ type: MAGIC_LINK, enabled: true }]) { version methods { type enabled available } } }","variables":{"t":"<tenant id>"}}'
```

```graphql
# On the tenant's host, POST /graphql: what the hosted sign-in page offers.
{
  hostedSignInMethods {
    methods
    social {
      id
      label
    }
  }
}
```

## Pushed authorization requests

Each tenant host serves `POST /par` (RFC 9126, `@softistx/janus-oauth`): a client authenticates on
the back channel, pushes its authorization request, gets a one-use `request_uri` (60 s) and sends
the user to `/authorize?client_id=…&request_uri=…`. Discovery advertises
`pushed_authorization_request_endpoint`, and `require_pushed_authorization_requests` when the tenant requires it.
- **Per tenant** (`oauthPolicy`, `updateOAuthPolicy`; `view` / `edit` on the tenant): `par.required`
  makes every client push; an `/authorize` without a `request_uri` is refused `invalid_request`. A new
  tenant starts with it **on**; a tenant that existed before it (migration `2026-11-16-oauth-policy`)
  stays **off** until an admin turns it on. `dpop.required` is the same switch for DPoP (below).
  Each change is the admin event `oauthPolicy.update` and bumps the tenant's `version`; a no-op writes nothing.
- **Per client** (`requirePushedAuthorizationRequests` on `Client`, `CreateClientInput` and
  `UpdateClientInput`, or `clients:create --require-par`): only that client must push, on a tenant
  that does not require it of everyone.
- **The platform tenant (`clavix`)** requires PAR and DPoP like any tenant: migration
  `2026-11-17-console-par-dpop` turns both on for it and for the `console` client. Deploy the console
  (clavix-ui) first or together, since it pushes (PAR) and proves (DPoP, ES256) from then on.
- A suspended tenant's `/par` answers 403 `TENANT_SUSPENDED`, like `/authorize`. Turning the requirement on breaks
  a client that does not push: warn its owner first.

```graphql
mutation ($t: ID!) {
  updateOAuthPolicy(tenantId: $t, input: { par: { required: true } }) {
    version
    par {
      required
    }
    dpop {
      required
    }
  }
}
```

## DPoP-bound tokens

Every tenant host accepts DPoP at `/token` and `/par` (RFC 9449, `@softistx/janus-oauth`): a client that sends a `DPoP` proof
with its token request gets `token_type: "DPoP"` and an access token bound to its key (`cnf.jkt` in
the JWT); a public client's refresh token is bound to the key too, so refreshing needs a proof from the
same key. One that sends none still gets a `Bearer` token, unless DPoP is required. A public client whose `grantTypes` omit `refresh_token` gets a bound access token and no refresh token; a
refresh token issued before DPoP was on stays unbound, so the client signs in again to get a bound one.
Discovery
advertises `dpop_signing_alg_values_supported` (`ES256`, `EdDSA`).
- **Proofs are single-use and carry a server nonce**: the replay cache is `oauthDpopReplay` in Mongo
  (shared by every instance) and the nonces are stateless HMACs under a secret derived from
  `CLAVIX_KEYS_MASTER_KEY` (HKDF-SHA256, info `dpop-nonce`; nothing to configure). A client's first
  request gets `400 use_dpop_nonce` with a `DPoP-Nonce` header: it signs a new proof naming that nonce
  and retries once. The code is not spent by the refused request.
- **The proof's `htu` is the public URL** (`https://<slug>.<CLAVIX_DOMAIN>/token`, the issuer's), never
  the address behind the proxy.
- **Per tenant** (`oauthPolicy.dpop.required`, `updateOAuthPolicy`): every token request of every
  client needs a proof, else `invalid_dpop_proof`. Off for every tenant, new ones included, until an
  admin turns it on. Tokens issued before it stay valid until they lapse. The `clavix` platform tenant
  requires it (migration `2026-11-17-console-par-dpop`): the console API then takes only DPoP-bound tokens.
- **Per client** (`dpopBoundAccessTokens` on `Client`, `CreateClientInput` and `UpdateClientInput`, or
  `clients:create --dpop-bound` / `--no-dpop-bound`): only that client must send a proof. Kept on a
  re-run unless the flag is given.
- **Resources**: `/userinfo` and `/introspect` take a bound token as `Authorization: DPoP <token>` with a
  proof (`ath` is the token's hash); a bound token sent as `Bearer` is refused, and introspection reports
  `token_type: "DPoP"` and `cnf.jkt`. The console API (`/console/graphql`) takes `Authorization: DPoP`
  too: a refused request answers `WWW-Authenticate: DPoP …` and, when the proof lacked the nonce,
  `DPoP-Nonce`; its proof's `htu` is `https://console.<CLAVIX_DOMAIN>/console/graphql`.

```sh
bun run clients:create --tenant acme --name "Back office" --confidential \
  --redirect-uri https://office.example.com/callback --dpop-bound
```

```graphql
mutation ($t: ID!) {
  updateOAuthPolicy(tenantId: $t, input: { dpop: { required: true } }) {
    dpop {
      required
    }
  }
}
```

## Device authorization grant

Each tenant host serves `POST /device_authorization` (RFC 8628, `@softistx/janus-oauth`) for a client that has no
browser or keyboard (a TV, a CLI, a device): the client gets a `device_code`, a short `user_code` and a
`verification_uri` (`https://<tenant host>/device`), shows the code, and polls `/token` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code` while the user decides on another device.
Discovery advertises `device_authorization_endpoint`.
- **A client opts in.** The grant is never implied: the client must list it (`clients:create --grants urn:ietf:params:oauth:grant-type:device_code`, or
  `grantTypes: [DEVICE_CODE]` on `CreateClientInput` / `UpdateClientInput`). Any other client gets
  `unauthorized_client` on `/device_authorization`. Add `REFRESH_TOKEN` to get a refresh token. The grant is
  served by every tenant and gated only by the client's grant types (no tenant setting).
- **A device-only client has no redirect URI.** `--redirect-uri` and `redirectUris` are required only when the
  client lists `authorization_code` (the default grants, or an explicit `--grants authorization_code,urn:ietf:params:oauth:grant-type:device_code`).
  A re-run without `--grants` judges the client's stored grants, so a device-only client needs no URI then either.
  A client's grants must include `authorization_code`, the device URN or the token-exchange URN.
- **The user decides on the hosted page** `/device` (clavix-ui): they type the user code, see the client's name and
  host, the resource and the scopes with the tenant's own labels (`oauthDeviceRequest`), and approve or refuse
  (`approveOAuthDeviceRequest`, `denyOAuthDeviceRequest`, optionally with fewer scopes). The viewer must be signed in
  to that tenant. Approving needs a session proved in the last 5 minutes (else `STEP_UP_REQUIRED`: sign in again, the request stays
  pending); refusing does not. A code of another tenant is `NOT_FOUND`.
- **The device polls** with the janus answers: `authorization_pending`, `slow_down` (poll less often, the interval
  grows by 5 s), `access_denied`, `expired_token` (the code lived 10 minutes) and `invalid_grant`. A successful
  poll returns the access token, the `id_token` when `openid` was approved, and a refresh token when granted.
- **Guessing a user code is throttled** (Redis): every lookup of the three operations counts, hit or miss, per
  signed-in user (`CLAVIX_DEVICE_USER_*`), per client address and tenant (`CLAVIX_DEVICE_IP_*`) and per tenant
  (`CLAVIX_DEVICE_TENANT_*`). Past a limit: `DEVICE_CODE_THROTTLED`, HTTP 429 with `Retry-After`. Redis down: the
  request goes through, logged. Janus runs the hook before it reads the store, so a miss cannot be counted alone.
- **A suspended tenant's** `/device_authorization` answers 403 `TENANT_SUSPENDED`, like `/authorize` and `/par`.
  The proxy must route the path to the API (`deploy/Caddyfile` does).
- **Phishing**: a user code is typed by the user, so the page shows who is asking (the client's name and registered
  host) and what; never approve a code someone else read to you. See `docs/guide/device-authorization.md`.

```sh
bun run clients:create --tenant acme --name "Living room TV" --grants urn:ietf:params:oauth:grant-type:device_code
```

## Token exchange (RFC 8693)

A confidential client (a service, an agent) trades a user's access token for another one, `POST /token` with
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (`@softistx/janus-oauth`), on every tenant host.
- **Opt-in twice.** The client lists the grant (`clients:create --confidential --grants urn:ietf:params:oauth:grant-type:token-exchange`, or
  `grantTypes: [TOKEN_EXCHANGE]`) and the tenant's operator gives it rules (`setClientTokenExchange`). Without the
  grant: `unauthorized_client`. Without rules, or a request they do not allow: `access_denied`. A public client is
  refused at registration and at `/token`. It needs no redirect URI.
- **Rules** (collection `clientPolicies`, tenant-owned, one document per client, run `bun run db:sync`):
  `targetResources` (at most 20 resource URIs of the tenant; the requested `resource` must be listed) and
  `subjectClients` (at most 50 client ids whose tokens may be exchanged) or `anySubjectClient`. The mode is always
  `delegation`.
- **The result** is a delegation: scopes only narrow, there is no refresh token, the token carries `act`
  (`{ sub, client_id }` of the caller, also in introspection), and it lives under the subject's grant: revoking the
  grant or deleting the subject client kills it. Another tenant's token is `invalid_grant`.
- **Deleting the client** deletes its rules; deleting the tenant purges them.

```sh
bun run clients:create --tenant acme --name "Agent" --confidential --grants urn:ietf:params:oauth:grant-type:token-exchange
```

See `docs/guide/token-exchange.md`.

## Branding

A tenant wears its own theme on the hosted pages. The brand is one document per tenant (collection
`branding`, tenant-owned, run `bun run db:sync` to create it): display name, seed colour, radius,
optional background preset and motif (ids of `@softistx/material-core/backgrounds`), an optional logo,
and the generated stylesheet.

`updateBranding` on `/console/graphql` replaces the whole brand (the logo is kept unless `logo` or
`removeLogo` is sent), so repeating a call changes nothing (`changed: false`). It compiles the seed with
`defineTheme` and `themeToCss({ scope: "attribute" })`, measures every pair with `checkThemeContrast` in
light and dark, and stores the CSS only when all pass WCAG AA. A pair that fails is `BRANDING_CONTRAST`
(422, `extensions.failures`: foreground, background, mode, ratio, minimum). The generator moves a hard
seed (a yellow) lighter or darker to reach AA on its own; the payload's `warnings` say what it moved.
A bad value is `BAD_USER_INPUT` (400, `extensions.field`). `branding(tenantId)` needs `view` on the tenant,
`updateBranding` needs `edit`. Each call that succeeds records the admin event `branding.update`.

The display name is a label only: it is stored as text and never written into the stylesheet. The seed
and the radius are parsed, and the CSS is built from the parsed values, so a value that is not a colour
or a length is refused rather than copied. Escape the display name where you print it. Two calls at the
same time apply one after the other (the document carries a `version`), so a logo one of them sets or
removes is not undone by the other; a call that keeps losing to others is `CONFLICT` (409) and stored
nothing: read the brand and send it again.

Limits: `displayName` 1 to 80 characters; `radius` in rem or px up to 3rem (48px); `backgroundPreset`
and `motif` must be ids of `@softistx/material-core/backgrounds`.

```graphql
mutation {
  updateBranding(
    tenantId: "..."
    input: { displayName: "Acme", seed: "#0a7ea4", radius: "0.5rem" }
  ) {
    changed
    warnings
    branding {
      themeName
      css
      logoUrl
    }
  }
}
```

A logo is a PNG, JPEG or WebP of at most 256 KiB (`logo: { contentType, dataBase64 }`); SVG is refused
because it can carry script. The hosted pages read `tenantBranding` on `/graphql` (anonymous, by the
request host; `null` keeps Clavix's own theme): they put `css` in a `<style>` and set
`data-nxgt-theme="<themeName>"` on the root element, and draw the page's background from
`backgroundPreset` and `motif` (not part of the CSS; `null` for none).

```graphql
{
  tenantBranding {
    displayName
    themeName
    css
    backgroundPreset
    motif
    logoUrl
  }
}
```

`GET /branding/logo` on the tenant's host serves the logo with an `ETag` (its sha256), `304` on
`If-None-Match`, `nosniff` and a sandboxing CSP; `404` (not stored) for an unknown host or a tenant
without a logo, `405` for a method other than GET or HEAD. `logoUrl` is
`/branding/logo?v=<start of the hash>`, so it changes with the image: asked with the current `v` the
logo is `Cache-Control: public, max-age=31536000, immutable`; the bare path, or an old `v`, is
`max-age=300, must-revalidate`.

## Tenants

The console API (`createTenant`) is the normal way to create a tenant; the script is for the first ones, and goes through the same `TenantsService` the
platform uses (slug rules, reserved slugs, the tenant's first signing key). The script prints the
tenant as JSON, with its issuer, `https://<slug>.<CLAVIX_DOMAIN>`.

```sh
bun run tenants:create --slug acme --name "Acme"
bun run tenants:create --slug acme --name "Acme" --sign-up   # open sign-up for unknown e-mails
```

| Flag        | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `--slug`    | required; 2 to 63 characters, lowercase letters, digits and inner hyphens; never changes |
| `--name`    | required; the display name                                                               |
| `--sign-up` | open sign-up; default is closed (invitation only)                                        |
- **Idempotent**: re-running with the same values creates nothing (`created: false`). An existing
  slug with another name, or a `--sign-up` that differs from its setting, is refused, not edited.
  Bad input exits 1 with the usage; `--help` prints it.
- **Refused**: an invalid or reserved slug (`console`, `www`, `api`, ...) and the slug of a deleted
  tenant, which stays reserved for good.
- The first signing key is made at creation; if that fails (logged), the hourly rotation job makes it.
- Then register its clients with `clients:create`.

## Resources

An access token is bound to one resource (RFC 8707): the API it is for. A tenant registers its
APIs in the console ("Console API") or by script. A resource is per tenant: `acme`'s is unknown to
`globex` (`invalid_target`). A client asking `resource=<uri>` gets a token whose `aud` is that URI,
signed with the tenant's key; an unregistered URI is refused. Re-running with the same URI updates
the name and replaces the scopes (a scope that stays keeps its consent texts). It serves at once, with no restart.

```sh
bun run resources:create --tenant acme --uri https://api.acme.example \
  --scope invoices:read --scope invoices:write
```

| Flag              | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `--tenant <slug>` | required; an unknown slug or a suspended tenant is refused        |
| `--uri <uri>`     | required; `https` (`http` on a loopback host), no fragment        |
| `--scope <s>`     | required, repeatable; printable ASCII without space, quote or `\` |
| `--name <name>`   | a label; default: the URI's host                                  |

A URI is matched exactly as stored (`resource=` is compared as a string): register it as the API
sends it. The tenant's own `<issuer>/userinfo` is built in (the default resource of OIDC clients that send
none) and cannot be registered.

## OAuth clients

A client is registered on a tenant in the console ("Console API") or by script. Clients are per tenant:
they live in the tenant's partition of the janus collections, so a client of `acme` is unknown to
`globex` (its `/authorize` answers `invalid_client`).

```sh
bun run clients:create --tenant acme --name "Back office" \
  --redirect-uri https://office.example.com/callback --confidential
bun run clients:create --tenant acme --name "Web app" \
  --redirect-uri https://app.example.com/callback          # a public client, PKCE only
```

| Flag                   | Meaning                                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tenant <slug>`      | required; an unknown slug or a suspended tenant is refused                                                                                                                                                                                                                               |
| `--name <name>`        | required                                                                                                                                                                                                                                                                                 |
| `--redirect-uri <uri>` | repeatable; required unless the client lists no `authorization_code` (device or token exchange only); exact match, janus's rules (HTTPS, no fragment, loopback `http` allowed)                                                                                                           |
| `--confidential`       | `client_secret_basic`; default is a public client (`none`, PKCE `S256`)                                                                                                                                                                                                                  |
| `--client-id <id>`     | the client's id in the tenant (`a-z0-9-`); default: the name as `a-z0-9-`                                                                                                                                                                                                                |
| `--grants <a,b>`       | `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`, `urn:ietf:params:oauth:grant-type:token-exchange`; default `authorization_code,refresh_token` (see below); the token-exchange URN is for a confidential client and needs rules set in the console |
| `--require-par`        | the client must push its authorization requests to `/par` (kept on a re-run; `--no-require-par` clears it)                                                                                                                                                                               |
| `--dpop-bound`         | the client's tokens are bound to a DPoP key (RFC 9449): its token requests must carry a proof (kept on a re-run; `--no-dpop-bound` clears it)                                                                                                                                            |
| `--rotate-secret`      | a new secret for an existing confidential client                                                                                                                                                                                                                                         |
- **Idempotent on the client id**: a re-run replaces the name and the redirect URIs of the client
  and creates nothing new. The output (JSON) says `created: true | false`.
- **A confidential client's secret is printed once**, in `clientSecret`; janus keeps only its
  SHA-256. A re-run prints `clientSecret: null` and keeps the secret; `--rotate-secret` mints another.
- **A client keeps its type**: re-running a confidential client without `--confidential` is
  refused (the secret is never dropped silently); a public client re-run with `--confidential`
  becomes confidential and gets a secret.
- The output also carries `issuer`, `tenant`, `redirectUris` and `type`. `--help` prints the
  usage; bad input prints the message and the usage and exits 1.
- **Grants**: `--grants` is stored on the client and shown by the console (`grantTypes`), and janus-oauth
  enforces it (`unauthorized_client` on `/authorize`, the code exchange, the refresh grant,
  `/device_authorization`, the device `/token` and the token exchange). An absent list means authorization code and
  refresh. An explicit list is taken as written: it must name `authorization_code` or the device or token-exchange URN,
  and `refresh_token` for a client that refreshes (`--grants authorization_code` alone cannot
  refresh; `refresh_token` alone is refused). A client without `authorization_code` needs no redirect
  URI. The token-exchange URN needs `--confidential`. Any other grant (client credentials) is refused.

## OpenID Connect

Each tenant host is its own OpenID Provider (ADR-0003), served by `@softistx/janus-oidc`:

| Path                                | What                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `/.well-known/openid-configuration` | discovery: the issuer, endpoints, `jwks_uri`, supported scopes and algorithms  |
| `/jwks.json`                        | the tenant's public signing keys (verifies access tokens and id_tokens)        |
| `/userinfo`                         | `sub` and the claims the token's scopes release (`profile`, `email`, ...)      |
| `/introspect`                       | RFC 7662, for a confidential client of the same tenant (`client_secret_basic`) |
| `/par`                              | RFC 9126 pushed authorization requests (see "Pushed authorization requests")   |
| `/device_authorization`             | RFC 8628 device authorization (see "Device authorization grant")               |

A client that asks for `openid` gets an `id_token` (`iss`, `sub`, `aud`, `exp`, `iat`,
`auth_time`, `nonce`, `at_hash`) signed with the tenant's current key. A request with no
`resource` is for the tenant's userinfo. Introspection answers only for tokens of the tenant's
own resources. A tenant with no signing key yet answers 503 `temporarily_unavailable`. The
claims come from the users of the tenant (see "Users per tenant").

**The `roles` claim** (an array of names, sorted) is in the `id_token`, in `/userinfo` and in the JWT
access tokens, with no scope to ask for. The tenant-wide roles of the user are in all three; a role
scoped to a resource is only in the access tokens issued for that resource (its URI is the audience),
so the `id_token` and userinfo, which have no audience, never carry it. A refreshed token carries the
roles the user holds then. The `id_token` also carries the `email` and profile claims.

**The `sub` claim** is the janus user id of the signed-in user in that tenant, unchanged
(`janus-oidc` sets `sub` to the session's `userId` in the id_token and in `/userinfo`; no
hashing, no pairwise value). Janus mints that id in its core (`mintId`) when the user is created:
a lowercase, hyphenated **UUIDv7** (36 characters, e.g. `0192f3a4-5b6c-7d8e-9f01-23456789abcd`),
time-ordered by creation. It is stable: it never changes for a user, whichever client asks, and
it is not derived from the e-mail, so changing the e-mail does not change it. It is unique per
tenant, not across tenants: the same person in two tenants is two users with two unrelated
`sub`s, and a `sub` of one tenant is unknown to another. Treat it as an opaque string (currently
36 characters; do not rely on the shape), keyed together with the issuer (`iss`, the tenant host).

## Users per tenant

Each tenant has its own user pool (ADR-0008): one `@softistx/janus` instance per tenant
(`createJanusIssuers`, `src/users`), built on its first request and rebuilt when the tenant's
`version` moves, over its partition of the janus user stores (`partitioned*` collections,
partition = the tenant's id in hex; `bun run db:sync` creates them). The same e-mail is two users in
two tenants, and a user id, a session or a token of one tenant is unknown to another. An unknown
or suspended host has no instance.
- **Session cookie**: `__Host-clavix-session`, host-only (no `Domain`), `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`: a browser never sends one tenant's session to another host.
- **Lifetime**: 14 days, sliding (renewed once a day), and never more than 30 days after sign-in
  (`session.absolute`): past it the session is anonymous however recently it was used.
- **Passkey relying party** (a default to confirm before the first production passkey, since a passkey is bound to its relying party for good): the tenant's own host. `rpIdOf(tenant)` is
  `<slug>.<CLAVIX_DOMAIN>` and `originOf(tenant)` its origin (`src/users/rp.ts`); the verified custom domains are its related origins (`passkeys.relatedOrigins`, see Custom domains).
- `authFor` and `claimsFor` (`src/config/users.ts`) are the OAuth issuers' ports, wired in
  `src/server.ts`. Consent and passkeys are below, and a client's `/authorize` needs a resource: userinfo's, or one
  registered with `resources:create`. `__Host-` cookies need https (Chrome accepts `localhost`).

## Consent (the hosted page's API)

`/authorize` redirects a user to `/consent?request_id=<id>` on the tenant's host: a page of clavix-ui,
which calls `POST /graphql` (the same API as the e-mail code sign-in) with the tenant's session cookie
(`__Host-clavix-session`, same host: send the request with credentials). Served by
`src/modules/consent` (janus-oauth's `oauthResolvers`; the OAuth server and the signed-in user are both
the request host's tenant's, so a request id or a session of another tenant is `NOT_FOUND` /
`UNAUTHENTICATED`).

```graphql
query Consent($id: ID!) {
  oauthRequest(id: $id) {
    id
    client {
      id
      name
      url
      host
    } # show id and host, not only the self-declared name
    redirectHost # and the host the user is sent back to
    resource
    redirectUri
    expiresAt
    scopes {
      name
      label
    }
  }
  connectedApps {
    id
    client {
      id
      name
    }
    scopes {
      label
    }
    createdAt
  }
}
mutation Allow($id: ID!, $scopes: [String!]) {
  # scopes: a subset, omit for all
  approveOAuthRequest(id: $id, scopes: $scopes) {
    redirectTo
    grantId
  }
}
mutation Refuse($id: ID!) {
  denyOAuthRequest(id: $id) {
    redirectTo
  } # redirectTo carries error=access_denied
}
mutation Revoke($id: ID!) {
  revokeConnectedApp(id: $id)
}
```

The page sends the user agent to `redirectTo` (the client's redirect URI with `code` or the error,
`state` and `iss`). Errors carry `extensions.code`: `UNAUTHENTICATED` (401: sign in with the e-mail
code, then come back to `/consent`), `NOT_FOUND` (404: unknown, decided, lapsed or another tenant's
request, a host with no tenant, or a consent request that is not same-origin JSON, see "Same origin on /graphql"), `BAD_USER_INPUT` (a
scope not asked for), `STEP_UP_REQUIRED` (403).
- **Freshness**: `approveOAuthRequest` needs a session that proved who it is in the last 5 minutes
  (janus-oauth's default `freshWithin`). An older one is `STEP_UP_REQUIRED`: the page signs the user in
  again with a new e-mail code (`requestSignInCode`, `verifySignInCode`), then repeats the mutation;
  the request stays pending. `denyOAuthRequest` and the read do not ask. janus's `auth.stepUp.*`
  mutations are not exposed.
- **Same origin, JSON only**: this holds for every `/graphql` operation, not only consent (see "Same
  origin on /graphql" below).
- **`auth_time`** of the id_token is the session's sign-in time (`authenticatedAt`). **No `amr` or
  `acr`**: janus-oauth's resolvers pass none (`approve` takes them, the GraphQL surface does not), and
  M1 needs neither.

## E-mail code sign-in

The hosted pages call the GraphQL API on the tenant's own host (`https://<slug>.<CLAVIX_DOMAIN>/graphql`):

```graphql
mutation {
  requestSignInCode(email: "ada@example.com") {
    challenge
    expiresAt
  }
}
mutation {
  verifySignInCode(challenge: "...", code: "123456") {
    user {
      id
      email
    }
    expiresAt
  }
}
query {
  currentUser {
    id
    email
    name
    emailVerified
  }
}
mutation {
  signOut
}
```

A 6-digit code is mailed from `no-reply@<CLAVIX_DOMAIN>` (valid 10 minutes, 5 attempts, 5 mails per
address per 10 minutes). `verifySignInCode` sets the `__Host-clavix-session` cookie; a wrong, spent
or foreign code is always `CODE_INVALID` (401). A tenant with `signUp: false` (the default, and
`clavix`) answers an unknown address exactly like a known one and creates and sends nothing: users
come in by invitation. `requestSignInCode.expiresAt` is the challenge's expiry, `verifySignInCode.expiresAt` the session's. The hosted pages (a BFF) keep the challenge and send it back with the code. `signOut` clears the cookie. An unknown host is `NOT_FOUND`; `MAIL_THROTTLED` is HTTP 429. Without `CLAVIX_SMTP_URL` (development, tests) mails are kept in memory.

## Magic-link sign-in

Off by default, per tenant: a tenant's admin turns it on in its sign-in policy
(`updateSignInMethods`, see "Sign-in methods and social providers"); there is no global switch.
Off, both operations answer HTTP 404 `MAGIC_LINK_DISABLED` before anything is counted, written or
mailed, so the surface looks absent; the hosted page hides its button. Same endpoint as the e-mail code
(`https://<slug>.<CLAVIX_DOMAIN>/graphql`):

```graphql
mutation {
  requestMagicLink(email: "ada@example.com") {
    expiresAt
  }
}
mutation {
  confirmMagicLink(token: "...") {
    user {
      id
      email
      emailVerified
    }
    expiresAt
  }
}
```

`requestMagicLink` mails a link `https://<slug>.<CLAVIX_DOMAIN>/sign-in/link?token=<token>` (valid
15 minutes; only the last link a user asked for works). The answer is the same for an address with
an account, one without and, on a `signUp: false` tenant, one that is not invited (nothing is created
or sent for the last). The hosted page behind that URL must show a button that POSTs the token to
`confirmMagicLink`: never sign in on the `GET`, mail scanners open links and would spend the token.
`confirmMagicLink` opens the session (`__Host-clavix-session`), marks the e-mail verified, and every
refusal (unknown, spent, expired or stale link) is `MAGIC_LINK_INVALID` (401): offer a new link.
`MAIL_THROTTLED` (429) past 5 requests per address and 10 minutes, and the per-IP and per-tenant
"Sign-in code limits" apply to link requests too (one shared budget). janus 0.57 refuses to enrol a
passkey or second factor while the e-mail is unproved (`EMAIL_UNVERIFIED`), so a link that proves
the e-mail has no squatter's factor to wipe. More in [docs/guide/magic-link.md](docs/guide/magic-link.md).

## E-mail verification

A signed-in user proves their address with a mailed link, on the tenant's `/graphql`
(`https://<slug>.<CLAVIX_DOMAIN>/graphql`). Most sign-ins already prove it (the e-mailed code, the
magic link, an accepted invitation, a social provider that vouches); this is for the account whose
flag is off. The OIDC `email_verified` claim (userinfo and id_token) follows the flag.

```graphql
mutation {
  requestEmailVerification # true
}
mutation {
  confirmEmailVerification(token: "...") {
    id
    email
    emailVerified # true
  }
}
```

- `requestEmailVerification` mails `https://<slug>.<CLAVIX_DOMAIN>/verify?token=<token>` (valid 24
  hours) to the signed-in account's own address. The answer is always `true`: an already verified
  user gets the same answer and no mail. 401 `UNAUTHENTICATED` without a session.
- The hosted `/verify` page must show a button that POSTs the token to `confirmEmailVerification`:
  never confirm on the `GET`, mail scanners open links.
- `confirmEmailVerification` is bound to the signed-in account (no first proof: the password and
  second factor stay, no session is revoked). Every refusal (unknown, spent, expired or stale token,
  or another account's token, which is left unspent for its owner) is `EMAIL_VERIFICATION_INVALID`
  (400): offer a new link. 401 `UNAUTHENTICATED` without a session. A visitor who is not signed in
  signs in first (the code proves the address anyway).
- Both answer `TENANT_SUSPENDED` (403) on a suspended tenant.
- `EMAIL_VERIFICATION_THROTTLED` (429, `retryAfter` in the error and `Retry-After` in seconds) on
  `requestEmailVerification`: per user (10 per hour, `CLAVIX_VERIFY_USER_*`), per client address and
  tenant (20 per 10 min, `CLAVIX_VERIFY_IP_*`), per tenant (200 per hour, `CLAVIX_VERIFY_TENANT_*`),
  then janus's 5 per address and 10 minutes. The first three need `REDIS_URL` (Redis down: let
  through, logged, janus's limit still holds); keys start with the tenant id.

## Passkey sign-in and registration

Passwordless sign-in with a passkey, on the same `/graphql` of the tenant's host (every operation
below goes through the same-origin guard). janus passkeys are the **first factor** here
(`passkeys.firstFactor`, `@softistx/janus-passkeys`): no password and no TOTP. The relying party
is the tenant's own host (`rpIdOf`) and its origin `originOf` (plus the verified custom domains as related origins, ADR-0036), so a passkey belongs to one
tenant for good, and is unknown to every other one. WebAuthn options and responses travel as
**JSON text** (`String`); in the browser, parse the options with
`PublicKeyCredential.parseRequestOptionsFromJSON` / `parseCreationOptionsFromJSON` and send
`JSON.stringify(credential.toJSON())`.

```graphql
type PasskeySignInChallenge {
  options: String!
  challenge: String!
  expiresAt: DateTime!
}
type PasskeyRegistration {
  options: String!
  challenge: String!
  expiresAt: DateTime!
}
type Passkey {
  id: ID!
  name: String!
  transports: [String!]!
  backupEligible: Boolean!
  backedUp: Boolean!
  createdAt: DateTime!
  lastUsedAt: DateTime
}
extend type Query {
  myPasskeys: [Passkey!]!
}
extend type Mutation {
  passkeySignInOptions: PasskeySignInChallenge!
  signInWithPasskey(challenge: String!, response: String!): SignedIn! # sets the cookie
  passkeyRegistrationOptions: PasskeyRegistration!
  registerPasskey(
    challenge: String!
    response: String!
    name: String!
  ): Passkey!
  removePasskey(id: ID!): Boolean!
}
```

- **Sign in** (anonymous): `passkeySignInOptions`, `navigator.credentials.get({ publicKey })`
  (discoverable credential, so no e-mail is asked), then `signInWithPasskey`. The session cookie
  is set as after `verifySignInCode`, and the response is `Cache-Control: no-store`. The challenge
  lasts 5 minutes and is **spent by the first try**, right or wrong: ask for new options. Keep it
  in the hosted page's server session, not in a URL.
- **Register** (signed in, e-mail verified): `passkeyRegistrationOptions`,
  `navigator.credentials.create({ publicKey })`, then `registerPasskey` with a name of 1 to 100
  characters. The registration challenge lasts 5 minutes too, and a new `passkeyRegistrationOptions`
  spends the user's earlier one. Signing in with an e-mailed code verifies the e-mail; a user whose e-mail is not yet
  verified gets `EMAIL_UNVERIFIED` (403; janus 0.57 refuses every factor enrolment while the e-mail is unproved, see
  [troubleshooting](docs/troubleshooting.md)). The session must have signed in within 10 minutes
  (`STEP_UP_REQUIRED`, 403: sign in again with a code). Up to 10 passkeys per user.
- **List and remove**: `myPasskeys` (never the public key or the counter), `removePasskey(id)`
  (`true` when this call removed it, `false` for an id that is not the caller's; same freshness).
  A removed passkey no longer signs in. Registering and removing mail nothing yet.
- **Errors**: `PASSKEY_THROTTLED` (429, `Retry-After`) when `passkeySignInOptions` is over its rate limit
  (below); `PASSKEY_INVALID` (401) for every refusal of `signInWithPasskey`: unknown credential,
  another tenant's passkey, wrong rpId or origin, a user not verified on the device, a wrong user
  handle, an unknown, spent or expired challenge, a malformed response, an inactive user. One
  code and one message: it does not say whether the credential or the user exists. At
  registration, janus's own codes pass through: `PASSKEY_INVALID` (400, the response did not
  verify, the challenge is spent), `PASSKEY_TAKEN` (409), `PASSKEY_LIMIT` (409),
  `EMAIL_UNVERIFIED` (403, also at registration), `STEP_UP_REQUIRED` (403), `TOKEN_*` for a bad challenge.
  `UNAUTHENTICATED` (401) when the operation needs a session and has none.
- **Over http** (development): `http://<slug>.clavix.localhost` tenants have passkeys with their real
  rpId and origin (janus 0.55+ accepts `*.localhost` origins).
- **Rate limit**: `passkeySignInOptions` is anonymous and stores a token per call, so it is limited
  like `requestSignInCode`, with its own buckets and variables: per client IP and tenant
  (60 per 10 min, `CLAVIX_PASSKEY_IP_LIMIT`, `CLAVIX_PASSKEY_IP_WINDOW_SECONDS`) and per tenant
  (600 per hour, `CLAVIX_PASSKEY_TENANT_LIMIT`, `CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS`), whole numbers
  of at least 1. Going over either is `PASSKEY_THROTTLED` (HTTP 429, `Retry-After` in seconds). The
  rules of "Sign-in code limits" apply: `@softistx/redis` GCRA limits keyed by tenant id
  (`clavix:passkey-ip:<tenantId>/<ip>`, `clavix:passkey-tenant:<tenantId>`), the address counted
  first, `CLAVIX_TRUSTED_PROXIES` for the client IP, and no limit without `REDIS_URL`; Redis down or
  slow: the request goes through and a warning is logged.
- **Not yet**: the `amr`/`acr` claims stay unset.

## Same origin on /graphql

The cookie is the credential and a sibling tenant host is same-site (`SameSite=Lax` does not stop it),
so one Yoga plugin (`useSameOriginJson`, `src/http/same-origin.ts`: `sameOrigin()` of `@alxia/graphql` with a 404 for consent operations) guards every `/graphql` request
before anything is parsed or run: a foreign `Origin`, `Origin: null`, or a POST other than
`application/json` (a CORS "simple" form post) is refused, and the answer carries no CORS header. The
`Origin` host is compared with the request host (not the scheme, so it holds behind a TLS-terminating
proxy); a request with no `Origin` (not a browser) passes, since the cookie is `__Host-`.

| Refused operation                                                                                          | Answer                                  |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| consent (`oauthRequest`, `approveOAuthRequest`, `denyOAuthRequest`, `connectedApps`, `revokeConnectedApp`) | HTTP 404, `extensions.code` `NOT_FOUND` |
| any other (`signOut`, `requestSignInCode`, `verifySignInCode`, `currentUser`, ...)                         | HTTP 403, `extensions.code` `FORBIDDEN` |

A request that mixes consent and other root fields gets the 403. A refused request is neither executed nor mailed. Both answers are `{ "errors": [...] }` JSON.

## Shutdown

On `SIGTERM` or `SIGINT` the server finishes the requests in flight, then waits up to 10 seconds for
the sign-in code mails still being handed to the relay (`drain` in `src/modules/auth/outbox.ts`, an
`onStop` hook in `src/server.ts`), so a code is not lost; a mail still in flight after that is dropped
and logged (the visitor asks again).

## Custom domains

A tenant serves sign-in from its own host (`auth.acme.com`). Console operations (tenant `view` to
read, `edit` to change): `domains`, `domain`, `addDomain`, `verifyDomain`, `removeDomain`,
`setPrimaryDomain`.

```graphql
mutation {
  addDomain(tenantId: "...", host: "Auth.Acme.com") {
    id
    host
    status
    txtRecord {
      name
      value
    }
  }
}
# publish: _clavix.auth.acme.com  TXT  <value>
mutation {
  verifyDomain(tenantId: "...", id: "...") {
    domain {
      status
    }
    failure
  }
}
```

- `failure` is `NO_RECORD`, `MISMATCH` or `LOOKUP_FAILED`; a verified domain serves, a pending one
  does nothing. Each claim has its own token, so a record proves one tenant's claim only.
- Pending claims count toward the plan's `domains` quota (`QUOTA_EXCEEDED`); removing one frees it.
- Several tenants may claim a host; the first to verify wins and the other claims are dropped. A
  host another tenant verified is `DOMAIN_TAKEN`. IPs, `localhost`, wildcards and the platform
  domain are refused (`BAD_USER_INPUT`, field `host`).
- A primary is chosen explicitly (`setPrimaryDomain`); it becomes the issuer, so relying parties
  that pinned the old `iss` must be reconfigured. Passkeys keep the slug host as rpId. The primary
  cannot be removed; the slug host keeps serving.
- Every 6 hours the TXT records are read again. Missing for 7 days: the domain becomes
  `UNVERIFIED`, stops serving, gets no certificate, and the owners are e-mailed. A lapsed primary
  keeps its flag (the issuer never moves by itself).
- Automatic TLS: Caddy's `on_demand_tls { ask http://<app>/internal/tls/ask?token=<CLAVIX_TLS_ASK_SECRET> }`
  (Caddy adds `&domain=`). 200 only for a verified domain of a live tenant or a platform host (the apex, `console.`, a live
  tenant's slug host), 429 past the limit, a bare 404 otherwise. Call the app directly (a request carrying `X-Forwarded-*` is refused) and
  keep `/internal/` off the public proxy. Redis down: the limit is skipped.
- `GET /.well-known/webauthn` on the slug host lists the verified domains' origins (WebAuthn Related
  Origins). The passkey layer accepts the same origins: a ceremony run on a verified domain passes, one
  on an unverified or removed domain is refused (the tenant's cache entry drops on verify and remove, which
  rebuilds its janus instance).

## How a host maps to a tenant

A request belongs to the tenant whose slug is the one label before `CLAVIX_DOMAIN`:
`acme.clavix.example` is tenant `acme`, with issuer `https://acme.clavix.example`
(`CLAVIX_PUBLIC_SCHEME`, and `:CLAVIX_PUBLIC_PORT` when set). The host is the URL's, that is
the `Host` header; `X-Forwarded-Host` is ignored. It is lowercased, its port and trailing dot
removed. No tenant (`null`, a 404 for the OAuth endpoints) for an IP, the apex itself, more
than one label before it, a reserved label (`www`, `console`, `api`, ...), an unknown slug, a
tenant whose purge started. A suspended or deleted (trash) tenant resolves with its `status`: sign-in,
`/authorize` and `/token` refuse it with `TENANT_SUSPENDED` (403), while discovery and keys keep answering. A slug is reserved for good: deleting a tenant does not free its slug, and creating a tenant with it fails like any duplicate. In a resolver, `await tenant()` of the context gives
`{ tenantId, slug, issuer, partition, version }`, resolved once per request.

A host that is the **verified custom domain** of a live tenant resolves to that tenant too (see
"Custom domains"); a custom host of a suspended tenant behaves like the slug host. The `issuer`
is the tenant's primary custom domain when it has one, else the slug host.

Resolved hosts are cached in Redis (`tenant-host`, 60 s; 30 s for "no tenant"); creating,
suspending, reactivating or deleting a tenant drops its host (the delete is retried once),
and a resolution that raced a write re-reads the tenant and drops what it just stored. A
suspension therefore takes effect within 60 s at worst, even when Redis was down during the
write. A Redis failure is logged and MongoDB is read, so the API runs, slower, without Redis.

Operating the cache:
- Give Redis a `maxmemory` and an eviction policy (`allkeys-lru`, or `volatile-ttl` since
  every entry carries a TTL), so that the cache cannot grow without bound.
- Null entries are bounded by the valid-slug shape, not by the tenants that exist: a client
  sweeping `<random>.CLAVIX_DOMAIN` writes one 30 s entry per host. Put a rate limit per
  client IP at the edge (reverse proxy or CDN) on the wildcard host.

The Redis spec (`src/tenancy/tenant-cache.spec.ts`) starts a real Redis through
`@softistx/redis/testing`, compiled from source on its first run (about two minutes, then
cached in `node_modules/.cache/redis-memory-server` unless `REDISMS_DOWNLOAD_DIR` is set, which
moves the cache there: CI sets it to a per-runner folder under `~/.cache/nxgt/`, so the path above
is the local default only; needs `make` and a C compiler).
