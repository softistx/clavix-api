#!/usr/bin/env bash
# Restores a scripts/mongo-backup.sh archive.
#
#   CONFIRM=yes MONGO_URI=mongodb://... scripts/mongo-restore.sh <archive> [target-db]
#   CONFIRM=yes docker compose -f deploy/compose.yml --profile tools run --rm restore /backups/<archive>
#
# Without CONFIRM=yes nothing is touched. The target database is the one in
# MONGO_URI unless target-db is given (a drill restores into a scratch name,
# e.g. clavix-drill, and leaves production alone). Collections are dropped and
# recreated from the archive (--drop). Stop the api first when restoring over
# the live database (docs/operations.md, "Restore").
# MONGORESTORE  the mongorestore binary (default: mongorestore).
set -euo pipefail

archive="${1:?usage: mongo-restore.sh <archive> [target-db]}"
: "${MONGO_URI:?MONGO_URI is required}"
restore="${MONGORESTORE:-mongorestore}"

if [[ ! -f "$archive" ]]; then
  echo "no such archive: $archive" >&2
  exit 1
fi
if [[ -f "$archive.sha256" ]]; then
  (cd "$(dirname "$archive")" && sha256sum --check --quiet "$(basename "$archive").sha256") \
    || { echo "checksum mismatch: $archive is damaged" >&2; exit 1; }
fi

# The database the archive was taken from, and the one it goes to.
path="${MONGO_URI#*://}"; path="${path#*/}"; source_db="${path%%\?*}"
target_db="${2:-$source_db}"
if [[ -z "$source_db" ]]; then
  echo "MONGO_URI must name the database in its path" >&2
  exit 1
fi
# The URI without its database: mongorestore takes the namespaces from the flags.
base="${MONGO_URI%%\?*}"; base="${base%/"$source_db"}"
query=""; [[ "$MONGO_URI" == *\?* ]] && query="?${MONGO_URI#*\?}"

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "would restore $archive into database '$target_db' (dropping its collections)." >&2
  echo "run again with CONFIRM=yes to do it." >&2
  exit 2
fi

"$restore" --uri="$base/$query" --archive="$archive" --gzip --drop \
  --nsInclude="$source_db.*" --nsFrom="$source_db.*" --nsTo="$target_db.*"
echo "restored $archive into $target_db"
