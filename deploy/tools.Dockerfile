# syntax=docker/dockerfile:1
# The backup and restore tools image: the MongoDB database tools of mongo:8 plus
# the Bun runtime, and scripts/mongo-backup.ts and mongo-restore.ts bundled with
# their dependencies (@softistx/s3 for the off-host copy), so nothing is
# installed at run time. The build context is the repository root
# (deploy/compose.yml); @softistx packages come from npmjs (public): no token.
FROM oven/bun:1.4.4 AS bundle
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY scripts ./scripts
RUN bun build scripts/mongo-backup.ts scripts/mongo-restore.ts --target=bun --outdir=/out

FROM mongo:8
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bundle /out /scripts
