#!/usr/bin/env bash
# Load test of a production-like stack on one machine (docs/operations.md,
# "Load test"). Usage: load/run.sh <build|up|seed|k6|down|all> [OUT_DIR]
#
# The stack is deploy/compose.yml as it is (production mode, resource limits,
# one-node replica set, redis with a password), project `clavix-load`: mongo,
# redis and api only. Caddy and the ui are not started: the api is reached over
# the compose network, with the Host and X-Forwarded-* headers Caddy would send.
# Nothing is published on the host. `down` removes the containers AND the
# volumes of this project only, and the generated deploy/.env.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=${2:-$ROOT/load/out}
mkdir -p "$OUT"
P=clavix-load
ENVFILE=$ROOT/deploy/.env
dc() { docker compose -p "$P" -f deploy/compose.yml --env-file "$ENVFILE" "$@"; }

phase=${1:-all}

build() { docker build -t clavix-api:load "$ROOT"; }

up() {
  [ -e "$ENVFILE" ] && { echo "refusing to overwrite $ENVFILE"; exit 1; }
  umask 077
  cat > "$ENVFILE" <<ENV
CLAVIX_API_IMAGE=clavix-api:load
CLAVIX_UI_IMAGE=unused:never-started
CLAVIX_DOMAIN=clavix.test
ACME_EMAIL=load@clavix.test
REDIS_PASSWORD=$(openssl rand -hex 24)
MONGO_ROOT_USER=root
MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)
MONGO_APP_USER=clavix
MONGO_APP_PASSWORD=$(openssl rand -hex 24)
MONGO_KEYFILE=$(openssl rand -hex 64)
CLAVIX_KEYS_MASTER_KEY=$(openssl rand -base64 32)
CLAVIX_TLS_ASK_SECRET=$(openssl rand -hex 32)
CONSOLE_CLIENT_SECRET=pending-db-migrate
CLAVIX_SMTP_URL=smtps://load:load@smtp.invalid:465
CONSOLE_SESSION_SECRET=$(openssl rand -base64 48)
ENV
  dc up -d --wait mongo redis
  dc run --rm -T api bun run db:sync
  dc run --rm -T api bun run db:migrate
}

seed() {
  # 50 tenants, 2 refresh chains each = 100 chains, one per k6 VU of token.js.
  dc run --rm -T -v "$ROOT/load:/app/load:ro" api bun load/seed.ts | tail -n 1 > "$OUT/seed.json"
  dc up -d --wait api
  # Warm: the api builds each tenant's server on its first request.
  echo "seeded: $(bun -e 'const s=JSON.parse(await Bun.file(process.argv[1]).text());console.log(s.tenants.length,"tenants",s.tenants.length*s.tenants[0].chains.length,"chains")' "$OUT/seed.json")"
}

k6() {
  local script=$1
  docker run --rm --network "${P}_default" \
    -v "$ROOT/load:/load:ro" -v "$OUT:/out" \
    -e SEED_FILE=/out/seed.json -e BASE_URL=http://api:3000 \
    grafana/k6 run --quiet --summary-export "/out/${script%.js}.summary.json" "/load/$script" \
    2>&1 | tee "$OUT/${script%.js}.log"
}

down() {
  dc down -v --remove-orphans
  rm -f "$ENVFILE"
}

case "$phase" in
  build) build ;;
  up) up ;;
  seed) seed ;;
  k6) k6 "${3:?script}" ;;
  down) down ;;
  all) build; up; seed; k6 jwks-discovery.js; k6 token.js; down ;;
  *) echo "usage: $0 build|up|seed|k6 <out> <script>|down|all [out]"; exit 2 ;;
esac
