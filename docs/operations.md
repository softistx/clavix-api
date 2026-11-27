# Operations

Run Clavix on one host with Docker Compose: the API, the UI, MongoDB (a one-node
replica set), Redis and Caddy for TLS. Nothing here is deployed by CI. The files
are `Dockerfile`, `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`,
`scripts/mongo-backup.ts` / `scripts/mongo-restore.ts` (with `scripts/lib/offsite.ts`) and, for the load test, `load/`.

## What runs

> Staging on the shared VPS differs (traefik instead of Caddy, images built on the host): see "Staging".

| Service | Image                                 | Reachable from             | Notes                                            |
| ------- | ------------------------------------- | -------------------------- | ------------------------------------------------ |
| `caddy` | `caddy:2`                             | the internet (80, 443)     | the only published ports; certificates on demand |
| `api`   | `CLAVIX_API_IMAGE` (the `Dockerfile`) | `caddy`, `ui`              | non-root, healthcheck on `/healthz`, port 3000   |
| `ui`    | `CLAVIX_UI_IMAGE` (clavix-ui)         | `caddy`                    | hosted pages, console, landing; port 3001        |
| `mongo` | `mongo:8`                             | `api`, `backup`, `restore` | `--replSet rs0`, key file, users, optional TLS   |
| `redis` | `redis:7-alpine`                      | `api`                      | password, append-only file                       |

Each service has CPU and memory limits in `deploy/compose.yml`
(`deploy.resources.limits`): api 1 CPU / 1 GB, ui 1 / 768 MB (it needs about 2 minutes and ~425 MiB to boot, so its healthcheck waits 120 s), mongo 1 / 1 GB
(WiredTiger cache 0.25 GB, set in `deploy/mongo/entrypoint.sh`), redis
0.25 / 256 MB, caddy 0.5 / 256 MB, backup and restore 0.5 / 512 MB. After a
deploy, `docker stats --no-stream` shows whether one runs at its limit; raise
that one only. Healthchecks run every 30 s and start no Bun or `mongosh`
process: bash requests `/healthz` (api, ui), and mongo checks a file and a TCP
connection.

Caddy sends the authorization server (`/authorize`, `/token`, `/par`, `/device_authorization`, ...), the GraphQL APIs, JWKS, userinfo, the logo
and `/healthz` to the API (a proxy of your own must route `/device_authorization` too), and everything else to the UI. The tenant is chosen
by the `Host` header, which Caddy passes untouched.

The edge strips `x-sso-connection` from every request it forwards to the API (Caddy `header_up -X-Sso-Connection`, the traefik
`clavix-api-strip` middleware). Only the UI sets that header, on the private network (`clavix-api:3000`), to bind an enterprise
connection's callback to the route that received it; a public client could otherwise send it together with a callback URL.

## Health

- `GET /healthz` is liveness: 200 `{ status, version }`, no dependency is
  touched. The image's `HEALTHCHECK` and an uptime monitor use it.
- `GET /readyz` is readiness: Mongo `ping` and Redis `PING` within 2 s each.
  200 `{ status: "ok", checks }`, or 503 `{ status: "unavailable", checks }`
  naming the dependency that is `down`, without the error text (the logs have
  it). Caddy answers 404 to `/readyz` from outside: probe it from the private
  network (`docker compose exec api bun -e "..."`, or a load balancer in front of
  `api`).

## First boot

1. A host with Docker Engine 25 or later and Compose v2.20 or later (the healthchecks use `start_interval`), DNS `A`/`AAAA` records for `<domain>` and
   `*.<domain>` (so `console.<domain>` and every `<slug>.<domain>` resolve), and
   ports 80 and 443 open.
2. Build and publish the images yourself. Both repositories build with their
   `Dockerfile`; `@softistx/*` comes from npmjs with a read token, passed as the BuildKit secret `npm_read` from `NPM_SOFTISTX_READ_TOKEN` (never baked in; unset is fine while the packages are public, plugins#233):

   ```sh
   docker build -t registry.example.com/clavix-api:0.1.0 .
   ```

3. `cp deploy/.env.example deploy/.env` and fill it (never commit it). Generate
   the secrets: `openssl rand -base64 32` for `CLAVIX_KEYS_MASTER_KEY`,
   `openssl rand -hex 32` for `CLAVIX_TLS_ASK_SECRET`, `openssl rand -hex 24` for
   `REDIS_PASSWORD`, `MONGO_ROOT_PASSWORD` and `MONGO_APP_PASSWORD`,
   `openssl rand -hex 64` for `MONGO_KEYFILE`, `openssl rand -base64 48` for
   `CONSOLE_SESSION_SECRET`.
   `CONSOLE_CLIENT_SECRET` stays a placeholder until step 5.
4. **Master key custody.** `CLAVIX_KEYS_MASTER_KEY` encrypts every tenant's
   signing keys and social secrets. Store it in a secret manager apart from the
   database and from the backups. Losing it makes the stored keys unreadable
   (see "Signing keys" below).
5. Start the data services, then run the deployment steps once:

   ```sh
   alias dc='docker compose -f deploy/compose.yml --env-file deploy/.env'
   dc up -d mongo redis
   dc run --rm api bun run db:sync       # collections, indexes, validators (the clients `source` index of `countClients` included)
   dc run --rm api bun run db:migrate    # prints the console client secret once: save it
   ```

   Run it with `CLAVIX_PUBLIC_SCHEME=https` (the default): the console client's redirect URI must be
   https, so `db:migrate` fails under `http`, which only a local stack uses.

   Put that secret in `deploy/.env` as `CONSOLE_CLIENT_SECRET` (the example holds
   the placeholder `pending-db-migrate`). Lost? Mint another:
   `dc run --rm api bun run clients:create --tenant clavix --name Console --client-id console --confidential --redirect-uri https://console.<domain>/console/auth/callback --rotate-secret`
   (the redirect URI is required, and a re-run replaces the stored ones).
   Then start everything:

   ```sh
   dc up -d
   ```

   `compose.yml` requires both console variables on the `ui` (`:?`: an empty or
   missing value is an error). Compose checks every service when it reads the
   file, so a missing value fails **every** `dc` command, `dc up -d mongo redis`
   included, not only the `ui`. That is why `.env.example` ships a non-empty
   placeholder for the client secret and step 3 fills `CONSOLE_SESSION_SECRET`:
   the data services start first, and the `ui` starts last with the real secret.
   Starting the `ui` while the placeholder is still there starts it with a
   wrong client secret.

6. Name the first operator (the console needs a platform role before anyone can
   use it). A fresh `clavix` tenant is invitation-only and has no user, so
   invite the first one with `--create`:

   ```sh
   dc run --rm api bun run operators:grant --email you@example.com --create
   ```

   It mails an invitation link (from the `clavix` tenant, through the mail
   settings of step 3); opening it makes the account and grants the `owner`
   platform role (`--role admin|viewer` for a weaker one). Re-running resends
   the invitation, and for an address that already has an account it grants the
   role directly, unless that account is disabled (the command refuses it; enable the user first). Every run is recorded as the admin event `operator.grant`.
   See the README, "Console API".
7. Check: `curl https://console.<domain>/healthz` answers 200 and
   `dc exec api bun -e "console.log((await fetch('http://127.0.0.1:3000/readyz')).status)"`
   prints 200.

## Environment

The variables of the API are in the README ("Environment") and `.env.example`.
Beyond them, the deployment reads, in `deploy/.env`:

| Variable                                                                 | Read by                     | Meaning                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAVIX_API_IMAGE`, `CLAVIX_UI_IMAGE`                                    | compose                     | the images to run                                                                                                                                              |
| `CLAVIX_DOMAIN`                                                          | api, ui, caddy              | the apex; tenants live at `<slug>.<domain>`                                                                                                                    |
| `ACME_EMAIL`                                                             | caddy                       | the ACME account address                                                                                                                                       |
| `REDIS_PASSWORD`                                                         | redis, api                  | the password in `REDIS_URL`                                                                                                                                    |
| `MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD`                                 | mongo                       | the server's root user (default `root`), created on the first start; used only by the mongo container to initiate the replica set at start-up                  |
| `MONGO_APP_USER`, `MONGO_APP_PASSWORD`                                   | mongo, api, backup, restore | the application user (default `clavix`), `readWrite` and `dbAdmin` on the `clavix` database; its credentials are in `MONGO_URI`                                |
| `MONGO_KEYFILE`                                                          | mongo                       | the replica set's internal authentication key, 6 to 1024 characters                                                                                            |
| `MONGO_TLS_DIR`, `MONGO_URI_OPTIONS`                                     | mongo, api, backup, restore | optional TLS, see "MongoDB"                                                                                                                                    |
| `CLAVIX_KEYS_MASTER_KEY`, `CLAVIX_SMTP_URL`                              | api                         | required in production                                                                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`              | api                         | optional: where traces and logs go, see "Telemetry"                                                                                                            |
| `CLAVIX_TLS_ASK_SECRET`                                                  | api, caddy                  | the token of the `ask` URL, 32 characters or more                                                                                                              |
| `CONSOLE_CLIENT_SECRET`                                                  | ui                          | required for the console: the secret of the `console` OAuth client, from `db:migrate` or `clients:create --client-id console`                                  |
| `CONSOLE_SESSION_SECRET`                                                 | ui                          | required for the console: signs the session cookie, 32 characters or more (`openssl rand -base64 48`)                                                          |
| `CONSOLE_ISSUER`                                                         | ui                          | ui, optional: the console's issuer, default `https://clavix.<CLAVIX_DOMAIN>`; it must equal the API's `iss` exactly (see below)                                |
| `CONTACT_EMAIL`                                                          | ui                          | the public contact address                                                                                                                                     |
| `BACKUP_DIR`, `BACKUP_KEEP`                                              | backup                      | archive folder on the host (default `backups/` at the repository root; a relative value is relative to `deploy/`, prefer an absolute path), archives kept (14) |
| `BACKUP_OFFSITE_S3_BUCKET`                                               | backup, restore             | opt-in off-host copy: the bucket. Empty = no copy. See "Off-host copies"                                                                                       |
| `BACKUP_OFFSITE_S3_ENDPOINT`, `BACKUP_OFFSITE_S3_REGION`                 | backup, restore             | the S3-compatible service (`https://...`; empty = AWS) and its region                                                                                          |
| `BACKUP_OFFSITE_S3_ACCESS_KEY_ID`, `BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY` | backup, restore             | the credentials; required with a bucket. Give the backup a key that may write, list and delete under the prefix only                                           |
| `BACKUP_OFFSITE_S3_PREFIX`                                               | backup, restore             | key prefix of the objects (default `clavix-backups`)                                                                                                           |
| `BACKUP_OFFSITE_KEEP_DAYS`                                               | backup                      | remote retention in days (default 30)                                                                                                                          |

The GraphQL IDE (Apollo Sandbox) and the introspection of the hosted `/graphql` are off in production:
`CLAVIX_GRAPHQL_IDE` is `false` there and the API refuses to start with `true`. Leave it out of `deploy/.env`.
A browser that opens `https://<tenant host>/graphql` gets no page, and a `__schema` or `__type` query is
refused; the hosted pages and the OAuth clients are unaffected. The schema is in the repository
(`src/modules/**/*.graphqls`); to explore it, run the API locally with `bun dev`.

The device grant's code-lookup limits (`CLAVIX_DEVICE_USER_LIMIT`, `CLAVIX_DEVICE_IP_LIMIT`,
`CLAVIX_DEVICE_TENANT_LIMIT` and their `_WINDOW_SECONDS`, defaults in the README) are read by the API and kept in
Redis; with Redis down the lookups go through unthrottled and a line is logged.

