import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig, resolvePaths } from "../src/config.ts";

const ID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const ID_B = "bbbbbbbb-1111-2222-3333-444444444444";

const VALID = {
  PLUGGY_CLIENT_ID: "client-id",
  PLUGGY_CLIENT_SECRET: "client-secret",
  PLUGGY_ITEM_IDS: ID_A,
};

describe("loadConfig", () => {
  it("reads the three variables into a config", () => {
    const result = loadConfig({ ...VALID, PLUGGY_ITEM_IDS: `${ID_A},${ID_B}` });

    assert.equal(result.ok, true);

    let config = null;
    if (result.ok) {
      config = result.config;
    }
    assert.deepEqual(config, {
      credentials: { clientId: "client-id", clientSecret: "client-secret" },
      itemIds: [ID_A, ID_B],
    });
  });

  it("tolerates whitespace and empty entries in the id list", () => {
    const cases = [` ${ID_A} , ${ID_B} `, `${ID_A},,${ID_B}`, `${ID_A},${ID_B},`];

    for (const PLUGGY_ITEM_IDS of cases) {
      const result = loadConfig({ ...VALID, PLUGGY_ITEM_IDS });

      let itemIds = null;
      if (result.ok) {
        itemIds = result.config.itemIds;
      }
      assert.deepEqual(itemIds, [ID_A, ID_B], PLUGGY_ITEM_IDS);
    }
  });

  it("rejects the invalid shapes, naming the variable at fault", () => {
    const cases = [
      { name: "clientId missing", env: { ...VALID, PLUGGY_CLIENT_ID: undefined }, expect: /PLUGGY_CLIENT_ID/ },
      { name: "clientId empty", env: { ...VALID, PLUGGY_CLIENT_ID: "  " }, expect: /PLUGGY_CLIENT_ID/ },
      { name: "secret missing", env: { ...VALID, PLUGGY_CLIENT_SECRET: undefined }, expect: /PLUGGY_CLIENT_SECRET/ },
      { name: "ids missing", env: { ...VALID, PLUGGY_ITEM_IDS: undefined }, expect: /PLUGGY_ITEM_IDS/ },
      { name: "ids empty", env: { ...VALID, PLUGGY_ITEM_IDS: " , , " }, expect: /PLUGGY_ITEM_IDS/ },
      { name: "id not a uuid", env: { ...VALID, PLUGGY_ITEM_IDS: `${ID_A},nope` }, expect: /nope/ },
      { name: "id truncated", env: { ...VALID, PLUGGY_ITEM_IDS: ID_A.slice(0, -4) }, expect: /PLUGGY_ITEM_IDS/ },
      { name: "duplicate id", env: { ...VALID, PLUGGY_ITEM_IDS: `${ID_A},${ID_A}` }, expect: /duplicate/i },
    ];

    for (const { name, env, expect } of cases) {
      const result = loadConfig(env);
      assert.equal(result.ok, false, name);

      let problems = "";
      if (!result.ok) {
        problems = result.problems.join("\n");
      }
      assert.match(problems, expect, name);
    }
  });

  it("reports every problem at once instead of stopping at the first", () => {
    const result = loadConfig({});

    assert.equal(result.ok, false);

    let problemCount = 0;
    if (!result.ok) {
      problemCount = result.problems.length;
    }
    assert.equal(problemCount, 3);
  });

  it("never puts a secret value in a problem message", () => {
    const result = loadConfig({ ...VALID, PLUGGY_ITEM_IDS: "nope" });

    assert.equal(result.ok, false);

    let problems = "";
    if (!result.ok) {
      problems = result.problems.join("\n");
    }
    assert.doesNotMatch(problems, /client-secret/);
  });
});

describe("resolvePaths", () => {
  const home = "/home/user";

  it("honours XDG when the variables are set", () => {
    const paths = resolvePaths(
      { XDG_CACHE_HOME: "/xdg/cache", XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" },
      { platform: "linux", home },
    );

    assert.deepEqual(paths, {
      cacheDb: "/xdg/cache/cata-centavo/cache.db",
      dataDb: "/xdg/data/cata-centavo/data.db",
      logFile: "/xdg/state/cata-centavo/cata-centavo.log",
    });
  });

  it("falls back to the linux defaults when XDG is unset", () => {
    const paths = resolvePaths({}, { platform: "linux", home });

    assert.deepEqual(paths, {
      cacheDb: "/home/user/.cache/cata-centavo/cache.db",
      dataDb: "/home/user/.local/share/cata-centavo/data.db",
      logFile: "/home/user/.local/state/cata-centavo/cata-centavo.log",
    });
  });

  it("uses the macOS convention on darwin", () => {
    const paths = resolvePaths({}, { platform: "darwin", home });

    assert.deepEqual(paths, {
      cacheDb: "/home/user/Library/Caches/cata-centavo/cache.db",
      dataDb: "/home/user/Library/Application Support/cata-centavo/data.db",
      logFile: "/home/user/Library/Logs/cata-centavo/cata-centavo.log",
    });
  });

  it("ignores a relative XDG path, as the spec requires", () => {
    const paths = resolvePaths(
      { XDG_CACHE_HOME: "relative/cache", XDG_STATE_HOME: "relative/nao/absoluto" },
      { platform: "linux", home },
    );

    assert.equal(paths.cacheDb, "/home/user/.cache/cata-centavo/cache.db");
    assert.equal(paths.logFile, "/home/user/.local/state/cata-centavo/cata-centavo.log");
  });
});
