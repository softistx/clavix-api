# Operations

Run Clavix on one host with Docker Compose: the API, the UI, MongoDB (a one-node
replica set), Redis and Caddy for TLS. Nothing here is deployed by CI. The files
are `Dockerfile`, `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`
and `scripts/mongo-backup.sh` / `scripts/mongo-restore.sh`.

## What runs

| Service | Image                                 | Reachable from             | Notes                                            |
| ------- | ------------------------------------- | -------------------------- | ------------------------------------------------ |
| `caddy` | `caddy:2`                             | the internet (80, 443)     | the only published ports; certificates on demand |
| `api`   | `CLAVIX_API_IMAGE` (the `Dockerfile`) | `caddy`, `ui`              | non-root, healthcheck on `/healthz`, port 3000   |
| `ui`    | `CLAVIX_UI_IMAGE` (clavix-ui)         | `caddy`                    | hosted pages, console, landing; port 3001        |
| `mongo` | `mongo:8`                             | `api`, `backup`, `restore` | `--replSet rs0`, initiated by its healthcheck    |
| `redis` | `redis:7-alpine`                      | `api`                      | password, append-only file                       |

Caddy sends the authorization server, the GraphQL APIs, JWKS, userinfo, the logo
and `/healthz` to the API, and everything else to the UI. The tenant is chosen
by the `Host` header, which Caddy passes untouched.

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

1. A host with Docker, DNS `A`/`AAAA` records for `<domain>` and
   `*.<domain>` (so `console.<domain>` and every `<slug>.<domain>` resolve), and
   ports 80 and 443 open.
2. Build and publish the images yourself. Both repositories build with their
   `Dockerfile`; the API one needs the GitHub Packages token as a build secret:

   ```sh
   export GITHUB_TOKEN=$(gh auth token)
   docker build --secret id=github_token,env=GITHUB_TOKEN -t registry.example.com/clavix-api:0.1.0 .
   ```

3. `cp deploy/.env.example deploy/.env` and fill it (never commit it). Generate
   the secrets: `openssl rand -base64 32` for `CLAVIX_KEYS_MASTER_KEY`,
   `openssl rand -hex 32` for `CLAVIX_TLS_ASK_SECRET`, `openssl rand -hex 24` for
   `REDIS_PASSWORD`, `openssl rand -base64 48` for `CONSOLE_SESSION_SECRET`.
   `CONSOLE_CLIENT_SECRET` stays a placeholder until step 5.
4. **Master key custody.** `CLAVIX_KEYS_MASTER_KEY` encrypts every tenant's
   signing keys and social secrets. Store it in a secret manager apart from the
   database and from the backups. Losing it makes the stored keys unreadable
   (see "Signing keys" below).
5. Start the data services, then run the deployment steps once:

   ```sh
   alias dc='docker compose -f deploy/compose.yml --env-file deploy/.env'
   dc up -d mongo redis
   dc run --rm api bun run db:sync       # collections, indexes, validators
   dc run --rm api bun run db:migrate    # prints the console client secret once: save it
   ```

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
   role directly. Every run is recorded as the admin event `operator.grant`.
   See the README, "Console API".
7. Check: `curl https://console.<domain>/healthz` answers 200 and
   `dc exec api bun -e "console.log((await fetch('http://127.0.0.1:3000/readyz')).status)"`
   prints 200.

## Environment

The variables of the API are in the README ("Environment") and `.env.example`.
Beyond them, the deployment reads, in `deploy/.env`:

| Variable                                    | Read by        | Meaning                                                                                                                                                        |
| ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAVIX_API_IMAGE`, `CLAVIX_UI_IMAGE`       | compose        | the images to run                                                                                                                                              |
| `CLAVIX_DOMAIN`                             | api, ui, caddy | the apex; tenants live at `<slug>.<domain>`                                                                                                                    |
| `ACME_EMAIL`                                | caddy          | the ACME account address                                                                                                                                       |
| `REDIS_PASSWORD`                            | redis, api     | the password in `REDIS_URL`                                                                                                                                    |
| `CLAVIX_KEYS_MASTER_KEY`, `CLAVIX_SMTP_URL` | api            | required in production                                                                                                                                         |
| `CLAVIX_TLS_ASK_SECRET`                     | api, caddy     | the token of the `ask` URL, 32 characters or more                                                                                                              |
| `CONSOLE_CLIENT_SECRET`                     | ui (and api)   | ui, required for the console: the secret of the `console` OAuth client, from `db:migrate` or `clients:create --client-id console`                              |
| `CONSOLE_SESSION_SECRET`                    | ui (and api)   | ui, required for the console: signs the session cookie, 32 characters or more (`openssl rand -base64 48`)                                                      |
| `CONSOLE_ISSUER`                            | ui             | ui, optional: the console's issuer, default `https://clavix.<CLAVIX_DOMAIN>`; it must equal the API's `iss` exactly (see below)                                |
| `CONTACT_EMAIL`                             | ui             | the public contact address                                                                                                                                     |
| `BACKUP_DIR`, `BACKUP_KEEP`                 | backup         | archive folder on the host (default `backups/` at the repository root; a relative value is relative to `deploy/`, prefer an absolute path), archives kept (14) |

