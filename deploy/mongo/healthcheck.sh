#!/bin/sh
# Healthy once the replica set has a primary. Initiates the set on the first
# start. Authenticates as root (the localhost exception is gone by then).
set -eu

tls=""
if [ -f /etc/mongo-tls/mongo.pem ]; then
  tls="--tls --tlsCAFile /etc/mongo-tls/ca.pem"
fi

# shellcheck disable=SC2086
exec mongosh --quiet --host mongo $tls \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin --eval \
  "try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}).ok }"
