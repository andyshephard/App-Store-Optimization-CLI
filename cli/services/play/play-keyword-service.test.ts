import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDbForTests } from "../../db/store";
import {
  addPlayAppKeywords,
  getPlayKeyword,
  listPlayAppKeywords,
  listPlayDailyPositionHistory,
  listPlayKeywordAutocomplete,
  listPlayKeywordFailures,
  listPlayKeywordRowsForApp,
} from "../../db/play-keywords";
import { listKeywords } from "../../db/aso-keywords";
import { listAllAppKeywords } from "../../db/app-keywords";
import { refreshPlayKeywords } from "./play-keyword-service";
import { PlayContractError, type PlaySearchApp, type PlaySearchParseResult } from "./play-search-parser";

jest.mock("../telemetry/error-reporter", () => ({ reportBugsnagError: jest.fn() }));

const TEST_DB_PATH = path.join(os.tmpdir(), `aso-play-${process.pid}-${Date.now()}.sqlite`);
const OURS = "com.andyshephard.chunks";

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function app(appId: string, installs = 10_000): PlaySearchApp {
  return {
    appId,
    title: appId,
    developer: null,
    category: null,
    installs,
    installsBand: `${installs}+`,
    rating: 4.5,
    ratingCount: null,
    free: true,
    isTopCard: false,
  };
}

function results(ids: string[]): PlaySearchParseResult {
  return { layout: "list", apps: ids.map((id) => app(id)), excludedClusterApps: 0 };
}

