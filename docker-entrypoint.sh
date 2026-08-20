#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec gosu node "$@"
fi

exec "$@"
