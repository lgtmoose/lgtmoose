#!/bin/sh
# Fargate mounts /tmp and /work owned by root, mode 755. Started as root, this opens them
# and becomes uid 10001 with no capabilities. tini is then pid 1 and reaps the agent CLIs.
# The platform init stays off: it would keep running as root with the capabilities used here.
# A container that is already uid 10001 (the image default) skips the drop.
set -eu
if [ "$(id -u)" = 0 ]; then
  chmod 1777 /tmp /work
  exec /usr/bin/setpriv --reuid=10001 --regid=10001 --clear-groups \
    --inh-caps=-all --bounding-set=-all --no-new-privs \
    -- /usr/bin/tini -g -- /usr/local/bin/node /app/dist/index.js "$@"
fi
exec /usr/bin/tini -g -- /usr/local/bin/node /app/dist/index.js "$@"
