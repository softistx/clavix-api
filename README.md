# clavix-api

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider. The
spec is in `../spec/`; the plan is `docs/roadmap.md`. Rules for contributors:
[AGENTS.md](AGENTS.md).

Today it is a skeleton: `GET /healthz`, and `health { status version }` on `POST /graphql`.

## Run

```sh
export GITHUB_TOKEN=$(gh auth token)   # read:packages, for the @softistx packages
bun install
cp .env.example .env
bun run generate   # GraphQL types, gitignored; also run by build and verify
bun dev            # http://localhost:3000/graphql and /healthz
```

## Scripts

| Script                    | Does                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `generate`                | scalar/validation SDL, then GraphQL codegen                              |
| `dev`, `build`, `start`   | watch server; bundle into `dist/`; run the bundle                        |
| `test`                    | `bun test`                                                               |
| `typecheck`               | `bun check`                                                              |
| `lint`, `fix`, `check:ci` | Biome                                                                    |
| `verify`                  | `generate`, `check:ci`, `typecheck`, `test` (what CI runs, plus `build`) |

## Environment

`.env.example` lists the variables; a malformed one stops the app at start, naming it.

| Variable               | Default / rule                                                   |
| ---------------------- | ---------------------------------------------------------------- |
| `PORT`                 | 3000                                                             |
| `MONGO_URI`            | required; a replica set (transactions)                           |
| `REDIS_URL`            | required in production; unset elsewhere, the tenant cache is off |
| `CLAVIX_DOMAIN`        | required in production; `clavix.localhost` elsewhere             |
| `CLAVIX_PUBLIC_SCHEME` | `https`; `http` is refused in production                         |
| `CLAVIX_PUBLIC_PORT`   | optional; set when issuers are not on the scheme's own port      |

## How a host maps to a tenant

A request belongs to the tenant whose slug is the one label before `CLAVIX_DOMAIN`:
`acme.clavix.example` is tenant `acme`, with issuer `https://acme.clavix.example`
(`CLAVIX_PUBLIC_SCHEME`, and `:CLAVIX_PUBLIC_PORT` when set). The host is the URL's, that is
the `Host` header; `X-Forwarded-Host` is ignored. It is lowercased, its port and trailing dot
removed. No tenant (`null`, a 404 for the OAuth endpoints) for an IP, the apex itself, more
than one label before it, a reserved label (`www`, `console`, `api`, ...), an unknown slug, a
suspended or deleted tenant. In a resolver, `await tenant()` of the context gives
`{ tenantId, slug, issuer, partition, version }`, resolved once per request.

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