The anonymous SSO start and home-realm lookup limits (`CLAVIX_SSO_IP_LIMIT`, `CLAVIX_SSO_IP_WINDOW_SECONDS`,
`CLAVIX_SSO_TENANT_LIMIT`, `CLAVIX_SSO_TENANT_WINDOW_SECONDS`) and the console's test-webhook
(`CLAVIX_WEBHOOK_TEST_*`) and invitation (`CLAVIX_INVITE_*`, except `CLAVIX_INVITE_PENDING_LIMIT`) budgets are read by the API and kept in Redis too, defaults
in the README. With Redis down they let the call through and log a line. The pending-invitation cap and the 60 s invite cooldown read the stored invitations, so they hold without Redis.

Compose builds `MONGO_URI` and `REDIS_URL` from the variables above, and sets `CLAVIX_TRUSTED_PROXIES=1` (Caddy is the
one proxy) and `API_URL` itself; do not put them in the file. `deploy/.env` is
ignored by git. Compose hands the whole file to `api` only (so it also holds the two
console variables, which it does not read); the `ui` gets just `CLAVIX_DOMAIN`,
`CONTACT_EMAIL` and the two console variables, so it never sees the master key or the
ask secret.

### The console's issuer

The console signs in against the `clavix` tenant's issuer,
`https://clavix.<CLAVIX_DOMAIN>`, and the ui fetches that issuer's discovery
document through the public host. From inside the `ui` container the name must
therefore resolve and reach Caddy: public DNS works when the host can reach its
own public address (hairpin NAT); some providers do not allow it.

The API builds a tenant's `iss` from the tenant (`issuerOf`, or `issuerOfHost`
for a custom primary host), `CLAVIX_DOMAIN` and the public scheme, never from
its own address. So a request to `http://api:3000` carrying
`Host: clavix.<domain>` would receive the same `iss`; the ui cannot
fetch from one URL and validate against another.

`CONSOLE_ISSUER` (ui, optional) replaces the default
`https://clavix.<CLAVIX_DOMAIN>`. The ui uses that one string twice: as the base
of `/.well-known/openid-configuration` and as the `issuer` the discovery document
and the ID token must name (a mismatch fails with `issuer-mismatch`, and the
endpoints must be `https`, `http` only on loopback). So it must be byte-for-byte the API's `iss` (the
public scheme, the tenant host and `CLAVIX_DOMAIN`). An internal URL such as
`http://api:3000` does **not** work: discovery would be fetched there but would
name the public `iss`, and the ui would refuse it. Set it only when the public
issuer differs from the default (a custom primary host for the `clavix` tenant).
To reach the issuer from inside the compose network, keep the public name and
make it resolve (hairpin NAT or the alias below). The surest fix without hairpin NAT is a network alias on `caddy`, so the
public names resolve to Caddy on the compose network and keep the real
certificate:

```yaml
caddy:
  networks:
    default:
      aliases: ["clavix.${CLAVIX_DOMAIN}", "console.${CLAVIX_DOMAIN}"]
```

## MongoDB

The database is authenticated. `deploy/mongo/entrypoint.sh` starts `mongod` with
`--replSet rs0` and `--keyFile` (written from `MONGO_KEYFILE`, which also turns
authorization on). On the first start of an empty volume the image creates the
root user from `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD`, then
`deploy/mongo/init-app-user.js` creates the application user in the `clavix`
database with `readWrite` and `dbAdmin` on it (`db:sync` applies validators and indexes), nothing on any other database. The api, `backup` and `restore`
connect as that user (`authSource=clavix`); only the start-up initiator in
`entrypoint.sh`, which initiates the replica set and marks it ready for the
light healthcheck (a file and a TCP connection, no `mongosh` per check), uses root, and the api container's environment blanks the
root and key file variables it would otherwise inherit from `deploy/.env`.
Use hex passwords (`openssl rand -hex 24`): they are put in a URI unescaped.
The restore drill (`restore ... clavix-drill`) writes to another database, which
the application user cannot: run it with a root URI
(`mongodb://root:<MONGO_ROOT_PASSWORD>@mongo:27017/clavix-drill?replicaSet=rs0&authSource=admin`,
followed by `MONGO_URI_OPTIONS` when TLS is on), passed to the run:
`docker compose ... --profile tools run --rm -e MONGO_URI=<that URI> restore <file>`.

The users are created by an empty volume's first start only. **An existing
deployment** (data, no users) keeps its volume: start `mongo` once with the old
command (`--replSet rs0 --bind_ip_all --wiredTigerCacheSizeGB 1`, no key file) to create them, e.g. with `mongosh` inside the container
(`use admin; db.createUser({user: "root", pwd: "...", roles: ["root"]})`,
`use clavix; db.createUser({user: "clavix", pwd: "...", roles: [{role: "readWrite", db: "clavix"}, {role: "dbAdmin", db: "clavix"}]})`),
then switch to this file (the key file turns authorization on).

**TLS between the containers is optional.** `deploy/tls/` (or `MONGO_TLS_DIR`,
ignored by git) has two folders: `server/` with `mongo.pem` (the certificate and
its key, SAN `mongo`) and `ca.pem`, mounted into `mongo` only, and `ca/` with
`ca.pem` alone, mounted into the api, `backup` and `restore`, so no private key
reaches them. Set `MONGO_URI_OPTIONS=&tls=true&tlsCAFile=/etc/mongo-tls-ca/ca.pem`
in `deploy/.env`. Without `server/mongo.pem` the server starts without TLS.
`mongod` reads its files as user `mongodb` (uid 999): `chmod 640` and
`chown :999 server/mongo.pem` (or 644 on a host you alone use). A self-signed pair:

```sh
cd deploy/tls   # keep ca.key here, outside the mounted folders
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -subj "/CN=clavix-mongo-ca" -keyout ca.key -out ca.pem
openssl req -newkey rsa:4096 -nodes -subj "/CN=mongo" -addext "subjectAltName=DNS:mongo" -keyout mongo.key -out mongo.csr
printf 'subjectAltName=DNS:mongo' > ext.cnf
openssl x509 -req -in mongo.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -extfile ext.cnf -out mongo.crt
cat mongo.crt mongo.key > server/mongo.pem && cp ca.pem server/ca.pem && cp ca.pem ca/ca.pem
chmod 644 server/mongo.pem; rm mongo.key mongo.csr mongo.crt ext.cnf
```

## Redis

Redis starts with `--maxmemory 192mb --maxmemory-policy noeviction` (below its 256M limit; it never evicts, since locks, rate limits and queue dedup keys must survive: at 192 MB writes fail, which the API treats as a Redis failure, and `docker stats` shows when to raise the limit) and `--requirepass "$REDIS_PASSWORD"` (read from the environment, so
it is not in the process list), the healthcheck authenticates with
`REDISCLI_AUTH`, and the api's `REDIS_URL` is `redis://:<REDIS_PASSWORD>@redis:6379`.
Redis is on the private network only; use a hex password (it sits in a URL).

## Device flow throttle

The device grant's code lookups (the verification page's `oauthDeviceRequest`, `approveOAuthDeviceRequest` and
`denyOAuthDeviceRequest`) are limited in Redis by three buckets. Each bucket starts full at its limit and refills
evenly over its window, so a burst up to the limit is allowed at once, then the rate of the window.

| Variable (`CLAVIX_DEVICE_…`)             | Default    | Counts lookups per        |
| ---------------------------------------- | ---------- | ------------------------- |
| `USER_LIMIT` / `USER_WINDOW_SECONDS`     | 20 / 600   | signed-in user            |
| `IP_LIMIT` / `IP_WINDOW_SECONDS`         | 30 / 600   | client address and tenant |
| `TENANT_LIMIT` / `TENANT_WINDOW_SECONDS` | 300 / 3600 | tenant                    |

Each value is an integer of at least 1 (`src/config/env/limits.ts`). A lookup counts whether or not the code exists: the
throttle runs before the store is read. Past a limit, the lookup fails with `DEVICE_CODE_THROTTLED` (HTTP 429,
`Retry-After`).

**Sizing.** An approval makes two lookups: one to read the request and one to approve it. The tenant bucket of
300 per hour therefore allows about 150 approvals an hour, and only if nothing else spends it. A denial counts as a
lookup too, and so does every mistyped code. The user and address buckets bind first for one person or one office:
20 lookups per 10 minutes is 10 approvals per user, and 30 per 10 minutes per address is 15 approvals per office
address. A tenant that approves more than about 150 requests an hour needs a higher `CLAVIX_DEVICE_TENANT_LIMIT`
(and, for shared addresses, `CLAVIX_DEVICE_IP_LIMIT`).

**Redis down or slow.** The throttle fails open: the lookups go through unthrottled, and each skipped limit is
logged (`redis unavailable: device code limits skipped`). Each Redis call waits at most 250 ms. Without Redis
configured there is no device throttle at all. The fix is Redis, not the limits.

**Raising a limit.** Set the variable in `deploy/.env` (it is read by `api` only), then restart the api so it reads
the value: `dc up -d api`. Keep the window and the limit in proportion: doubling the tenant limit doubles the
approvals an hour allowed.

## Agent registration throttle

A tenant that turns agents on (`agents.dynamic` `restricted` or `open`, [MCP guide](guide/mcp.md)) serves an anonymous
`POST /register`. Each call stores a client, so it is limited in Redis by two buckets (same GCRA buckets as the device
throttle: full at the limit, refilling evenly over the window).

