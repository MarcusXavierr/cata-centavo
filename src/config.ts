import { isAbsolute, join } from "node:path";

/**
 * Configuration comes from the environment and nowhere else (ADR §4, amended
 * 2026-07-25). Environment *variables*, never a `.env` file: §16.2 records the
 * prior implementation auto-loading one from the current working directory,
 * which under `npx` is wherever the user happened to be standing.
 */

const APP_DIR = "cata-centavo";

/**
 * 8-4-4-4-12 hex, deliberately looser than a real UUID check. The point is to
 * catch a truncated or mis-pasted id before it costs a network round trip, not
 * to assert a UUID version we have never verified Pluggy emits.
 */
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOW_TO_SET =
  'Export it in your shell, or declare it in the "env" block of your MCP client config — a client that spawns this server does not read your shell profile.';

export type Env = Readonly<Record<string, string | undefined>>;

export type Credentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type Config = {
  readonly credentials: Credentials;
  readonly itemIds: readonly string[];
};

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validates the environment into a `Config`, collecting every problem rather
 * than stopping at the first — a user missing two variables should learn that
 * in one run.
 *
 * Failure is a return value. Nothing here throws and nothing calls
 * `process.exit`: `init` and `doctor` exist to report exactly these conditions
 * and cannot report one that kills the process (ADR §16.2).
 *
 * Hand-written rather than a Zod schema because the messages *are* the feature
 * here (§14.6), and Zod's generic issue text would have to be replaced anyway.
 * Zod earns its keep on the wire bodies in `pluggy/wire.ts`, where the shape is
 * deep and the inference matters.
 */
export function loadConfig(env: Env): ConfigResult {
  const problems: string[] = [];

  const clientId = readRequired(env, "PLUGGY_CLIENT_ID", problems);
  const clientSecret = readRequired(env, "PLUGGY_CLIENT_SECRET", problems);
  const itemIds = readItemIds(env, problems);

  if (clientId === undefined || clientSecret === undefined || problems.length > 0) {
    return { ok: false, problems };
  }

  return { ok: true, config: { credentials: { clientId, clientSecret }, itemIds } };
}

function readRequired(env: Env, name: string, problems: string[]): string | undefined {
  const value = env[name]?.trim();

  if (value === undefined || value === "") {
    problems.push(`${name} is missing or empty. ${HOW_TO_SET}`);
    return undefined;
  }

  return value;
}

function readItemIds(env: Env, problems: string[]): readonly string[] {
  const name = "PLUGGY_ITEM_IDS";
  const raw = env[name]?.trim();

  if (raw === undefined || raw === "") {
    problems.push(
      `${name} is missing or empty. It holds the connection ids from your MeuPluggy dashboard, separated by commas. ${HOW_TO_SET}`,
    );
    return [];
  }

  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

  if (ids.length === 0) {
    problems.push(`${name} lists no ids, only separators.`);
    return [];
  }

  problems.push(...idProblems(name, ids));

  return ids;
}

/** Both problems are reported, because a list can be malformed *and* repeat itself. */
function idProblems(name: string, ids: readonly string[]): readonly string[] {
  const problems: string[] = [];

  const malformed = ids.filter((id) => !ITEM_ID.test(id));
  if (malformed.length > 0) {
    problems.push(`${name} has ${malformed.length} entry that is not a connection id: ${malformed.join(", ")}`);
  }

  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    problems.push(`${name} lists a duplicate id: ${duplicates.join(", ")}`);
  }

  return problems;
}

export type System = {
  readonly platform: string;
  readonly home: string;
};

export type Paths = {
  readonly cacheDb: string;
  readonly dataDb: string;
  readonly logFile: string;
};

/**
 * The two files of ADR §10. `npx` runs from an arbitrary directory, so nothing
 * lives in the cwd.
 *
 * `cache.db` is droppable and rebuilt from Pluggy; `data.db` holds work the
 * user cannot get back. They are deliberately in different XDG roots so an `rm`
 * aimed at the cache cannot reach the other one.
 */
export function resolvePaths(env: Env, system: System): Paths {
  const darwin = system.platform === "darwin";

  let cacheFallback: string;
  let dataFallback: string;
  let stateFallback: string;
  if (darwin) {
    cacheFallback = join(system.home, "Library", "Caches");
    dataFallback = join(system.home, "Library", "Application Support");
    stateFallback = join(system.home, "Library", "Logs");
  } else {
    cacheFallback = join(system.home, ".cache");
    dataFallback = join(system.home, ".local", "share");
    stateFallback = join(system.home, ".local", "state");
  }

  const cacheHome = xdgHome(env, "XDG_CACHE_HOME", cacheFallback);
  const dataHome = xdgHome(env, "XDG_DATA_HOME", dataFallback);
  const stateHome = xdgHome(env, "XDG_STATE_HOME", stateFallback);

  return {
    cacheDb: join(cacheHome, APP_DIR, "cache.db"),
    dataDb: join(dataHome, APP_DIR, "data.db"),
    logFile: join(stateHome, APP_DIR, "cata-centavo.log"),
  };
}

/** The XDG spec says a relative path in one of these variables must be ignored. */
function xdgHome(env: Env, name: string, fallback: string): string {
  const value = env[name];
  if (value !== undefined && isAbsolute(value)) {
    return value;
  }
  return fallback;
}
