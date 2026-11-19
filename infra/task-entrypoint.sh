#!/bin/sh
# Fargate mounts the writable volumes owned by root, mode 755. The task user cannot
# create a directory there. This starts as root only long enough to open /tmp and
# /work, then becomes uid 10001 with no capabilities. A container that is already
# that user (local compose, the image default) runs the process directly.
set -eu
if [ "$(id -u)" = 0 ]; then
  chmod 1777 /tmp /work
  exec setpriv --reuid=10001 --regid=10001 --clear-groups \
    --inh-caps=-all --bounding-set=-all --no-new-privs \
    node /app/dist/index.js
fi
exec node /app/dist/index.js
