# The backup and restore tools image: the MongoDB database tools of mongo:8 plus
# the Bun runtime that runs scripts/mongo-backup.ts and mongo-restore.ts.
FROM mongo:8
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
