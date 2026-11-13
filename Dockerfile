# syntax=docker/dockerfile:1
# The Clavix API image: the bundled server (bun run build), non-root, with a
# healthcheck on /healthz. Build: `docker build -t clavix-api .` (see
# docs/operations.md). @softistx packages come from GitHub Packages: pass the
# token as a build secret, it never lands in a layer.

# Runtime dependencies only (the scripts and the bundle's externals need them).
FROM oven/bun:1.4.4 AS prod
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" bun install --frozen-lockfile --production --ignore-scripts

# Everything, to generate the GraphQL types and bundle the server. Install
# scripts are skipped: a dev dependency's postinstall (a Redis download) has no
# place in an image.
FROM prod AS build
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build

FROM oven/bun:1.4.4-slim AS run
ENV NODE_ENV=production PORT=3000
WORKDIR /app
# The bundle holds the server; the scripts (db:sync, db:migrate, tenants:create,
# ...) run from the sources with the runtime dependencies, so ship both.
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock /app/bunfig.toml /app/tsconfig.json ./
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=prod --chown=bun:bun /app/node_modules ./node_modules
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "dist/server.js"]
