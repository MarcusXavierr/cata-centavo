#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1090
[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"

wanted="$(cat "$here/.nvmrc")"
if ! nvm use --silent "$wanted" >/dev/null 2>&1; then
  echo "cata-centavo: node $wanted is required. Run 'nvm install' in $here." >&2
  exit 1
fi

# Fill only what the environment did not supply. An MCP client may pass a
# variable through as an empty string, which must not count as "set".
if [ -f "$here/.env.local" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    value="${value%\"}"; value="${value#\"}"
    if [ -z "${!key:-}" ]; then export "$key=$value"; fi
  done < "$here/.env.local"
fi

exec node "$here/src/bin/cata-centavo.ts" "$@"
