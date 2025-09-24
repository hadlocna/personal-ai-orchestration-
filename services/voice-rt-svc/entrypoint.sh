#!/bin/sh
set -e

# If Render has overridden the Docker command to 'npm ci', run it then start the service.
if [ "$1" = "npm" ] && [ "$2" = "ci" ]; then
  echo "[entrypoint] Detected dockerCommand 'npm ci'. Installing deps, then starting service."
  npm ci || true
  exec node src/index.js
fi

# If no command provided, run the default server
if [ -z "$1" ]; then
  exec node src/index.js
fi

# Otherwise, exec the provided command
exec "$@"

