#!/usr/bin/env bash
# Dumps the Clavix database to one gzip archive with a sha256 sidecar.
#
#   MONGO_URI=mongodb://... scripts/mongo-backup.sh [out-dir]
#   docker compose -f deploy/compose.yml --profile tools run --rm backup
#
# MONGO_URI    required, with the database in its path (as the API reads it).
# KEEP         archives to keep in out-dir (default 14); older ones are removed.
# MONGODUMP    the mongodump binary (default: mongodump).
# The archive holds the tenants' ENCRYPTED signing keys: it is useless without
# CLAVIX_KEYS_MASTER_KEY, which is never in the archive. Keep both, apart.
set -euo pipefail

out="${1:-./backups}"
: "${MONGO_URI:?MONGO_URI is required}"
keep="${KEEP:-14}"
dump="${MONGODUMP:-mongodump}"

mkdir -p "$out"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out/clavix-$stamp.archive.gz"
tmp="$file.partial"
trap 'rm -f "$tmp"' EXIT

"$dump" --uri="$MONGO_URI" --archive="$tmp" --gzip --quiet
mv "$tmp" "$file"
(cd "$out" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256")

# Retention: the newest $keep archives stay.
# shellcheck disable=SC2012
ls -1t "$out"/clavix-*.archive.gz 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done

echo "$file"
