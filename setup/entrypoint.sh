#!/bin/sh
set -e
if [ ! -L /workspace/setup/node_modules ] && [ ! -d /workspace/setup/node_modules ]; then
  ln -s /opt/setup-deps/node_modules /workspace/setup/node_modules
fi
exec node setup/setup.js "$@"
