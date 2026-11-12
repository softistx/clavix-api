# clavix-api: rules for agents and contributors

The API of Clavix, a multi-tenant OAuth 2.1 / OpenID Connect identity provider (one
issuer per tenant): Bun, alxia, GraphQL Yoga, and later `@softistx/mongo`,
`@softistx/redis` and the `@softistx/janus*` packages. It serves the OAuth/OIDC endpoints,
the GraphQL API of the console and of the hosted pages, and the tenant, key, domain and
policy services. The UI is `softistx/clavix-ui`.

The owner's rules for every repository (worktrees, Conventional Commits, integration
branches, CI quotas, merges and releases, questions to the owner, in-house packages) are
in `~/.claude/CLAUDE.md`; this file states only what is clavix-api's own.

## Where things are

- **The spec** is in `../spec/` (the coordinating session's folder): `README.md`,
  `vision.md`, `domain.md`, `architecture.md`, `decisions.md` (the ADRs, changed only by a
  new ADR), `milestones.md`. Read `architecture.md` and `decisions.md` before a slice.
- **The roadmap** is `docs/roadmap.md`; each slice is one GitHub issue on this repository,
  and a slice that waits on an nxgt-janus release says which one.
- **The coordinating session** is the one in `~/workspace/dev/clavix`: this repository's
  session sends it its status, merges, blockers and every owner question with its
  recommended option, instead of asking the owner directly.

## Conventions

- The conventions are those of the `alxia-graphql-api` plugin (enabled in
  `.claude/settings.json`); healthix-api is the worked example this skeleton was cut from.
- Layout: `src/modules/<name>/` holds a module's `*.graphqls`, resolvers and services,
  merged by `src/modules/index.ts`; `src/http/` holds the context and the schema;
  `src/config/` reads the environment once (`defineEnv`); generated code is in
  `src/generated/` and `test/generated/` (`bun run generate`, gitignored), never committed.
- `src/oauth/` is the authorization server: one janus server per tenant (`createClavixOAuthIssuers`),
  mounted on the app by `mountOAuth`. Signing keys, end-user authentication and resources
  come in as ports (`SigningKeysFor`, `AuthFor`, `ResourcesFor`). The janus adapters
  partition themselves by tenant, so they take the plain `oauthDb` (`src/config/oauth-db.ts`),
  not the scoped collections. Lifetimes (`src/oauth/lifetimes.ts`): access token 15 min,
  refresh 30 days sliding, 90 days cap.
- Imports carry no extension (bundler resolution); `@/` is `src/`, `~/` is `test/`.
- Split by responsibility: no file that holds several roles.
- Commits and PR titles follow Conventional Commits (`type(scope): description`).

## Green bar

`bun run verify` = `generate`, `check:ci` (Biome), `typecheck` (`bun check`), `test`; CI
(`.github/workflows/ci.yml`, on pull requests into `develop` only) runs it, then `build`.
The `@softistx/*` packages come from GitHub Packages: `export GITHUB_TOKEN=$(gh auth token)`
(`read:packages`) before `bun install`; CI uses the `PACKAGES_TOKEN` secret.

## Tests and the machine

A spec connects to no service the CI runner lacks. The skeleton has no store; the slice
that adds MongoDB or Redis starts an in-memory one in `test/setup.ts` (as healthix-api's
does) rather than reading `.env`. A slice runs the specs of the code it changed.
