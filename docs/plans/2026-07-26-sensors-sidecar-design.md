# The sensors sidecar

Status: implemented 2026-07-26. The fifth entry in the series that `2026-07-26-eslint-and-logging-design.md` opened, and the first that does not add a sensor.

## What it answers that nothing else does

The four sensors this project already has (ESLint, dependency-cruiser, Stryker, coverage) each report well. They report when someone types their name. Between two `npm run lint` invocations the project has no opinion about itself, and the reports are gone as soon as the terminal scrolls.

Böckeler's article is about the reports. The repository beside it, `birgitta410/sensors-cli`, is about the gap between them:

> The agent checks status via `sensors check`, receiving a filtered summary rather than raw tool output.

That is what it buys. Eight runners on their own intervals in one background process, state and score history on disk, and one command that answers with a table instead of six tool invocations' worth of output. An agent that has just edited `src/pluggy/transport.ts` learns that the type checker broke without anybody thinking to ask it.

## What it is not

Not a dependency. `sensors` is a Python tool installed globally with `uv tool install git+https://github.com/birgitta410/sensors-cli`, and nothing in `package.json` knows it exists. The seven-devDependency budget ADR §5 defends is untouched, and a clone with no sidecar installed builds, tests and ships exactly as before.

Not a gate either. CI stays `typecheck → lint → deps → test → coverage → build`. The sidecar runs while somebody is writing code, and its history lives on one machine.

## The runners

| name | parser | mode | interval |
|---|---|---|---|
| `tests` | `default` (via `tools/test-sensor.js`) | interval | 8s |
| `lint` | `eslint` | interval | 11s |
| `types` | `tsc` | interval | 17s |
| `structure` | `depcruise` | interval | 23s |
| `cov` | `default` (via `tools/coverage-sensor.js`) | interval | 41s |
| `security` | `semgrep` | interval | 97s |
| `mutation` | `stryker` | triggered | — |
| `mut_state` | none | on_check | — |

The whole set costs under eight seconds of CPU: typecheck 1.75s, lint 3.6s, deps 0.9s, test 0.9s, coverage 1.45s. The intervals are staggered anyway, because two sensors on the same tick make both slower than either is worth and staggering costs nothing to arrange.

`mutation` is triggered because a full run is 48 seconds and `2026-07-26-mutation-testing-design.md` already settled that it reports rather than gates. Worth knowing: the sidecar fires triggered runners once at startup, so `start` pays those 48 seconds whether or not anybody wanted a fresh score. `mut_state` reads the last report on every check, so the score reaches an agent without Stryker running again.

`security` is the one genuinely new sensor. Semgrep's `p/typescript` and `p/javascript` rulesets, on a two-minute interval, against `src/`.

## Two parsers this project had to supply

The sidecar ships readers for vitest and pytest. ADR §7 rejected both, so `node --test` and Node's LCOV output arrive through the `default` parser, which reads the first JSON object on stdout. Two wrappers, no dependency.

`tools/test-sensor.js` does one thing a bare `npm test` cannot. CLAUDE.md opens on the trap: under Node 18 the suite prints `# tests 0` and exits 0, which reads as green. A daemon inherits the PATH of whichever shell started it and keeps it for hours, so this is the likeliest way the sidecar could lie. The wrapper reads the required major from `.nvmrc` and refuses to report success below it; a run that found no tests fails for the same reason.

`tools/coverage-sensor.js` parses `coverage/lcov.info` and reports line coverage as its score, rounded to a whole number. The sidecar types a score as an integer and throws away the entire reading otherwise, which stayed hidden for as long as coverage kept landing on `97` by luck. The tenth survives in the metrics, which are typed as floats. It never fails. `2026-07-26-coverage-reports.md` set no thresholds on purpose, and a sidecar is a poor place to reintroduce one through the back door. Its findings are a ranking rather than a bar — the files that still have uncovered lines, worst first, up to five. On a fully covered tree there are none.

## The root configs were not copied

The upstream `sensors_config-typescript` skill says to copy `eslint.config.js`, `.dependency-cruiser.js` and `stryker.config.json` into `.sensors/maintainability/`. That instruction is written for a project with no configs yet.

Here it would produce a second `eslint.config.js` that CI never reads, and the first time the two drifted the sidecar would go green on rules the build does not enforce. That is a sensor reporting on a codebase that does not exist. The runners call the existing npm scripts and the root configs instead.

ESLint is the one place this costs something. The sidecar's parser wants JSON; `tools/eslint-formatter-agent.js` writes prose grouped by rule. Rather than choose, both formatters exist and share `tools/eslint-guidance.js`, so the advice an agent receives through `lint:sensor` is the advice a human reads in the terminal.

## The Stop hook

The article is blunt about the alternative:

> Via guides: markdown instructions asking agents to check sensors regularly (least reliable).

`.claude/settings.json` registers `.sensors/check-hook.sh` on `Stop`. It exists because the two protocols collide on the number 2. To `sensors check` it means "no state, is the sidecar running?"; to a hook it means "block, and read this back to the agent":

| `sensors check` | meaning | hook |
|---|---|---|
| 0 | all pass | 0, silent |
| 1 | a runner failed | 2, report on stderr |
| 3 | below threshold | 2, report on stderr |
| 2 | no state | 0, silent |

Mapping the last one straight through would stop every turn in a checkout where nobody started the sidecar. Everything here fails in that direction: a sensor nobody started never blocks anybody.

`stop_hook_active` short-circuits the whole thing. Blocking twice on one turn is a loop, not a signal.

## Three things that bit, all Linux

**`AF_UNIX path too long.`** The control plane is a Unix socket at `<project>/.sensors/<config>.sock`, and the kernel caps that path at 108 bytes. The repository root is comfortably short; a scratch directory under `/tmp/claude-*/…` is not, and the daemon dies at `sock.bind` with no log. Worth knowing before checking out into a deeply nested worktree.

**`sensors` is already taken.** On Fedora, `/usr/bin/sensors` is lm_sensors, the hardware monitor, from a package most desktops have installed. Asked to `sensors check <dir>` it answers `Parse error in chip name` and exits 1, which the hook would have translated, faithfully, into blocking every turn with a complaint about chip names.

The name resolves to whichever comes first in PATH, and on this machine `~/.local/bin` sits at position 18 against `/usr/bin` at 30. So it works in an interactive shell and fails in anything with a sanitized environment, which is the worst possible failure pattern: intermittent, and correlated with nobody watching.

`.sensors/cli.sh` is the single answer. It walks `$SENSORS_BIN`, then `~/.local/bin/sensors`, then every `sensors` on PATH via `type -a -P`, and takes the first one whose leading two bytes are `#!`. The sidecar is a Python console script and has a shebang; lm_sensors is ELF. That is cheaper than running either to find out, and it works for a pipx or venv install too. Everything goes through it — the hook, CLAUDE.md, you. Upstream never hit this; macOS has no lm_sensors.

**Nothing else did.** Upstream warns the control plane is tested only on macOS. Unix domain sockets are native on Linux and the daemon, the RPC and `sensors check` all worked first try on Fedora 39 once the path was short enough.

## Day one

Eight runners, all green. Coverage 97% of lines and 90.9% of branches, mutation score 78.27%, no lint findings, no dependency violations, no semgrep findings. A check costs one tool call and about forty lines.
