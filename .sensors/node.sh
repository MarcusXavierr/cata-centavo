#!/usr/bin/env bash
#
# Runs a command under the Node this project declares.
#
# The sidecar is a daemon: it inherits the PATH of whichever shell started it,
# and keeps it for hours. This machine's default node is v18, where the failure
# is silent — `npm test` reports "# tests 0" and exits 0 (CLAUDE.md). Sourcing
# nvm here means a sensor cannot report green from the wrong runtime.
#
# tools/test-sensor.js checks the major version as well. Belt and braces: this
# script fixes the version, that one refuses to lie about it.

set -euo pipefail

# shellcheck disable=SC1090,SC1091
[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"

nvm use --silent >/dev/null 2>&1 || true

exec "$@"
