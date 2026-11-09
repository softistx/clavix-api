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

`.env.example` lists the variables: `PORT` (default 3000).
