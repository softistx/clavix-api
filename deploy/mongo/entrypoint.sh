#!/bin/sh
# Starts mongod for the compose file: replica set, internal auth (key file from
# $MONGO_KEYFILE), and TLS when a certificate is mounted in /etc/mongo-tls.
# Then hands over to the image's own entrypoint, which creates the root user
# (MONGO_INITDB_ROOT_*) and runs /docker-entrypoint-initdb.d on a first start.
# (Shell, not Bun: it runs inside the stock mongo image.)
set -eu

: "${MONGO_KEYFILE:?set MONGO_KEYFILE (6 to 1024 base64 characters)}"
umask 077
printf '%s' "$MONGO_KEYFILE" > /etc/mongo-keyfile
chown mongodb:mongodb /etc/mongo-keyfile
chmod 400 /etc/mongo-keyfile

set -- mongod --replSet rs0 --bind_ip_all --wiredTigerCacheSizeGB 1 \
  --keyFile /etc/mongo-keyfile

if [ -f /etc/mongo-tls/mongo.pem ]; then
  set -- "$@" --tlsMode requireTLS \
    --tlsCertificateKeyFile /etc/mongo-tls/mongo.pem \
    --tlsCAFile /etc/mongo-tls/ca.pem \
    --tlsAllowConnectionsWithoutCertificates
fi

exec docker-entrypoint.sh "$@"
