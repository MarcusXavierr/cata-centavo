#!/usr/bin/env bash
#
# `sensors`, disambiguated.
#
# Two programs answer to that name on this machine. `/usr/bin/sensors` is
# lm_sensors, the hardware monitor Fedora installs, and it replies to
# `sensors check .` with `Parse error in chip name` and exit 1. The sidecar is
# whichever one uv put in ~/.local/bin. Which of them wins depends on PATH
# order, so in an interactive shell it works and in a service or an editor
# subprocess it does not.
#
# The discriminator is the first two bytes. The sidecar is a Python console
# script and starts with `#!`; lm_sensors is a compiled ELF binary and starts
# with \x7fELF. Cheaper than running either one to find out, and it holds for a
# pipx or venv install too, not just uv's.
#
# Everything that invokes the sidecar goes through here: .sensors/check-hook.sh,
# and you, via CLAUDE.md.

set -uo pipefail

is_the_sidecar() {
  [ -x "$1" ] && [ "$(head -c 2 "$1" 2>/dev/null)" = "#!" ]
}

resolve() {
  if [ -n "${SENSORS_BIN:-}" ]; then
    is_the_sidecar "$SENSORS_BIN" && { printf '%s' "$SENSORS_BIN"; return 0; }
  fi

  # `type -a -P`, not `command -v`: the point is to see every `sensors` on PATH,
  # not just the first, because the first is often the wrong one.
  local candidate
  for candidate in "$HOME/.local/bin/sensors" $(type -a -P sensors 2>/dev/null); do
    is_the_sidecar "$candidate" && { printf '%s' "$candidate"; return 0; }
  done

  return 1
}

if ! binary=$(resolve); then
  cat >&2 <<'MSG'
The sensors sidecar is not installed. The `sensors` on PATH is lm_sensors, the
hardware monitor, which is a different program that happens to share the name.

  uv tool install git+https://github.com/birgitta410/sensors-cli

See docs/plans/2026-07-26-sensors-sidecar-design.md.
MSG
  exit 127
fi

exec "$binary" "$@"
