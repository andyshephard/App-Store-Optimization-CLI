import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { jest } from "@jest/globals";
import { getKeyword, upsertKeywords } from "../../db/aso-keywords";
import { closeDbForTests } from "../../db/store";
import { asoAppleGet } from "../cache-api/services/aso-apple-client";
import { enrichKeyword } from "../cache-api/services/aso-enrichment-service";
import { fetchKeywordPopularitiesPreferringAdsApi } from "./aso-popularity-source";
import { keywordPipelineService } from "./keyword-pipeline-service";
import {
  __resetRunLookupCacheForTests,
  lookupCacheHitCount,
  withObservationRun,
} from "./observation-context";

// Only the network edges are faked: Apple HTTP (MZSearch and iTunes lookup)
// and the Search Ads popularity source. Pipeline, cache API, enrichment and
// the SQLite store are the real ones, so every crawl path a background run
// can take is exercised as in production.
jest.mock("../cache-api/services/aso-apple-client", () => ({
  asoAppleGet: jest.fn(),
}));
jest.mock("./aso-popularity-source", () => ({
  fetchKeywordPopularitiesPreferringAdsApi: jest.fn(),
}));

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-background-refresh-lookups-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

const mockedAsoAppleGet = jest.mocked(asoAppleGet);
const mockedPopularity = jest.mocked(fetchKeywordPopularitiesPreferringAdsApi);

// 25 keywords whose top 10s overlap: keyword k's order starts at pool id
// 3k, so neighbours share 7 of their top 10. The pool wraps at 60 ids.
const POOL = 60;
const KEYWORDS = Array.from({ length: 25 }, (_, k) => `budget app ${k}`);
function orderFor(term: string): string[] {
  const k = KEYWORDS.indexOf(term);
  if (k < 0) return [];
  return Array.from({ length: 30 }, (_, i) => String(1000 + ((3 * k + i) % POOL)));
}
const UNIQUE_TOP_IDS = new Set(KEYWORDS.flatMap((keyword) => orderFor(keyword).slice(0, 10)));

function lookupRequests(): string[][] {
  return mockedAsoAppleGet.mock.calls
    .filter(([, config]) => (config as { operation?: string })?.operation === "itunes.lookup")
    .map(([, config]) => String((config as { params: { id: string } }).params.id).split(","));
}

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function seedKnownKeywords(popularityExpiresAt: string): void {
  upsertKeywords(
    "US",
    KEYWORDS.map((keyword) => ({
      keyword,
      popularity: 40,
      difficultyScore: 1,
      minDifficultyScore: 1,
      appCount: 1,
      keywordMatch: "none",
      orderedAppIds: ["999"],
      // Order still fresh: only `force` makes the rank-only path crawl it.
      orderExpiresAt: FUTURE,
      popularityExpiresAt,
    })) as never
  );
}

async function forcedRefresh(runId: number) {
  return withObservationRun(runId, () =>
    keywordPipelineService.refreshStartup(
      "US",
      KEYWORDS.map((keyword) => ({ keyword, popularity: 0 })),
      { force: true }
    )
  );
}

describe("background refresh: merged iTunes lookups on every crawl path", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
    jest.clearAllMocks();
    __resetRunLookupCacheForTests();
    delete process.env.ASO_ENRICHMENT_MODE;
    process.env.ASO_RANK_SEARCHPAGE_PREFIX = "0";
    mockedAsoAppleGet.mockImplementation((async (_url: string, config: any) => {
      if (config?.operation === "itunes.lookup") {
        const ids = String(config.params.id).split(",");
        return {
          status: 200,
          data: {
            results: ids.map((id) => ({
              kind: "software",
              trackId: Number(id),
              trackName: `App ${id}`,
              sellerName: `Seller ${id}`,
              averageUserRating: 4.5,
              userRatingCount: (Number(id) * 7919) % 250000,
            })),
          },
        };
      }
      return {
        status: 200,
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: orderFor(String(config?.params?.term ?? "")).map((id) => ({ id })),
              },
            ],
          },
        },
      };
    }) as never);
    mockedPopularity.mockImplementation((async (_country: string, keywords: string[]) => ({
      popularities: Object.fromEntries(keywords.map((keyword) => [keyword, 55])),
      failedKeywords: [],
    })) as never);
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
    delete process.env.ASO_RANK_SEARCHPAGE_PREFIX;
  });

  /** Difficulty each keyword gets when enriched on its own, outside any run. */
  async function perKeywordDifficulties(): Promise<number[]> {
    const scores: number[] = [];
    for (const keyword of KEYWORDS) {
      scores.push((await enrichKeyword({ keyword, country: "US", popularity: 55 })).difficultyScore);
    }
    return scores;
  }

  const maxLookups = Math.ceil(UNIQUE_TOP_IDS.size / 50);

  it("fixture: the batch's top 10s overlap", () => {
    expect(UNIQUE_TOP_IDS.size).toBeLessThan(KEYWORDS.length * 10);
    expect(maxLookups).toBeLessThan(KEYWORDS.length);
  });

  it("forced refresh with stale popularity (full re-enrichment) merges lookups", async () => {
    seedKnownKeywords(PAST);
    const result = await forcedRefresh(1);

    expect(result.failedKeywords).toEqual([]);
    expect(result.items).toHaveLength(KEYWORDS.length);
    const requests = lookupRequests();
    expect(requests.length).toBeLessThanOrEqual(maxLookups);
    expect(requests.every((ids) => ids.length <= 50)).toBe(true);
    expect(new Set(requests.flat()).size).toBe(requests.flat().length);

    const stored = KEYWORDS.map((keyword) => getKeyword("US", keyword)?.difficultyScore);
    expect(stored).toEqual(await perKeywordDifficulties());
  });

  it("forced refresh with fresh popularity (rank-only crawl) merges lookups", async () => {
    seedKnownKeywords(FUTURE);
    const result = await forcedRefresh(2);

    expect(mockedPopularity).not.toHaveBeenCalled();
    expect(result.failedKeywords).toEqual([]);
    expect(result.items).toHaveLength(KEYWORDS.length);
    expect(lookupRequests().length).toBeLessThanOrEqual(maxLookups);

    const stored = KEYWORDS.map((keyword) => getKeyword("US", keyword)?.difficultyScore);
    expect(stored).toEqual(await perKeywordDifficulties());
  });

  it("never-enriched keywords (catch-up of new adds) merge lookups", async () => {
    const result = await forcedRefresh(3);

    expect(result.failedKeywords).toEqual([]);
    expect(result.items).toHaveLength(KEYWORDS.length);
    expect(lookupRequests().length).toBeLessThanOrEqual(maxLookups);
  });

  it("a later batch in the same run is served from the lookup cache", async () => {
    seedKnownKeywords(FUTURE);
    await forcedRefresh(4);
    const afterFirst = lookupRequests().length;
    const hitsBefore = lookupCacheHitCount();

    await forcedRefresh(4);

    expect(lookupRequests().length).toBe(afterFirst);
    expect(lookupCacheHitCount() - hitsBefore).toBe(UNIQUE_TOP_IDS.size);
  });
});
