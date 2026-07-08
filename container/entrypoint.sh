#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data /workspace
if [ ! -f /data/config.yaml ]; then
    cp /opt/codexio/config.container.yaml /data/config.yaml
fi
exec "$@"
