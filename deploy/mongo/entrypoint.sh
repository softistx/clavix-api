#!/bin/sh
# Starts mongod for the compose file: replica set, internal auth (key file from
# $MONGO_KEYFILE), and TLS when a certificate is mounted in /etc/mongo-tls.
# Then hands over to the image's own entrypoint, which creates the root user
# (MONGO_INITDB_ROOT_*) and runs /docker-entrypoint-initdb.d on a first start.
# A background initiator waits for mongod, initiates the replica set on the
# first start, and writes /tmp/rs-ready once a primary exists: healthcheck.sh
# only reads that file and opens a TCP connection, so mongosh runs at start-up
# only, never on every check. It authenticates as root (the localhost exception
# is gone by then).
# (Shell, not Bun: it runs inside the stock mongo image.)
set -eu

: "${MONGO_KEYFILE:?set MONGO_KEYFILE (6 to 1024 base64 characters)}"
umask 077
printf '%s' "$MONGO_KEYFILE" > /etc/mongo-keyfile
chown mongodb:mongodb /etc/mongo-keyfile
chmod 400 /etc/mongo-keyfile

set -- mongod --replSet rs0 --bind_ip_all --wiredTigerCacheSizeGB 0.25 \
  --keyFile /etc/mongo-keyfile

if [ -f /etc/mongo-tls/mongo.pem ]; then
  set -- "$@" --tlsMode requireTLS \
    --tlsCertificateKeyFile /etc/mongo-tls/mongo.pem \
    --tlsCAFile /etc/mongo-tls/ca.pem \
    --tlsAllowConnectionsWithoutCertificates
fi

tls=""
if [ -f /etc/mongo-tls/mongo.pem ]; then
  tls="--tls --tlsCAFile /etc/mongo-tls/ca.pem"
fi
rm -f /tmp/rs-ready
(
  # shellcheck disable=SC2086
  until mongosh --quiet --host mongo $tls \
    -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin --eval \
    "let ok = true; try { rs.status() } catch (e) { ok = false; try { rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}) } catch (_) {} } if (!ok || !db.hello().isWritablePrimary) quit(1)" \
    >/dev/null 2>&1; do
    sleep 3
  done
  touch /tmp/rs-ready
) &

exec docker-entrypoint.sh "$@"