| Variable (`CLAVIX_REGISTER_…`)           | Default    | Counts calls per          |
| ---------------------------------------- | ---------- | ------------------------- |
| `IP_LIMIT` / `IP_WINDOW_SECONDS`         | 20 / 3600  | client address and tenant |
| `TENANT_LIMIT` / `TENANT_WINDOW_SECONDS` | 500 / 3600 | tenant                    |

Past a limit `/register` answers 429 `temporarily_unavailable` with `Retry-After`. The address is checked first, so a
refused address spends no tenant budget. A tenant with policy off answers 400 before any bucket is spent.

**Sizing.** 20 per hour per address fits one person connecting a few MCP clients; an office behind one address that
onboards many agents at once needs a higher `CLAVIX_REGISTER_IP_LIMIT`. The `agents` quota (free 100, pro 1000,
enterprise unlimited, overridable per tenant) bounds what is stored whatever the throttle lets through; the tenant
bucket only bounds the rate. **Redis down or slow:** the throttle fails open and logs it; the quota still holds.
Without Redis there is no `/register` throttle.

**Before the deploy.** Run `db:sync` first: it creates the `agentClients` collection and its indexes, and the tenants
validator that knows `oauth.agents` and the `agents` quota override. The Caddyfile `@api` matcher gains `/register`;
reload Caddy with the new file, or the path never reaches the api.

**Metadata documents.** Fetching a Client ID Metadata Document is an outbound request on `/authorize` and `/par`,
limited by its own pair of buckets (tenants with `metadataDocuments` on only). Only the MCP hosts and the tenant's
`allowHosts` are fetched.

**Metadata documents: what pins the fetch, and what is left.** The fetch is janus-oauth's own (`createClientMetadataFetcher`,
no transport of ours): the host is resolved once, every address must be public unicast (loopback, private, link-local,
unique-local, multicast and the other non-public ranges, v4 and v6, are refused, a host written as an IP literal is checked the same way, and local-use names are refused), and
the connection goes to one of those checked addresses with the name kept for SNI, the certificate and `Host`. The name is
not resolved a second time, so a host that answers with a public address for the check and a private one for the
connection (DNS rebinding) is not reached. A redirect is refused, the port is 443, the body is capped (5 KB) and the whole
fetch is timed (3 s). A wildcard `allowHosts` entry over a public suffix (`*.co.uk`, `*.github.io`) is refused in the
console and ignored if it was stored before.

Residual risks, none of them closed by code here:
- The check trusts the host's system resolver. A poisoned or hostile resolver can choose which public address a name gets;
  it cannot make the fetch reach a private one.
- Public means "not in the ranges janus-oauth lists". A range reserved later is allowed until janus-oauth lists it
  (bump `@softistx/janus-oauth`).
- An allowed host serves what it likes within the 5 KB cap: allow only hosts the tenant trusts, and prefer exact names to
  a wildcard.
- For defence in depth the API's network egress should itself refuse the private, loopback and link-local ranges (and the
  cloud metadata address `169.254.169.254`), so one missed range is still not reachable.

| Variable (`CLAVIX_METADATA_…`)           | Default  | Counts requests per       |
| ---------------------------------------- | -------- | ------------------------- |
| `IP_LIMIT` / `IP_WINDOW_SECONDS`         | 30 / 60  | client address and tenant |
| `TENANT_LIMIT` / `TENANT_WINDOW_SECONDS` | 300 / 60 | tenant                    |

Past a limit the request answers 429 `temporarily_unavailable` with `Retry-After`; nothing is fetched. A client not
recorded yet is also refused with 403 `access_denied` when the tenant is at its `agents` quota. Redis down: fails
open and logs; without Redis there is no limit.

## Agents clean-up

