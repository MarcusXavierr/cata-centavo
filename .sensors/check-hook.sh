#!/usr/bin/env bash
#
# `sensors check` as a Stop hook.
#
# The two protocols collide on the number 2. `sensors check` means "no state, is
# the sidecar running?"; a hook means "block, and read this back to the agent".
# Mapping them straight through would stop every turn in a repo where nobody
# started the sidecar, so the translation happens here:
#
#   sensors 0  all pass          -> 0  say nothing
#   sensors 1  a sensor failed   -> 2  block, report on stderr
#   sensors 3  below threshold   -> 2  block, report on stderr
#   sensors 2  no state          -> 0  never block on a sidecar nobody started
#
# See .claude/settings.json for the registration and CLAUDE.md for the workflow.

set -uo pipefail

payload=$(cat)

# Claude sets this on the retry after a Stop hook blocked. Blocking twice on the
# same turn is a loop, not a signal.
case "$payload" in
  *'"stop_hook_active"'*true*) exit 0 ;;
esac

# Through cli.sh, never a bare `sensors`: on Fedora that name also belongs to
# lm_sensors, which answers `check <dir>` with a parse error and exit 1 — and
# this hook would faithfully translate that into blocking every turn with a
# complaint about chip names.
project="${CLAUDE_PROJECT_DIR:-$PWD}"
output=$(bash "$(dirname "$0")/cli.sh" check "$project" 2>&1)

# 127 is cli.sh reporting the sidecar is not installed, which is not this hook's
# business to complain about.
case $? in
  0 | 2 | 127) exit 0 ;;
esac

printf '%s\n' "$output" >&2
exit 2