describe("refreshPlayKeywords", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
    process.env.ASO_PLAY_COUNTRIES = "US,GB";
    process.env.ASO_PLAY_ROSTER_APP_IDS = "com.rival.app";
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
    delete process.env.ASO_PLAY_COUNTRIES;
    delete process.env.ASO_PLAY_ROSTER_APP_IDS;
  });

  it("crawls tracked keywords per country, stores ranks, history and autocomplete, and leaves iOS alone", async () => {
    addPlayAppKeywords(OURS, ["microlearning", "chunks"], "US");
    addPlayAppKeywords(OURS, ["microlearning"], "GB");
    const searched: string[] = [];
    const search = jest.fn(async (keyword: string, country: string) => {
      searched.push(`${country}:${keyword}`);
      return keyword === "chunks"
        ? results([OURS, "com.chunks.chunks"])
        : results(["com.app.smartyme", "com.rival.app", "x.y", "x.z", "x.w", OURS]);
    });
    const suggest = jest.fn(async (prefix: string) =>
      "microlearning".startsWith(prefix) && prefix.length >= 6 ? ["microlife", "microlearning"] : ["other"]
    );

    const counters = await refreshPlayKeywords({ search, suggest, force: true });

    expect(searched.sort()).toEqual(["GB:microlearning", "US:chunks", "US:microlearning"]);
    expect(counters).toMatchObject({ eligibleKeywordCount: 3, refreshedKeywordCount: 3, failedKeywordCount: 0 });
    expect(counters?.countries.map((c) => c.country)).toEqual(["US", "GB"]);

    const stored = getPlayKeyword("US", "microlearning");
    expect(stored).toMatchObject({ resultCount: 6, rankDepth: 6, layout: "list" });
    expect(stored?.orderedAppIds.indexOf(OURS)).toBe(5);
    expect(stored?.difficultyScore).toBeGreaterThanOrEqual(5);

    const rows = listPlayKeywordRowsForApp(OURS, "US");
    expect(rows.map((r) => r.normalizedKeyword)).toEqual(["chunks", "microlearning"]);

    const history = listPlayDailyPositionHistory({ since: "2000-01-01", limit: 100, offset: 0 });
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ appId: OURS, keyword: "chunks", country: "US", position: 1 }),
        expect.objectContaining({ appId: OURS, keyword: "microlearning", country: "US", position: 6 }),
        // Roster app: recorded where it ranks.
        expect.objectContaining({ appId: "com.rival.app", keyword: "microlearning", position: 2 }),
      ])
    );
    expect(history.some((p) => p.appId === "com.rival.app" && p.keyword === "chunks")).toBe(false);

    // A seventh of each country's keywords per run (at least one), oldest first.
    expect(listPlayKeywordAutocomplete("US")).toHaveLength(1);
    expect(listPlayKeywordAutocomplete("GB")).toEqual([
      expect.objectContaining({ keyword: "microlearning", lettersNeeded: 6, hintRank: 2 }),
    ]);

    // Nothing written to the App Store tables.
    expect(listKeywords("US")).toEqual([]);
    expect(listAllAppKeywords("US")).toEqual([]);
  });

  it("records previous positions across crawls", async () => {
    addPlayAppKeywords(OURS, ["history"], "US");
    const suggest = jest.fn(async () => []);
    await refreshPlayKeywords({ search: async () => results(["a.b", "c.d", OURS]), suggest, force: true, countries: ["US"] });
    await refreshPlayKeywords({ search: async () => results([OURS]), suggest, force: true, countries: ["US"] });
    expect(listPlayAppKeywords({ appId: OURS, country: "US" })[0].previousPosition).toBe(3);
  });

  it("fails per keyword softly, keeping the last good observation", async () => {
    addPlayAppKeywords(OURS, ["good", "broken"], "US");
    const suggest = jest.fn(async () => []);
    await refreshPlayKeywords({ search: async () => results([OURS]), suggest, force: true, countries: ["US"] });

    const counters = await refreshPlayKeywords({
      countries: ["US"],
      force: true,
      suggest,
      search: async (keyword) => {
        if (keyword === "broken") throw new PlayContractError("range_mismatch", "bad page");
        return results(["a.b", OURS]);
      },
    });

    expect(counters).toMatchObject({ refreshedKeywordCount: 1, failedKeywordCount: 1 });
    expect(counters?.countries[0].failureReasons).toEqual({ PLAY_CONTRACT_CHANGED: 1 });
    expect(getPlayKeyword("US", "broken")?.orderedAppIds).toEqual([OURS]);
    expect(listPlayKeywordFailures("US")).toEqual([
      expect.objectContaining({ keyword: "broken", stage: "search", reasonCode: "PLAY_CONTRACT_CHANGED", attempts: 1 }),
    ]);
    const broken = listPlayKeywordRowsForApp(OURS, "US").find((r) => r.normalizedKeyword === "broken");
    expect(broken?.failures).toHaveLength(1);
  });

  it("skips recently crawled keywords unless forced, and stops when asked", async () => {
    addPlayAppKeywords(OURS, ["a", "b"], "US");
    const suggest = jest.fn(async () => []);
    const search = jest.fn(async () => results([OURS]));
    await refreshPlayKeywords({ search, suggest, countries: ["US"] });
    expect(search).toHaveBeenCalledTimes(2);
    await refreshPlayKeywords({ search, suggest, countries: ["US"] });
    expect(search).toHaveBeenCalledTimes(2);

    let stop = false;
    const stopping = jest.fn(async () => {
      stop = true;
      return results([OURS]);
    });
    const counters = await refreshPlayKeywords({
      search: stopping,
      suggest,
      force: true,
      countries: ["US"],
      isStopRequested: () => stop,
    });
    expect(stopping).toHaveBeenCalledTimes(1);
    expect(counters?.countries[0]).toMatchObject({ eligible: 2, refreshed: 1, skipped: 1 });
  });

  it("abandons a country after ten failures in a row", async () => {
    addPlayAppKeywords(OURS, Array.from({ length: 12 }, (_, i) => `kw${i}`), "US");
    const search = jest.fn(async () => {
      throw Object.assign(new Error("Too Many Requests"), { response: { status: 429 } });
    });
    const counters = await refreshPlayKeywords({ search, suggest: async () => [], force: true, countries: ["US"] });
    expect(search).toHaveBeenCalledTimes(10);
    expect(counters?.countries[0]).toMatchObject({ abandoned: true, failed: 10, skipped: 2 });
    expect(counters?.countries[0].failureReasons).toEqual({ HTTP_429: 10 });
  });

  it("is single-flight", async () => {
    addPlayAppKeywords(OURS, ["a"], "US");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = refreshPlayKeywords({
      countries: ["US"],
      force: true,
      suggest: async () => [],
      search: async () => {
        await gate;
        return results([OURS]);
      },
    });
    expect(await refreshPlayKeywords({ countries: ["US"] })).toBeNull();
    release();
    expect(await first).not.toBeNull();
  });
});