The queue `agents-prune` (daily, 03:41 UTC, 3 attempts) deletes the agents (dynamic and metadata-document) of active tenants
that hold no standing grant: 7 days after they were recorded, or 24 hours when they never got a grant (never used, so a burst
of registrations frees the `agents` quota the next day) ([MCP guide](guide/mcp.md#the-daily-clean-up)). It
needs Redis (`REDIS_URL`): without it nothing runs, and there is no pass at start. A tick that leaves an agent
unfinished fails and the queue retries it; each agent is its own step, so one failure does not stop the others. The
logs say `agents: could not prune <client> of <tenant>` for each failure. Every deletion is the admin event
`agent.prune` (actor `system:agents:prune`); to check the job ran, look for that event or for the absence of old
`DYNAMIC` agents in `clients(kind: [DYNAMIC])`. Two instances running the same tick do no harm (deleting is idempotent).

## Audit retention

The queue `audit-retention` (daily, 04:17 UTC, 3 attempts) cuts every tenant's sign-in log (`authEvents`) and
console activity (`adminEvents`) at the retention of its current plan (`Plan.auditRetentionDays`: free 30
days, pro 90, enterprise 365), and the platform's own events (`tenantId: null`) at 400 days. Tenants in the
trash or already purged are covered too, so a purged tenant's console activity ends with its retention. It
needs Redis (`REDIS_URL`): without it nothing runs. A tick that leaves a tenant unfinished fails and the
queue retries it; the logs say `audit: retention failed for <tenant> (...)`. It deletes in batches of
1,000 and writes no event per deletion (actor `system:audit:retention`). A plan change applies at the next run.


## Grant revocation retries

When a social sign-in replaces an unverified holder and revoking their OAuth grants fails, the revocation is
queued (`grants-revoke`, Redis) and the sign-in succeeds. The job retries up to 8 times, backing off from 1 minute
doubling to 1 hour. Without `REDIS_URL`, or when the job cannot be stored, the sign-in fails instead. Watch the logs
`grants: revocation queued after a failure`, `grants: revocation not queued` and `grants: no OAuth server for <slug>`
(check `CLAVIX_PUBLIC_SCHEME`, `CLAVIX_DOMAIN`, `CLAVIX_PUBLIC_PORT`). A job that exhausts its attempts stays in the
failed set for 30 days and the user's grants stay live: revoke them from the console (connected apps).

## Erase of a replaced holder

When a social sign-in replaces an unverified holder, the former holder's attribute values and picture are erased by
the `erase-replaced` queue (Redis, `{ tenantId, userId }`), right after the grants revocation. The job is idempotent and
retries up to 8 times, backing off from 1 minute to 1 hour. Without `REDIS_URL`, the erase runs inline; when the job
cannot be stored, or the inline erase fails, the sign-in fails. Watch the logs `erase-replaced: <error>` and
`sign-in: the erase of the replaced holder was not queued`. A job that exhausts its attempts stays in the failed set for
30 days and leaves the former holder's values and picture in place: erase them from the console. A retry that comes
minutes later may erase values the new holder set meanwhile (accepted, see AGENTS.md).

## Profile pictures

Users' pictures are objects of one private S3-compatible bucket (`CLAVIX_MEDIA_S3_*`, required in production),
under `<tenantId>/avatar/<uuid>`; the bucket is never opened to browsers. The api serves them: `PUT /media/avatar`
writes (PNG, JPEG or WebP, 1 MiB at most, throttled by `CLAVIX_AVATAR_*`, Redis only) and `GET /media/avatar/<uuid>`
reads publicly with an immutable cache. Route `/media/*` to the api (the Caddyfile `@api` matcher and the Traefik
rule carry it). Without the bucket settings outside production the routes answer 503.
Erasing a user removes their object and purging a tenant removes its `<tenantId>/` prefix. Replacing or removing a
picture deletes the former object after the janus event; a rare orphan stays until the tenant is purged.
Back the bucket up with the storage's own tools; the database backups do not hold the pictures.

## Webhooks

A tenant's events are posted to its endpoints (`https` only, public addresses only, checked when saved and
on every send; redirects are not followed). With `REDIS_URL` the delivery queue is Redis
(`clavix:webhooks:*`), so what waits survives a restart and runs on any instance; without it the queue is in
memory and a restart loses what waits. A delivery is retried on the Standard Webhooks schedule, 10 s timeout,
2xx only. An endpoint that fails 5 deliveries in a row is switched off, its tenant's owners are e-mailed and
the console records `webhook.disable` (actor `system:webhooks:disable`); an admin switches it on again.

Every request attempt is logged in `webhookDeliveries` (event id and type, attempt rank, response status or the
failure's name, duration, whether it was delivered or will be retried; never the URL, a header or a body):
the newest 100 per endpoint, dropped after 7 days by a TTL index on `at` (`bun run db:sync` creates it).
`WebhookEndpoint.deliveries(first:)` in the console API reads them, newest first; deleting an endpoint deletes
its attempts, and a tenant purge empties them.

| Variable                        | Meaning                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CLAVIX_WEBHOOKS_ALLOW_PRIVATE` | `true` lets endpoints reach private and loopback addresses (a local receiver). Refused at boot in production.    |
| `CLAVIX_WEBHOOKS_MAX_IN_FLIGHT` | requests in flight at once per tenant, all instances together; default 4.                                        |
| `CLAVIX_WEBHOOKS_MAX_PENDING`   | deliveries one tenant may hold (waiting, claimed or waiting for a retry); default 5000. The next one is refused. |

**Caps per tenant (G2-03).** The queue names an endpoint `<tenantId>.<endpointId>` and groups by the tenant, so
both caps count per tenant, not per endpoint (janus-webhooks counts per group once `groupOf` is set): a tenant
whose endpoint floods or answers slowly holds at most `CLAVIX_WEBHOOKS_MAX_IN_FLIGHT` requests, and a claim skips
it for the other tenants' endpoints; claims also start from another endpoint in turn. A delivery refused by
`CLAVIX_WEBHOOKS_MAX_PENDING` is not queued and never retried: the log has one line,
`webhooks: delivery <id> refused, tenant <tenantId> holds <n>`, with ids only. Size it well above what a healthy
tenant holds: a dead endpoint keeps about 28 hours of its events in retry. Both caps apply to the in-memory queue
too (no `REDIS_URL`).

**Upgrading to the capped queue.**
- Run janus-webhooks-redis 0.13 or later on **every** instance before setting a cap, and the same values on all
  of them: an older instance claims without counting, so the cap is exceeded by what it claims. Roll the
  instances in one go.
- A running deployment must drain the webhook queue before this upgrade: queue entries now name their endpoint
  `<tenantId>.<endpointId>`, so deliveries waiting under the old bare names would be given up as `endpointRemoved`.
- **Redis ACL.** A Redis user restricted by ACL needs `+@scripting` and the commands the queue scripts run:
  `HSET HGET HGETALL HINCRBY EXISTS DEL ZADD ZREM ZRANGEBYSCORE ZREMRANGEBYSCORE ZCARD SADD SREM SISMEMBER
  SMEMBERS HDEL GET SET` on `~clavix:webhooks:*`. Version 0.13 needs the new ones: `ZREMRANGEBYSCORE` (with the
  in-flight cap), `HDEL` (with `groupOf`, which Clavix always sets) and `GET`/`SET` (the orphan claim). Grant them
  **before** upgrading: without `GET`, those claims fail with `STORE_FAILED` (`NOPERM`). The compose Redis uses
  the default user with `requirepass` and needs nothing.

Endpoint secrets (`whsec_...`) are sealed in MongoDB with a subkey of `CLAVIX_KEYS_MASTER_KEY` (label
`webhook-secrets`); losing the key leaves endpoints with no way to sign, and they are skipped, never sent
unsigned. The queue `webhook-secrets-prune` (daily, 04:37 UTC) removes rolled secrets whose 24 hours are over.
A master-key rotation seals them again (`bun run keys:reseal`, "Rotating the master key" below).

Enterprise connection client secrets are sealed with another subkey of `CLAVIX_KEYS_MASTER_KEY` (label
`connection-secrets`); losing the key makes them unreadable and those sign-ins fail until an admin sets the
secret again; a master-key rotation seals them again (`bun run keys:reseal`). A connection's domain is proved by a TXT record `_clavix-sso.<domain>` holding the token the
console shows; verification reads DNS at most once a minute per connection. Each connection has its own redirect URI,
`https://<tenant host>/sign-in/social/<connection id>/callback` (the console's `Connection.redirectUri`): register that URL (and only that one) with the
customer's identity provider. The earlier shared `/sign-in/sso/callback` is no longer used.

A receiver verifies the Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`,
HMAC-SHA256 over `id.timestamp.body`, every `v1,` signature of the header is tried during a roll) and dedupes
on `webhook-id` (delivery is at least once). The body is `{ "type", "timestamp", "data" }`; `data` holds
`tenantId` and ids only (`userId`, `userType`, `provider` on the social events), never an address or an e-mail.

## Telemetry

Traces and logs go to an OpenTelemetry collector over OTLP/HTTP, through `@softistx/telemetry` (no OpenTelemetry SDK).

| Variable                      | Meaning                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector's base URL (`/v1/traces` and `/v1/logs` are appended). Unset (or empty): nothing is exported and nothing is sent |
| `OTEL_EXPORTER_OTLP_HEADERS`  | optional, `key=value` pairs separated by commas, sent on every export (an API key)                                             |

Both are read from `deploy/.env` like the others (compose hands the file to `api`).
- **What is traced.** One server span per request (`@softistx/alxia-telemetry`, named `POST /graphql` or `query <Name>`; `/healthz`, `/readyz`
  and `/internal/*` are skipped), a span per sign-in, passkey, session and invitation flow with its security events as logs
  (`@softistx/janus-telemetry`, `janus.signIn`, `janus.signIn.refused`, `janus.signIn.throttled`, ...), and a client span per MongoDB
  command (`@softistx/telemetry-mongo`), and a span per OAuth endpoint of each issuer (`oauth.authorize`, `oauth.token`, `oauth.par`,
  `oauth.introspect`, `oauth.revoke`, `oauth.device`, `oauth.register`; `instrumentOAuth`). A refused client authentication is an
  `oauth.client.refused` warning inside its span, a refused DPoP proof an `oauth.dpop.refused` one. The MongoDB command monitoring is switched on only when an endpoint is set.
- **Attributes.** `clavix.tenant.id` and `clavix.tenant.plan` are on the server span and, inherited, on every span and log under
  it, once the request's host names a tenant. The OAuth spans add `oauth.client.id`, `oauth.grant_type`, `oauth.resource`, `oauth.dpop`,
  `oauth.par` and, for a refusal, `oauth.error` (the OAuth error code); they carry the tenant's attributes themselves.
- **Never written:** tokens, codes, secrets, e-mail addresses, logins or IPs. The server span is built with `clientAddress: false`, so it
  carries no `client.address`.
- **Sampling.** In production 10 % of traces are kept (decided once per trace, at its root); elsewhere all. Logs are never sampled.
- **Stopping.** The server awaits `telemetry.close()` after the HTTP server drained, so the last batch is shipped.
- **Check it.** With the endpoint set, `bun run start` and one `POST /graphql` give a trace in the collector within a second or two;
  an export failure is logged to stderr and never fails a request.

## TLS

> Staging terminates TLS in traefik, with a wildcard certificate and no on-demand TLS: see "Staging".

Plain HTTP on port 80 is redirected to HTTPS (`http:// { redir ... }` in the
Caddyfile). Caddy's automatic HTTPS adds that redirect only for host names
written in the config, and the catch-all site names none, so it is explicit;
ACME HTTP-01 challenges are answered before any route and are not affected.

Caddy gets a certificate for a host the first time it is asked for, but only
after it asks the API: `GET http://api:3000/internal/tls/ask?token=...&domain=<host>`.
The answer is 200 for
- a verified custom domain of a live tenant,
- the apex, `console.<domain>`, and `<slug>.<domain>` of a live tenant,

and a bare 404 for everything else (an unknown, pending, lapsed or suspended
domain, a deleted tenant, a wrong token); 429 once `CLAVIX_TLS_ASK_LIMIT`
asks a minute were answered 200 (the host is looked up first: an ask for an
unknown name is a 404 that spends nothing, so a flood of random names sent to
your IP cannot make a real domain wait). So a stranger pointing a name at your IP gets no certificate.

**The endpoint is not reachable from outside**, three ways at once:
the API publishes no port, so only `caddy` and `ui` reach it on the compose
network; the Caddyfile answers 404 to `/internal/*` before any proxying; and the
endpoint itself refuses any request carrying `X-Forwarded-For`, `X-Forwarded-Host`
or `Forwarded` (everything Caddy proxies has them) and any request without the
secret token.

Let's Encrypt limits new certificates to 50 a week per registered domain, and a
slug host is one certificate each. Past a few dozen tenants, switch the slug
hosts to one wildcard certificate (DNS-01, a Caddy built with your DNS
provider's module): the commented block at the end of `deploy/Caddyfile` shows
it. Custom domains stay on demand.

## Upgrade

> Staging redeploys with `bun deploy/deploy.ts` (it builds, there is no `dc pull`): see "Staging".
1. Build and tag the new images; set the new tags in `deploy/.env`.
2. Take a backup first (below).
3. `dc pull` (or load the images), then
   `dc run --rm api bun run db:sync && dc run --rm api bun run db:migrate`.
   Read the release notes: a migration may change data.
   `db:sync` runs `syncMongoOAuthPartitioned`, which janus-oauth-mongo 0.12
   needs before the new code serves requests (it replaces the validator that
   rejects a grant with `bound`, and creates the `bound` and `clientId` indexes).
   Skipped, approving a bound grant fails with `Document failed validation`
   (code 121, `STORE_FAILED`).
   janus-oauth-mongo 0.13 needs it again: it widens the clients validator
   (the device grant type) and adds the device-authorization indexes.
   janus-oauth 0.13 enforces a client's `grantTypes` (`unauthorized_client`
   on `/authorize`, the code exchange and the refresh grant) and takes an
   explicit list as written. `db:migrate` runs the migration
   `2026-11-15-client-grants`, janus-oauth's two `updateMany` steps on
   `oauthClients` then `oauthPartitionedClients`, in that order: a stored list
   that holds neither `authorization_code` nor the device grant (`[]`,
   `['refresh_token']`) gets both default grants, then an explicit list that
   lacks `refresh_token` gets it. A client with no list is untouched; a second
   run changes nothing. A client registered by `clients:create --grants
   authorization_code` cannot refresh: list `refresh_token` too.
   janus-oauth-mongo 0.14 needs `db:sync` again: the clients validator refuses the new
   `requirePushedAuthorizationRequests` field (code 121) until it runs.
   janus-oauth-mongo 0.15 adds the TTL collection `oauthDpopReplay` (DPoP replay cache, RFC 9449):
   run `db:sync` (`syncMongoOAuthPartitioned`) before the deploy so it exists. DPoP proofs are accepted on every tenant;
   they are required only where `dpop.required` or a client's `dpopBoundAccessTokens` says so (see the DPoP paragraph below).
   janus-oauth-mongo 0.16 and janus-mongo 0.29 need `db:sync` again before the deploy: the
   new OAuth index, `typeNameKey` on the users and the validator that accepts `nameKey` (a user
   written with a name is refused, code 121, until it runs). Then `db:migrate` runs
   `2026-11-16-name-keys`, which writes `nameKey` (the folded display name) on the users written
   before janus 0.66, so the console's `userLookup` finds them by name; idempotent, it moves
   neither `version` nor `updatedAt`.
   Authorization details (clavix-api #17): run `db:sync` **before** the release. It creates the
   `detailTypes` collection and its unique `(tenantId, type)` index, and `syncMongoOAuthPartitioned`
   adds the janus-oauth-mongo validators that accept `authorizationDetails` on grants, codes, tokens
   and requests. Skipped, a request that carries details is refused by the validators (code 121,
   `STORE_FAILED`) and the first type a tenant defines fails to save. No migration: a tenant with no
   type behaves as before.
   Clients opt in (R3): any client that requires PAR can list the tenant's stored types, whatever its grants. No migration; `db:sync` first, as above (the clients validator
   accepts `authorizationDetailsTypes`).
   Deploy clavix-ui with the consent details (clavix-ui#10) before this API; `CLAVIX_RAR_CONSENT_READY` is now ignored.
   Pushed authorization requests (clavix-api #13): run `db:sync` **before** `db:migrate` and before the
   deploy (the PAR validators, the replay collection and the clients validator that accepts
   `requirePushedAuthorizationRequests`). `db:migrate` then runs `2026-11-16-oauth-policy`, which writes
   an explicit `oauth: { par: { required: false }, dpop: { required: false } }` on every tenant
   that has none, so tenants that existed keep PAR off whatever the schema default becomes; new tenants
   start with PAR required. Idempotent; it moves neither `version` nor `updatedAt`. The proxy must
   route `/par` to the API (the Caddyfile's `@api` matcher does).
   DPoP-bound tokens (clavix-api #14): run `db:sync` **before** the deploy, as above, because DPoP is
   now on for every tenant: the tokens validators must accept `jkt`, the clients validator
   `dpopBoundAccessTokens`, and `oauthDpopReplay` (the replay cache, in Mongo, not Redis) must exist, or a
   proof is refused with a 500 (validator code 121 in the logs). No new migration: `2026-11-16-oauth-policy`
   already wrote `dpop: { required: false }` on every tenant, and new tenants start with it `false`. The
   nonce secret is derived from `CLAVIX_KEYS_MASTER_KEY` (HKDF, info `dpop-nonce`): nothing to configure,
   every instance agrees, and rotating the key (a new first key) only makes DPoP clients retry once on
   `use_dpop_nonce`. Keep the instances' clocks in sync (the replay cache and the proofs' `iat` read them).
   Turning `dpop.required` on breaks a client that sends no proof: warn its owner first.
   Token exchange (clavix-api #16): run `db:sync` before the deploy so the `clientPolicies` collection and its
   unique index (`tenantId`, `clientId`) exist. No migration and no backfill: a client with no rules is refused
   (`access_denied`), which is today's behaviour.
4. `dc up -d api ui`. The API drains requests in flight on SIGTERM, within compose's 20 s grace period.
5. Check `/healthz` and `/readyz`, then sign in to the console.
6. Once the new containers are healthy, free the disk: `docker image prune -f`,
   `docker image rm` of the `CLAVIX_API_IMAGE` / `CLAVIX_UI_IMAGE` tags older than
   the one you would roll back to (keep the previous release until this one has
   proved itself),
   and `docker builder prune -f --filter until=24h` when images are built on the
   host. Never `docker system prune -a` or `--volumes`: the volumes hold the data.

Rollback: set the previous tags and `dc up -d api ui`. This rolls back the
images, not the schema or data: if a migration changed data, restore the backup
taken in step 2 (below).

## Staging

Staging runs on the shared VPS behind its Traefik v3 (the `proxy` network of nxgt-docker),
not behind Caddy. `deploy/compose.traefik.yml` is an overlay of `compose.yml`; `deploy/deploy.ts`
drives both.

| Host                   | Served by                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `clavixid.com`         | platform pages, console, landing (the ui); the api for its OAuth and GraphQL paths                      |
| `console.clavixid.com` | the console (redirect URI `https://console.clavixid.com/console/auth/callback`; check `/healthz` there) |
| `<slug>.clavixid.com`  | the tenant's hosted pages and issuer (the `clavix` tenant's is `clavix.clavixid.com`)                   |
- **TLS** is traefik's, from its `letsencrypt` resolver (Cloudflare DNS-01). The routers ask for
  `clavixid.com` and `*.clavixid.com` together, because the `*.softistx.com` wildcard of traefik
  does not cover them. Staging has a zone of its own, `clavixid.com`, so the tenant hosts stay one
  level deep and Cloudflare's edge certificate covers them (`<slug>.clavix.softistx.com` was two
  levels deep: the TLS handshake failed at the edge). The traefik Cloudflare token must cover the zone.
- **DNS and tunnel**: the VPS has no public port 443; all HTTP goes through the Cloudflare Tunnel
  to `https://traefik:443`. In the `clavixid.com` zone, two proxied `CNAME` records, `@` and `*`, point
  to `<tunnel id>.cfargotunnel.com` (no `A` record). The tunnel has two routes (published
  applications), `clavixid.com` and `*.clavixid.com`, to `https://traefik:443` with the origin
  server name `clavixid.com`.
- **Platform mail** is sent as `no-reply@<CLAVIX_DOMAIN>` (here `no-reply@clavixid.com`) through the VPS
  mail relay (`CLAVIX_SMTP_URL=smtp://<user>:<pass>@<relay host>:587?tls.servername=<relay name>`). The
  relay must accept that sender, and the zone carries the relay's SPF, DKIM and DMARC records.
- **Caddy is not started** (its profile is `standalone`) and **custom domains are off**: on-demand
  TLS needs Caddy, so a tenant's own domain is not served in staging.
- The hosts come from `CLAVIX_DOMAIN` in `deploy/.env`; nothing is hard-coded in the overlay. The api gets the
  paths the Caddyfile gave it, the ui everything else; `/internal` and `/readyz` have no route to the api.
- The api and ui are named `clavix-api` and `clavix-ui` and the ui calls `http://clavix-api:3000`:
  the service names `api` and `ui` would be aliases on the shared `proxy` network.
- Every service keeps its `deploy.resources.limits`; the healthchecks are the light ones of
  "What runs" (every 30 s, no Bun or `mongosh` process).

### Deploy and redeploy

On the VPS, with the two checkouts side by side (`clavix-api/`, `clavix-ui/`) and traefik up:

```sh
cd clavix-api
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env   # first time; fill it (see "First boot")
bun deploy/deploy.ts
```

In `deploy/.env`, set `CLAVIX_DOMAIN=clavixid.com`, local image names
(`CLAVIX_API_IMAGE=clavix-api:staging`, `CLAVIX_UI_IMAGE=clavix-ui:staging`) and
no registry token. The script reads `NPM_SOFTISTX_READ_TOKEN` from the environment, else `~/.config/secrets/npm-sofistx-read-token` on the host, and passes it to the image builds as a compose secret; it only warns when neither exists (the installs work only while the packages are public). The script refuses to run when the file is missing, readable by
others (not mode 600 or 400) or incomplete (it checks the domain, the two image names and the secrets of "First boot", step 3: `CLAVIX_KEYS_MASTER_KEY`, `REDIS_PASSWORD`, the two Mongo passwords, `MONGO_KEYFILE`, `CONSOLE_SESSION_SECRET`; `CLAVIX_TLS_ASK_SECRET` and `ACME_EMAIL` must still hold any value, `compose.yml` requires them), or when the `proxy` network does not exist.

One run does, in order: `git pull --ff-only` of both checkouts (`--no-pull` skips it), builds the api
and ui images on the host (no registry), starts `mongo` and `redis`, runs `db:sync` and `db:migrate`
in a one-shot api container, `up -d --wait` for the whole stack (`--timeout <s>`, default 300), then
cleans: the images the build replaced (and any other id under the two image names), dangling images
(`docker image prune -f`) and the build cache older than 24 hours
(`docker builder prune -f --filter until=24h`). It never runs `docker system prune`, and never
touches volumes. A rerun with nothing new rebuilds from cache, migrates nothing and recreates no container.

A **redeploy** is the same command. The first run prints the console client secret once (`db:migrate`):
follow "First boot", steps 5 and 6, then run it again.

To check the merged files without deploying:

```sh
CLAVIX_DOMAIN_RE='^[a-z0-9-]+\.clavixid\.com$' docker compose \
  -f deploy/compose.yml -f deploy/compose.traefik.yml --env-file deploy/.env config -q
```

Rollback in staging: the cleanup removes the images the new build replaced, so the generic "previous tags" rollback does not apply. Check out the old commit (api and ui) and run `bun deploy/deploy.ts --no-pull`.

### Backup and restore in staging

The `backup` and `restore` tools (profile `tools`) work as in "Backup" and "Restore", with both files in the
alias: `dc='docker compose -f deploy/compose.yml -f deploy/compose.traefik.yml --env-file deploy/.env'`
(and `CLAVIX_DOMAIN_RE` exported as above). To restore, follow "Restore" (stop `api ui`, restore, start
them) and "Off-host copies" for `offsite:latest`.

## Backup

```sh
dc --profile tools run --rm backup          # archive in BACKUP_DIR (default backups/)
```

The backup container runs as `BACKUP_UID:BACKUP_GID` (default `1000:1000`), not
root, so the archives belong to the host user instead of root. Create the folder
as that user first (`mkdir -p backups`), and export
`BACKUP_UID=$(id -u) BACKUP_GID=$(id -g)` when your user is not 1000. Archives an
earlier run left owned by root: `sudo chown -R "$(id -u):$(id -g)" backups`.

The scripts are TypeScript run by Bun; the compose `tools` profile builds an image (`deploy/tools.Dockerfile`: `mongo:8` plus Bun, the two scripts bundled with their dependencies) that holds both. After a change to `scripts/`, rebuild it: `dc --profile tools build backup`. By hand: `MONGO_URI=... KEEP=14 bun scripts/mongo-backup.ts [out-dir]` (`BACKUP_KEEP` is its compose spelling).

`scripts/mongo-backup.ts` runs `mongodump --gzip` against `MONGO_URI`, writes
`clavix-<UTC timestamp>.archive.gz` with a `.sha256` next to it (mode 600), and
keeps the newest `BACKUP_KEEP` archives. Schedule it from the host's cron, e.g.
nightly, with the off-host copy below on. The dump is of one database and not
point-in-time (see "Point-in-time recovery"): take it at a quiet hour.

The archive holds the signing keys **encrypted**. It restores a working system
only together with the same `CLAVIX_KEYS_MASTER_KEY`. Back up the master key
separately, in the secret manager. Redis holds only caches, queues and counters:
it is not backed up, and a lost Redis costs a cold cache and the month's active
user counts.

## Off-host copies

An archive on the host dies with the host. Setting `BACKUP_OFFSITE_S3_BUCKET` (and the
credentials, see the environment table) makes every backup upload its archive
and its `.sha256` to S3-compatible storage (any service Bun's S3 client signs for:
AWS, R2, Backblaze, MinIO, SeaweedFS), through `@softistx/s3`. Without a bucket
nothing changes.

```sh
# deploy/.env
BACKUP_OFFSITE_S3_BUCKET=clavix-backups
BACKUP_OFFSITE_S3_ENDPOINT=https://s3.example.com
BACKUP_OFFSITE_S3_ACCESS_KEY_ID=...
BACKUP_OFFSITE_S3_SECRET_ACCESS_KEY=...
BACKUP_OFFSITE_KEEP_DAYS=30
```

- **Order**: the local archive and its checksum are written first, then local
  retention runs, then the upload (archive, then sidecar), then the remote
  retention. The upload streams the file (single PUT, so an archive under 5 GiB).
- **A failed upload fails the job**: the message `offsite: FAILED, the local
  archive <file> is kept: <reason>` goes to stderr and the exit code is 3, so cron
  or the monitoring sees it; the local archive stays and is not deleted by the
  failure. A bucket with missing credentials, or a bad `BACKUP_OFFSITE_KEEP_DAYS`,
  fails before the dump (exit 1). The next run uploads its own archive only: an
  archive that missed its upload is uploaded by hand
  (`bun scripts/mongo-backup.ts` does not retry old ones), or covered by the next night's.
- **Remote retention**: after a successful upload, objects under the prefix named
  `clavix-<stamp>.archive.gz[.sha256]` whose stamp (UTC, from the name, not the
  provider's clock) is older than `BACKUP_OFFSITE_KEEP_DAYS` are deleted. Any other object
  is left alone, and **the newest archive is never deleted**, so a long outage of the job cannot empty
  the bucket. Add the provider's own lifecycle rule or object lock if you want
  protection against a leaked key (the backup key can delete).
- **Restore from the bucket**: pass `offsite:latest` or `offsite:<archive name>` to
  `restore` instead of a path. It downloads the archive and its `.sha256` into
  `RESTORE_FETCH_DIR` (default a temporary folder of the container), verifies the
  checksum as for a local file, then restores:

  ```sh
  dc stop api ui
  CONFIRM=yes dc --profile tools run --rm restore offsite:latest
  CONFIRM=yes dc --profile tools run --rm restore offsite:clavix-20261112T031500Z.archive.gz clavix-drill
  dc up -d api ui
  ```

  The restore container carries the same `BACKUP_OFFSITE_*` variables from `deploy/.env`. An
  archive is as large in the container's temporary folder as on the bucket: mount a
  volume on `RESTORE_FETCH_DIR` when the container's disk is small.
- The master key is **not** in the archive and is not shipped: keep it in the
  secret manager (see "Backup").
- Check the copy at the drill: once a month, restore `offsite:latest` into `clavix-drill`
  (see "Restore drill") instead of a local file.

## Point-in-time recovery

**Not built; this is its design.** The nightly dump restores to the moment it was
taken; everything written since is lost (up to 24 hours). Closing that gap means
shipping the replica set's oplog and replaying it up to a chosen instant. It was left out
of the off-host slice on purpose: it needs a new database privilege, a change of what
is dumped and a restore that cannot run in the local drill, so a half version would
only look like a recovery.

Why it does not fit the current backup as is:
- `mongodump --oplog` only works on a dump of the whole instance (it refuses `--db`,
  `--collection` and a database in the URI) and needs to read the `local` database.
  The application user has `readWrite` on `clavix` only, so a PITR backup needs its own user.
- `mongorestore --oplogReplay` restores into the whole instance as well: the namespace
  rewriting the restore script does for a drill (`--nsFrom` / `--nsTo`) is not
  available with it.

The design, in slices:
1. **A backup user**: created by `deploy/mongo/init-app-user.js` (and by hand on an existing
   volume, as for the application user) in `admin` with the built-in `backup` role,
   credentials `MONGO_BACKUP_USER` / `MONGO_BACKUP_PASSWORD`, used by the `backup` service only (it
   keeps TLS and `authSource=admin`).
2. **Full dump with its oplog**: `mongodump --uri=<backup user> --oplog --gzip --archive`
   (all databases, `admin` included; filter with `--excludeDB` if wanted). The archive's
   oplog part ends at the dump's last operation; the script reads that timestamp
   from the oplog entry the dump finishes at (`local.oplog.rs`, last entry before the
   dump returns) and records `{ "lastTs": "<seconds>:<increment>" }` in a
   `clavix-<stamp>.archive.gz.meta.json` sidecar, shipped with the archive.
3. **Periodic oplog slices** (every 5 to 15 minutes, a second compose service or cron
   line, `scripts/mongo-oplog.ts`): read `local.oplog.rs` for `ts > lastTs` of the newest
   slice or full dump, write the entries as BSON with `mongodump --db=local
   --collection=oplog.rs --query='{"ts":{"$gt":{"$timestamp":{"t":S,"i":I}}}}' --out=-`,
   name the file `oplog-<fromTs>-<toTs>.bson.gz` with a `.sha256`, ship it to
   `<prefix>/oplog/`, and move `lastTs`. A slice must start exactly after the previous one
   ends: the script refuses (exit non-zero, loudly) when the first entry it reads is newer
   than `lastTs` + 1, which means the oplog window was exceeded and the chain is broken
   (size the oplog for at least 24 hours: `replSetResizeOplog`; the next full dump starts a new chain).
4. **Retention**: slices older than the oldest full dump kept are deleted with it (a
   slice is useless without a full dump before it).
5. **Restore to an instant** (`restore offsite:<archive> --until <ISO time>`): download the
   full dump and every slice from its `lastTs` to the target, concatenate the slices' entries into
   one `oplog.bson` of the dump directory, then
   `mongorestore --drop --oplogReplay --oplogLimit=<seconds>:<increment> <dir>` (the oplog
   limit is the first timestamp _not_ replayed, so use the target second + 1). Restore
   into an empty instance or a scratch one first; it cannot run into a single database name.
6. **Drill**: needs a replica set with oplog: `MongoMemoryReplSet` has one, so the
   spec can write, take a slice, write again, and replay to the instant between.

Manual recovery meanwhile: the nightly dump, plus the application's own audit trail
(admin events) to re-apply by hand what happened after it.

## Restore

```sh
dc stop api ui                                            # nobody writes while it runs
CONFIRM=yes dc --profile tools run --rm restore /backups/clavix-20261112T031500Z.archive.gz
dc up -d api ui
```

`scripts/mongo-restore.ts` verifies the checksum (an archive without its `.sha256` is refused unless `SKIP_CHECKSUM=yes`), then runs `mongorestore --drop`
into the database named in `MONGO_URI`. Without `CONFIRM=yes` it prints what it
would do and stops (exit 2). Afterwards run `db:sync`, check `/readyz`, sign in
to the console, and confirm a tenant's JWKS (`https://<slug>.<domain>/jwks.json`)
lists its keys. Key rotation resumes by itself.

A restore reads the archive from the off-host bucket with `restore offsite:latest` (see "Off-host copies").

### Restore drill

Rehearse the restore, never first meet it in an incident. Once a month, and
after any change to the scripts:

```sh
# scratch database on the same server, production untouched
CONFIRM=yes dc --profile tools run --rm restore /backups/<latest> clavix-drill
```

(`restore` accepts the target database name as its second argument), then compare
collection counts with production and drop `clavix-drill`. The repository's spec
`src/ops/restore-drill.spec.ts` does the same against the test MongoDB (dump,
restore into a scratch database, compare collections, documents and indexes,
refuse a damaged archive). It needs `mongodump` and `mongorestore` on the PATH
(`brew install mongodb-database-tools`, or set `MONGODUMP` / `MONGORESTORE`) and
uses them. Without them, when Docker answers and the `mongo:8` image is local, the
spec runs the tools inside a throwaway `mongo:8` container (never pulling the
image); with neither it is skipped.

The drill also covers the tenant purge (see the README, "The trash"): a backup older than a purge
brings the purged tenant's data back, still marked as trashed and long due. After a real restore the
API's start pass purges it again (`tenants: purged the partition of <id>` in the logs, then the
tenant-owned collections), so do not restore a backup into production just to read a purged
tenant. In the scratch database of the drill, check that a tenant in the trash (`deletedAt` set) is
listed with its `purgeAt`, and that the `tenant-purge` queue still ticks at 03:17 UTC.

### Full drill on a fresh host (v1 gate G3)

The drill above restores into a scratch database. The v1 gate also rehearses the whole
recovery: a new host, a restore, the API on it, then a master-key rotation. It ran on a
throwaway stack on 2026-11-20 (MongoDB 8 as a one-node replica set without authentication,
Redis 7, the `deploy/tools.Dockerfile` image, the API from the repository) over a database of
29 documents in 34 collections: the `clavix` tenant plus one tenant with a client, a verified
user, a webhook endpoint and a Google social provider.
1. **Seed.** `bun run db:sync`, `bun run db:migrate` (with `CLAVIX_PUBLIC_SCHEME=https`),
   `bun run tenants:create --slug drill --name Drill`,
   `bun run clients:create --tenant drill --name Machine --client-id machine --confidential --redirect-uri http://localhost:9/cb`,
   then, from a throwaway script on the app's wiring: `webhookEndpoints.create(tenantId, {url, types: [], description}, null)`,
   `signInPolicyService.setSocial(tenantId, {provider: "google", clientId, clientSecret, enabled: true})`,
   and on the tenant's janus instance `auth.create({email})` then `auth.verifyEmail.confirm(...)`. Sign a
   token with the tenant's current signing key (`signingKeysFor(tenantId).findCurrentKey`) and keep the JWKS.
2. **Back up**, the same job as "Backup" (here by hand, on the stack's network):
   `docker run --rm --network <net> -e MONGO_URI=mongodb://mongo:27017/clavix?directConnection=true -v $PWD/backups:/backups --entrypoint bun <tools-image> /scripts/mongo-backup.js /backups`.
   It runs against the live database.
3. **Lose the host**: stop the API, remove MongoDB and Redis. Start a fresh MongoDB
   (`mongo:8 --replSet rs0`, then `rs.initiate`) and an empty Redis.
4. **Restore**, the same job as "Restore" (`dc stop api ui` first, `dc up -d api ui` after):
   `docker run --rm ... -e CONFIRM=yes -e MONGO_URI=<fresh uri> ... /scripts/mongo-restore.js /backups/<archive>`,
   then `bun run db:sync` (do not skip it) and start the API.
5. **Check**: `/readyz` is `ok` with the empty Redis, the discovery document is served, `/jwks.json`
   is byte for byte the one from before (same `kid`), the token signed before the loss verifies against
   it, and the collection counts equal those taken before the backup. A `POST /token` with a wrong
   client secret answers `invalid_client`; with the right secret and a made-up refresh token it answers
   `invalid_grant`, which shows the client's secret still verifies.
6. **Rotate the master key** on the restored database (see "Rotating the master key"):
   `CLAVIX_KEYS_MASTER_KEY=<new>,<old>` then `keys:reseal` (exit 0, `oldKeyNeededBy: []`: the signing keys
   of the 2 tenants, 1 webhook secret and 1 social secret sealed again), then the API on `<new>` alone:
   the JWKS and the old token are unchanged, a token is signed with the new key only, and the webhook
   secret and the social client secret open (the social secret's `kid` changed). The old key alone
   no longer opens the webhook secret (`webhooks: a secret of endpoint <id> could not be opened`).

| Step                                              | Time  |
| ------------------------------------------------- | ----- |
| Build of the tools image (layers cached)          | 11 s  |
| Backup (`mongodump --gzip`, 11 KB archive)        | < 1 s |
| Fresh MongoDB, replica set initiated, empty Redis | 5 s   |
| Restore (checksum, `mongorestore --drop`)         | 1 s   |
| `db:sync` and API ready on the restore            | 6 s   |
| `keys:reseal`                                     | 1 s   |

**RPO: 24 hours** (nightly backup plus the off-host copy; a write between two backups is lost, see
"Point-in-time recovery"). **RTO: 4 hours is the target** (an owner objective, D27); the recovery path
measured about 12 s from a stopped host to a serving API (fresh MongoDB, restore, `db:sync`, API ready),
about 25 s for the whole drill with the image build and the reseal, on a small database. The time grows
with the dump (restore and index builds) and the archive fetch from the bucket; the 4 hours leave room
for what the drill does not measure: provisioning the host, DNS, pulling the images and fetching the
master key from the secret manager. Redis is not backed up and is lost with the host: the restored API
starts on an empty Redis (cold cache, rate-limit counters at zero, the month's active-user counts reset)
and loses the queued jobs, the pending webhook deliveries among them.

What the drill showed about the setup:
- The restored database opens only with the same master key, or a keyring that holds it ("Backup").
  `restore` refuses an archive without its `.sha256`, and takes the target database from `MONGO_URI`.
- The OAuth server accepts an `http:` issuer only on exactly `localhost`, so a local stack with tenant
  subdomains needs an `https` front for `<slug>.<domain>` (a self-signed proxy to the API port, with
  `CLAVIX_PUBLIC_SCHEME=https`, `CLAVIX_PUBLIC_PORT` the proxy's port, and, for development only,
  `NODE_TLS_REJECT_UNAUTHORIZED=0` for the API's own requests). `db:migrate` also needs
  `CLAVIX_PUBLIC_SCHEME=https`: the console client's redirect URI must be https.
- The backup is taken against the live database: no stop is needed.
- The drill does not exercise a `client_credentials` token (it needs a resource that opted in and a confidential
  client), so the token checked after the restore is one signed with the tenant's key.

## Signing keys

Each tenant's ES256 keys rotate by themselves: a key signs for 90 days, the next
one is published 48 h before, a retired key stays published 24 h (hourly job,
plus one pass at API start). Nothing to do in normal operation. To check, read
`https://<slug>.<domain>/jwks.json`.

### Rotating the master key (no downtime)

`CLAVIX_KEYS_MASTER_KEY` is one key, or a comma-separated **keyring**: the first
key seals every new record, any key of the list opens one. Generate the new key
with `openssl rand -base64 32`, keep it in the secret manager, and go in this
order (the order matters: an instance that only knows the old key cannot open a
record another instance sealed under the new one):
1. Deploy `CLAVIX_KEYS_MASTER_KEY=<old>,<new>`: the old key still seals, the new
   one already opens. Wait until every instance runs it.
2. Deploy `CLAVIX_KEYS_MASTER_KEY=<new>,<old>`: the new key seals.
3. Seal again what is still under the old key, from any instance with the same
   environment: `bun run keys:reseal`. It goes over every tenant (suspended and
   trashed included) and over **every store sealed under the keyring**:

   | In the report                              | What it is                                                      |
   | ------------------------------------------ | --------------------------------------------------------------- |
   | `tenants`                                  | how many tenants the run went over                              |
   | `resealed`, `current`, `skipped`, `failed` | the tenants' signing keys (`failed` counts tenants, any store)  |
   | `secondFactor`                             | the users' TOTP secrets, and their recovery-code hashes         |
   | `webhookSecrets`                           | the webhook endpoints' signing secrets, rolled ones included    |
   | `connectionSecrets`                        | the enterprise connections' client secrets                      |
   | `socialSecrets`                            | the social providers' client secrets (tenants in the trash too) |
   | `oldKeyNeededBy`                           | every count that still needs the old key; `[]` when it can go   |

   Each of the nested stores (`secondFactor`, `webhookSecrets`,
   `connectionSecrets`, `socialSecrets`) reports `scanned`, `resealed`,
   `current`, `skipped`, `unreadable` and `behind`; the signing keys have the
   top-level counts only. The run prints `keys: keep the old master key ...`
   on stderr whenever `oldKeyNeededBy` is not empty, and **exits 1** while any
   store has:
   - `skipped` above 0: a record changed meanwhile. Run it again.
   - `failed` above 0: a step threw for a tenant. The log line is
     `keys: reseal failed for tenant <id> (<step>): <message>`, the step being
     `signing keys`, `second factor`, `webhookSecrets`, `connectionSecrets` or
     `socialSecrets`. For the signing keys it means no key of the list opens
     one of its records.
   - `unreadable` above 0: no key of the list opens that secret. The log names
     the record, never the value:
     `webhooks: a secret of endpoint <id> could not be sealed again`,
     `connections: the secret of <id> (tenant <tenant>) could not be sealed again`,
     `sign-in: the <provider> secret of tenant <tenant> could not be sealed again`.
     The TOTP secrets are counted by janus and not logged per user. A re-run
     does not clear it: put the missing key back in the list, or enter the
     secret again (roll the endpoint's secret, set the connection's or the
     provider's client secret, `resetUserSecondFactor` for a user's TOTP).
   - `behind` above 0: counted again after the pass, the secrets still under an
     older key.
4. **Only when a run exits 0 and prints `"oldKeyNeededBy": []`**, deploy
   `CLAVIX_KEYS_MASTER_KEY=<new>` alone. `resealed: 0` on the signing keys is
   not enough: read `oldKeyNeededBy`. The one entry no run can clear is
   `secondFactor.recoveryCodesBehind` (an exit 0 that still lists it): see the
   recovery codes below before dropping the key with it.

Dropping the old key while `oldKeyNeededBy` still names a store makes those
secrets unreadable until the old key is back in the list:
- signing keys: signing fails for those tenants (the JWKS still serves);
- webhook secrets: the endpoint is left out of delivery (never sent unsigned),
  with only a log line `webhooks: a secret of endpoint <id> could not be opened`;
- connection client secrets: the connection is off and its domains cannot sign
  in through SSO (`connections: <id> of tenant <tenant> is off`);
- social client secrets: the provider is no longer offered on the sign-in page;
- TOTP secrets: those users cannot pass the second factor.

The users' TOTP secrets (second factor) are sealed under a subkey of the same
master key (HKDF, info `second-factor`). `keys:reseal` seals them again with janus's
`secondFactor.reseal` (batches of 100, resumable, idempotent), including the users who
do not sign in, and reports `secondFactor: { scanned, resealed, current, skipped,
unreadable, sealed, behind, recoveryCodesBehind }`. `sealed` and `behind` count the
secrets only (not the recovery codes). The recovery codes are hashes and cannot be
hashed again: their old hashes keep working while the old key is in the list, and new
ones (a user's `regenerateRecoveryCodes`) are hashed under the first key. They do not
make the run exit 1 (no run can move them), but `oldKeyNeededBy` lists
`secondFactor.recoveryCodesBehind`: **keep the old key in the list while it is above
0**, or accept that those users' remaining recovery codes stop working (an admin's
`resetUserSecondFactor` lets them enrol again).

After a master key **leaked**, do the same four steps at once, then treat every
secret that was sealed under it as exposed to whoever also holds a copy of the
database: roll the webhook secrets, replace the connection and social client
secrets at their providers, and rotate the signing keys (below).

### Emergency rotation (a signing key leaked)

`bun run keys:rotate <tenant-slug>` (or `--all` for every active tenant) retires
the tenant's current signing key now and makes a new one sign, using janus's
`retire` and rotation step; nothing is deleted by hand and no restart is needed.
It prints, per tenant, the `retired` and the new `current` key id, and exits 1 if
a tenant failed.
- By default the retired key stays published for 24 h (the normal retirement
  window), so tokens already issued keep verifying.
- If the **private key itself leaked**, add `--drop-old`: the retired key is
  unpublished from the store at once, so the tokens it signed stop verifying and the
  leak buys nothing. The running API instances serve their cached JWKS for up to
  60 s (the in-memory cache of `withPublicDocuments`; the CLI is another process, so
  it cannot clear it), and a client that honours `max-age=300` may keep it 5 min
  more. Restart the API instances to empty the cache when 60 s is too long. Users
  sign in again; tell the relying parties.
- If a `next` key was already published, it takes over at once; otherwise a new
  key is created and signs immediately. Relying parties that cached the JWKS
  and have not fetched it since may fail to verify the new key until they do:
  every API instance shows the rotation within 60 s (the cache TTL, since the CLI
  runs in its own process), and a client may keep the document `max-age=300` (5 min)
  longer, so about 6 minutes at worst.
- If the **master key** leaked, rotate it first (above), then run
  `keys:rotate --all --drop-old`: a new master key alone does not change the
  signing keys.

`--all` covers the active tenants only; a suspended tenant is rotated by naming its slug once reactivated. A non-zero exit means a tenant may be left with no current key until the hourly job runs: run `keys:rotate` for that tenant again.

Check afterwards with `https://<slug>.<domain>/jwks.json`.

A **lost** master key cannot be recovered by rotation: the stored keys are
unreadable. Drop the tenants' `oauthSigningKeys` documents and restart the API so
the start pass creates new keys (README, "Signing keys").

## Load test

`load/` holds the k6 scripts and the harness of the v1 load test (D26). It runs on one machine against
the production image and `deploy/compose.yml` as they are (production mode, the resource limits, a one-node
replica set, Redis with a password), under the compose project `clavix-load`: `mongo`, `redis` and `api`.
Caddy and the ui are not started: k6 joins the compose network and sends what Caddy would add (the tenant's
`Host`, `X-Forwarded-For` from a pool of 250 addresses, `X-Forwarded-Proto: https`). Nothing is published on
the host, and the whole run is torn down with its volumes. Staging hardware is the better judge of the
numbers: D26 asks for another machine, and a laptop shares its cores.

| File                     | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `load/run.ts`            | `build`, `up`, `seed`, `k6 <out> <script>`, `down`, or `all`; writes a throwaway `deploy/.env`  |
| `load/seed.ts`           | 50 tenants, 2 public clients each, one real user per tenant, one refresh-token chain per client |
| `load/token.js`          | `POST /token`, refresh grant, 200 req/s, 60 s                                                   |
| `load/jwks-discovery.js` | `GET /jwks.json` and `GET /.well-known/openid-configuration`, 1 000 req/s each, 60 s            |
| `load/lib.js`            | the target, the tenants, the headers, the arrival-rate scenarios                                |

```sh
bun load/run.ts build                     # docker build -t clavix-api:load .
bun load/run.ts up                        # mongo, redis, db:sync, db:migrate
bun load/run.ts seed                      # tenants, clients, chains; (re)starts the api; run it again before every token run
bun load/run.ts k6 "$PWD/load/out" jwks-discovery.js
bun load/run.ts k6 "$PWD/load/out" token.js
bun load/run.ts down                      # containers, volumes, the generated deploy/.env
```

The k6 image is `grafana/k6` (any other tool image is never pulled). Each script runs open-model
(`constant-arrival-rate`), so a slow server shows as latency and dropped iterations, never as a lower
request rate. `jwks-discovery.js` warms for 10 s (not measured); `token.js` warms each tenant with one
discovery request in `setup` instead, because its VUs hold state.

Method notes:
- **`client_credentials`**: the seed opts the load resource in (`allowClientCredentials`) and registers a
  confidential client per tenant, whose id and secret go under `confidential` in `seed.json`. `token.js` probes
  the grant once in `setup` and measures it beside the refresh grant (Basic authentication, `resource` and
  `scope=read`). `CLIENT_CREDENTIALS=0` skips the scenario, for a `seed.json` made before the grant shipped.
- **D26** (the v1 load test decision): `/token` p95 under 150 ms at 200 req/s with 0 errors; JWKS and discovery
  p95 under 20 ms at 2 000 req/s; run against a staging-like compose, not production.
- **Prerequisites**: Docker with Compose 2.20+, the `grafana/k6` image, `openssl` and `bun` on the host, and a Docker
  VM with about 10 GiB. `load/out/` (git-ignored) receives `seed.json`, `*.summary.json` and `*.log`.
- **Knobs**: `RATE`, `VUS`, `DURATION` and `WARMUP` (env of `run.ts k6`, passed to k6; the lower-rate rows below are
  `RATE=300 VUS=60 DURATION=30s WARMUP=5s` and `RATE=150 ...`), `LOAD_TENANTS` and `LOAD_CHAINS` (env of the seed,
  defaults 50 and 4).
- **A refresh chain is one VU's.** Refresh tokens rotate and a reused one revokes the grant, so each VU walks
  its own chain (the seed makes 100 chains; a think time of 250 ms keeps about 50 VUs busy at 200 req/s, so about 50 chains over as many tenants are used).
  `seed.ts` mints the chains through the real `/par`, `/authorize`, approval and code exchange of the real issuers
  (the approval is called directly, in place of the hosted sign-in, for the tenant's real user); the seed must run again before each token run.
- **Thresholds** are in the scripts: refresh p95 under 150 ms with 0 failures; JWKS and discovery p95 under 20 ms
  with 0 failures; no dropped iteration (a saturated api cannot pass on the latency of the few requests it served). `k6` exits non-zero when one is crossed.

### Results (2026-11-20)

Machine: Apple M5 Pro, 18 cores; the Docker VM has 18 CPUs and 9.7 GiB. The laptop was shared with other
sessions: the 1-minute load average was 3.5 to 6.1 during the runs (5-minute 4.0 to 5.0). Containers keep
the limits of `compose.yml` (api 1 CPU, mongo 1 CPU, redis 0.25 CPU); k6 ran in a container with no limit.
`@softistx/janus-oauth` as locked in `bun.lock`. The two cache rows were run together (2 000 req/s in all).

| Target                                  | Rate              | p95 (ms) | p99 (ms) | Errors | Threshold        | Result                                                                                                                                 |
| --------------------------------------- | ----------------- | -------- | -------- | ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /token` (refresh grant)           | 200 req/s, 60 s   | 11.1     | 46.7     | 0      | p95 under 150 ms | pass                                                                                                                                   |
| `GET /jwks.json`                        | 1 000 req/s, 60 s | 175.9    | 228.4    | 0      | p95 under 20 ms  | **miss** (before the cache, see below)                                                                                                 |
| `GET /.well-known/openid-configuration` | 1 000 req/s, 60 s | 232.6    | 296.7    | 0      | p95 under 20 ms  | **miss** (before the cache, see below)                                                                                                 |
| `GET /jwks.json`                        | 1 000 req/s, 60 s | 0.41     | 0.96     | 0      | p95 under 20 ms  | pass (with the cache)                                                                                                                  |
| `GET /.well-known/openid-configuration` | 1 000 req/s, 60 s | 0.42     | 0.95     | 0      | p95 under 20 ms  | pass (with the cache)                                                                                                                  |
| `client_credentials`                    | 200 req/s, 60 s   | 33.6     | 209.5    | 0      | p95 under 150 ms | pass on latency (run beside the refresh grant: 400 req/s in all); 29 iterations dropped on a shared machine, see the quiet rerun below |

### Rerun on a quiet machine (2026-11-20)

The first run above dropped 29 `client_credentials` iterations on a shared laptop. `bun load/run.ts all`
was run again, unchanged (same scripts, same thresholds), at 05:29 to 05:32 EST on the same machine, with
the cache. Load average before the run: 2.60 (1 min), 1.90 (5 min), 2.43 (15 min); at the end 5.94 / 3.97 / 3.18
(the run itself: k6, api, mongo and redis). No other heavy job was running. `k6` exited 0 for both scripts.

| Target                                  | Rate              | p95 (ms) | p99 (ms) | Errors | Dropped | Result |
| --------------------------------------- | ----------------- | -------- | -------- | ------ | ------- | ------ |
| `GET /jwks.json`                        | 1 000 req/s, 60 s | 0.74     | 3.30     | 0      | 0       | pass   |
| `GET /.well-known/openid-configuration` | 1 000 req/s, 60 s | 0.73     | 3.24     | 0      | 0       | pass   |
| `POST /token` (refresh grant)           | 200 req/s, 60 s   | 24.5     | 95.9     | 0      | 0       | pass   |
| `client_credentials`                    | 200 req/s, 60 s   | 29.2     | 92.6     | 0      | 0       | pass   |

`dropped_iterations` is 0 on both scripts (120 002 JWKS and discovery requests and 24 002 `/token` requests in the measured phase, 0 failed): the
29 drops of the first run did not recur on a quiet machine, which points to the shared machine rather than the api or the VU pool. All D26 thresholds hold.

Before the cache, the 2 000 req/s run saturated the api: it held about 98 % of its 1 CPU limit, k6 dropped 10 605 iterations
(1 630 req/s were served in all) and mongo ran at about 60 % of a core. The same script at lower rates, 30 s each,
to find where it stopped meeting the threshold (before the cache):

| JWKS and discovery together (before the cache) | JWKS p95 (ms) | Discovery p95 (ms) | Threshold (20 ms)        |
| ---------------------------------------------- | ------------- | ------------------ | ------------------------ |
| 300 req/s (150 each)                           | 3.3           | 4.2                | pass                     |
| 600 req/s (300 each)                           | 13.4          | 18.0               | pass, with little margin |
| 2 000 req/s (1 000 each)                       | 175.9         | 232.6              | miss                     |

Cause of the miss (measured): every JWKS and discovery request read Mongo. With the profiler on, one
`/jwks.json` made 7 queries: `resources`, `scopes` and `detailTypes` twice each (the tenant's resource catalogue,
read while the tenant's server is resolved) and one `oauthSigningKeys` read. At 1 000 req/s each that is about
14 000 Mongo reads a second behind a 1 CPU api.

Fix (`withPublicDocuments`, `src/oauth/public-documents.ts`): the JWKS and the two discovery documents are served
from memory, as the serialized body with an `ETag`, keyed by `<tenantId>.<tenant version>.<keys generation>.<issuer>` per host
and path, and answer 304 to a matching `If-None-Match`; janus's `Cache-Control: public, max-age=300` is kept. A hit
reads nothing but the tenant resolver's own cache. The keys generation is bumped by every insert, promote or retire
of the tenant's signing keys in this process (`createTenantKeys`), a tenant write changes the version, and a
60 s TTL bounds what the key cannot see: a rotation made by another instance, a retired key reaching its
`publishUntil`, and a resource or scope change reaching `scopes_supported` in discovery (token flows still serve
those at once). The cache table above was rerun after it, 2 000 req/s in all (1 000 each), same machine and limits,
no dropped iteration.

Side finding fixed in this PR: the production bundle (`bun dist/server.js`) did not start, `tsyringe requires a
reflect polyfill` (the passkey verification pulls it in), because nothing imported `reflect-metadata`. The
specs never hit it, they do not run the bundle. `src/server.ts` now imports it first and it is a direct dependency.

## Troubleshooting

| Symptom                            | Look at                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api` restarts at once             | `dc logs api`: a malformed variable stops the app at start and is named                                                                                                                                                                                                                                                          |
| `/readyz` 503                      | the `checks` object names `mongo` or `redis`; `dc ps`, `dc logs mongo`                                                                                                                                                                                                                                                           |
| `mongo` never healthy              | `dc logs mongo`; the replica set host must be `mongo:27017` (changing the service name breaks `rs.initiate`)                                                                                                                                                                                                                     |
| No certificate for a tenant        | `dc logs caddy`; ask by hand from the private network: `dc exec api bun -e "console.log((await fetch('http://127.0.0.1:3000/internal/tls/ask?token=' + process.env.CLAVIX_TLS_ASK_SECRET + '&domain=acme.<domain>')).status)"` (200 expected; 404: the tenant is not live, or the domain not verified)                           |
| Passkey refused on a custom domain | The origin must be one of the tenant's _verified_ domains (the list `/.well-known/webauthn` serves on the slug host, `curl https://<slug>.<domain>/.well-known/webauthn`); the rpId stays the slug host. A domain just verified or removed applies once the tenant's cache entry drops (at once on verify/remove, 60 s at worst) |
| Rate-limited by Let's Encrypt      | see "TLS": move the slug hosts to a wildcard certificate                                                                                                                                                                                                                                                                         |
| Everyone shares one rate limit     | `CLAVIX_TRUSTED_PROXIES` must be 1 behind Caddy                                                                                                                                                                                                                                                                                  |
| Sign-in mails do not leave         | `CLAVIX_SMTP_URL`; the mailer logs the relay's refusal                                                                                                                                                                                                                                                                           |
| Wrong tenant on a host             | Caddy must pass `Host` untouched (`header_up Host {host}`)                                                                                                                                                                                                                                                                       |
| Console `401`                      | the `console` client secret from `db:migrate`; see the README, "Console API"                                                                                                                                                                                                                                                     |

Application errors and their causes: [troubleshooting.md](troubleshooting.md).

## Not covered yet

- JWKS and discovery miss the D26 target (p95 20 ms at 2 000 req/s on one API CPU; see "Load test"): the cache decision is open.
- TLS on Redis (the connection is authenticated, on the private network).
- Image publishing and any deploy pipeline (workflows are off).
- Point-in-time recovery (oplog): designed, not built (see "Point-in-time recovery").
