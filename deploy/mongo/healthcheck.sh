#!/bin/bash
# Light healthcheck, run every 30 s: no mongosh per check (it costs a second of
# CPU each time). Healthy once entrypoint.sh's initiator has seen a primary
# (/tmp/rs-ready) and mongod accepts TCP connections on 27017.
set -eu
[ -f /tmp/rs-ready ]
exec 3<>/dev/tcp/127.0.0.1/27017