Compose sets `MONGO_URI`, `REDIS_URL`, `CLAVIX_TRUSTED_PROXIES=1` (Caddy is the
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

## TLS

Caddy gets a certificate for a host the first time it is asked for, but only
after it asks the API: `GET http://api:3000/internal/tls/ask?token=...&domain=<host>`.
The answer is 200 for
- a verified custom domain of a live tenant,
- the apex, `console.<domain>`, and `<slug>.<domain>` of a live tenant,

and a bare 404 for everything else (an unknown, pending, lapsed or suspended
domain, a deleted tenant, a wrong token); 429 past `CLAVIX_TLS_ASK_LIMIT`
asks a minute (a flood of random names sent to your IP can use that budget up
and make legitimate asks answer 429 for a minute; raise the limit if it happens). So a stranger pointing a name at your IP gets no certificate.

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

1. Build and tag the new images; set the new tags in `deploy/.env`.
2. Take a backup first (below).
3. `dc pull` (or load the images), then
   `dc run --rm api bun run db:sync && dc run --rm api bun run db:migrate`.
   Read the release notes: a migration may change data.
4. `dc up -d api ui`. The API drains requests in flight on SIGTERM, within compose's 20 s grace period.
5. Check `/healthz` and `/readyz`, then sign in to the console.

Rollback: set the previous tags and `dc up -d api ui`. This rolls back the
images, not the schema or data: if a migration changed data, restore the backup
taken in step 2 (below).

## Backup

```sh
dc --profile tools run --rm backup          # archive in BACKUP_DIR (default backups/)
```

`scripts/mongo-backup.sh` runs `mongodump --gzip` against `MONGO_URI`, writes
`clavix-<UTC timestamp>.archive.gz` with a `.sha256` next to it (mode 600), and
keeps the newest `BACKUP_KEEP` archives. Schedule it from the host's cron, e.g.
nightly, and copy the archives off the host. The dump is of one database and not
point-in-time: take it at a quiet hour.

The archive holds the signing keys **encrypted**. It restores a working system
only together with the same `CLAVIX_KEYS_MASTER_KEY`. Back up the master key
separately, in the secret manager. Redis holds only caches, queues and counters:
it is not backed up, and a lost Redis costs a cold cache and the month's active
user counts.

## Restore

```sh
dc stop api ui                                            # nobody writes while it runs
CONFIRM=yes dc --profile tools run --rm restore /backups/clavix-20261112T031500Z.archive.gz
dc up -d api ui
```

`scripts/mongo-restore.sh` verifies the checksum (an archive without its `.sha256` is refused unless `SKIP_CHECKSUM=yes`), then runs `mongorestore --drop`
into the database named in `MONGO_URI`. Without `CONFIRM=yes` it prints what it
would do and stops (exit 2). Afterwards run `db:sync`, check `/readyz`, sign in
to the console, and confirm a tenant's JWKS (`https://<slug>.<domain>/jwks.json`)
lists its keys. Key rotation resumes by itself.

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
is skipped without them.

## Signing keys

Each tenant's ES256 keys rotate by themselves: a key signs for 90 days, the next
one is published 48 h before, a retired key stays published 24 h (hourly job,
plus one pass at API start). Nothing to do in normal operation. To check, read
`https://<slug>.<domain>/jwks.json`.

Emergency rotation (a key leaked) and a lost or changed master key use the same
procedure, from the README ("Signing keys"): delete the tenant's `oauthSigningKeys`
documents, restart the API so the start pass creates new keys, and tell relying
parties: tokens signed by the old keys stop verifying once the JWKS no longer
lists them. There is no re-encryption in place and no "rotate now" script yet.

## Troubleshooting

| Symptom                        | Look at                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api` restarts at once         | `dc logs api`: a malformed variable stops the app at start and is named                                                                                                                                                                                                                                |
| `/readyz` 503                  | the `checks` object names `mongo` or `redis`; `dc ps`, `dc logs mongo`                                                                                                                                                                                                                                 |
| `mongo` never healthy          | `dc logs mongo`; the replica set host must be `mongo:27017` (changing the service name breaks `rs.initiate`)                                                                                                                                                                                           |
| No certificate for a tenant    | `dc logs caddy`; ask by hand from the private network: `dc exec api bun -e "console.log((await fetch('http://127.0.0.1:3000/internal/tls/ask?token=' + process.env.CLAVIX_TLS_ASK_SECRET + '&domain=acme.<domain>')).status)"` (200 expected; 404: the tenant is not live, or the domain not verified) |
| Rate-limited by Let's Encrypt  | see "TLS": move the slug hosts to a wildcard certificate                                                                                                                                                                                                                                               |
| Everyone shares one rate limit | `CLAVIX_TRUSTED_PROXIES` must be 1 behind Caddy                                                                                                                                                                                                                                                        |
| Sign-in mails do not leave     | `CLAVIX_SMTP_URL`; the mailer logs the relay's refusal                                                                                                                                                                                                                                                 |
| Wrong tenant on a host         | Caddy must pass `Host` untouched (`header_up Host {host}`)                                                                                                                                                                                                                                             |
| Console `401`                  | the `console` client secret from `db:migrate`; see the README, "Console API"                                                                                                                                                                                                                           |

Application errors and their causes: [troubleshooting.md](troubleshooting.md).

## Not covered yet

- MongoDB authentication and TLS between containers (an accepted risk for now): the database listens on the
  private compose network only, shared by api, ui, caddy and the tools. Add auth with a key file before exposing it.
- Image publishing and any deploy pipeline (workflows are off).
- Point-in-time recovery (oplog) and off-host backup shipping.
