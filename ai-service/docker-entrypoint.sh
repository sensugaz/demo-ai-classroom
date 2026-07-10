#!/bin/sh
set -eu

# Named volumes created by older releases may be root-owned. Repair only the
# generated-image cache, then drop privileges before starting the service.
mkdir -p /tmp/flashcard-images
chown -R app:app /tmp/flashcard-images

exec gosu app "$@"
