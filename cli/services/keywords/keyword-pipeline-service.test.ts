import { KeywordPipelineService } from "./keyword-pipeline-service";
import { getKeywords } from "../../db/aso-keywords";
import type { StoredAsoKeyword } from "../../db/types";
import { fetchKeywordPopularitiesPreferringAdsApi } from "./aso-popularity-source";
import { keywordWriteRepository } from "./keyword-write-repository";
import { refreshAsoKeywordOrderLocal } from "./aso-local-cache-service";
import { AsoAuthReauthRequiredError } from "./aso-popularity-service";

jest.mock("../../db/aso-keywords", () => ({
  getKeywords: jest.fn(),
}));
jest.mock("./aso-popularity-source", () => ({
  fetchKeywordPopularitiesPreferringAdsApi: jest.fn(),
}));
jest.mock("./keyword-write-repository", () => ({
  keywordWriteRepository: {
    upsertPopularityOnly: jest.fn(),
    upsertKeywordItems: jest.fn(),
    persistFailures: jest.fn(),
    clearFailures: jest.fn(),
  },
}));
jest.mock("./aso-local-cache-service", () => ({
  enrichAsoKeywordsLocal: jest.fn(),
  lookupAsoCacheLocal: jest.fn(),
  refreshAsoKeywordOrderLocal: jest.fn(),
}));

const getKeywordsMock = getKeywords as jest.MockedFunction<typeof getKeywords>;
const fetchPopularityMock = jest.mocked(fetchKeywordPopularitiesPreferringAdsApi);
const refreshOrderLocalMock = jest.mocked(refreshAsoKeywordOrderLocal);
const writeRepo = jest.mocked(keywordWriteRepository);

const HOUR_MS = 60 * 60 * 1000;

function storedKeyword(
  keyword: string,
  overrides: Partial<StoredAsoKeyword> = {}
): StoredAsoKeyword {
  const now = Date.now();
  return {
    keyword,
    normalizedKeyword: keyword,
    country: "US",
    popularity: 40,
    difficultyScore: 30,
    minDifficultyScore: 20,
    isBrandKeyword: false,
    appCount: 100,
    keywordMatch: "none",
    orderedAppIds: ["1"],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    orderExpiresAt: new Date(now + 24 * HOUR_MS).toISOString(),
    popularityExpiresAt: new Date(now + 720 * HOUR_MS).toISOString(),
    ...overrides,
  } as StoredAsoKeyword;
}

describe("KeywordPipelineService.refreshStartup", () => {
  let service: KeywordPipelineService;
  let run: jest.SpyInstance;
  let refreshOrder: jest.SpyInstance;
  let enrichAndPersist: jest.SpyInstance;

  const expiredPopularity = () => ({
    popularityExpiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
  });

  beforeEach(() => {
    service = new KeywordPipelineService();
    run = jest
      .spyOn(service, "run")
      .mockResolvedValue({ items: [], failedKeywords: [], filteredOut: [] });
    refreshOrder = jest
      .spyOn(service, "refreshOrderWithFailures")
      .mockImplementation(async (_country, keywords) => ({
        items: keywords.map((keyword) => ({ keyword }) as never),
        failedKeywords: [],
      }));
    enrichAndPersist = jest
      .spyOn(service, "enrichAndPersist")
      .mockImplementation(async (_country, items) => ({
        items: items.map((item) => ({ keyword: item.keyword }) as never),
        failedKeywords: [],
      }));
    fetchPopularityMock.mockResolvedValue({ popularities: {}, failedKeywords: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("refreshes only the ranking for keywords whose popularity is still fresh", async () => {
    getKeywordsMock.mockReturnValue([storedKeyword("meditation")]);

    const result = await service.refreshStartup(
      "US",
      [{ keyword: "meditation", popularity: 40 }],
      { force: true }
    );

    expect(refreshOrder).toHaveBeenCalledWith("US", ["meditation"]);
    expect(fetchPopularityMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("refreshes an expired popularity and fully re-enriches the keyword", async () => {
    getKeywordsMock.mockReturnValue([
      storedKeyword("meditation", expiredPopularity()),
    ]);
    fetchPopularityMock.mockResolvedValue({
      popularities: { meditation: 55 },
      failedKeywords: [],
    });

    const result = await service.refreshStartup(
      "US",
      [{ keyword: "meditation", popularity: 40 }],
      { force: true }
    );

    expect(writeRepo.upsertPopularityOnly).toHaveBeenCalledWith(
      "US",
      [{ keyword: "meditation", popularity: 55 }],
      { preserveUpdatedAt: true }
    );
    expect(enrichAndPersist).toHaveBeenCalledWith("US", [
      { keyword: "meditation", popularity: 55 },
    ]);
    expect(refreshOrder).not.toHaveBeenCalled();
    expect(result.popularityFailures).toEqual([]);
  });

  it("still refreshes the ranking when the popularity fetch fails, and reports it separately", async () => {
    // The production failure: a failed popularity fetch dropped the keyword
    // from the batch, so its rank never refreshed and updatedAt froze.
    getKeywordsMock.mockReturnValue([
      storedKeyword("fresh"),
      storedKeyword("stale", expiredPopularity()),
      storedKeyword("missing", expiredPopularity()),
    ]);
    fetchPopularityMock.mockResolvedValue({
      popularities: {},
      failedKeywords: [
        {
          keyword: "stale",
          stage: "popularity",
          reasonCode: "HTTP_500",
          message: "boom",
          retryable: true,
          attempts: 3,
        },
      ],
    });

    const result = await service.refreshStartup(
      "GB",
      [
        { keyword: "fresh", popularity: 40 },
        { keyword: "stale", popularity: 40 },
        { keyword: "missing", popularity: 40 },
      ],
      { force: true }
    );

    expect(refreshOrder).toHaveBeenCalledWith("GB", ["fresh", "stale", "missing"]);
    expect(enrichAndPersist).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(3);
    expect(result.failedKeywords).toEqual([]);
    expect(result.popularityFailures.map((f) => [f.keyword, f.reasonCode])).toEqual([
      ["missing", "POPULARITY_MISSING"],
      ["stale", "HTTP_500"],
    ]);
    expect(writeRepo.upsertPopularityOnly).not.toHaveBeenCalled();
  });

  it("refreshes rankings and flags reauthentication when the popularity session is dead", async () => {
    getKeywordsMock.mockReturnValue([
      storedKeyword("stale", expiredPopularity()),
    ]);
    const reauth = new AsoAuthReauthRequiredError("session expired");
    fetchPopularityMock.mockRejectedValue(reauth);

    const result = await service.refreshStartup(
      "US",
      [
        { keyword: "stale", popularity: 40 },
        { keyword: "deferred", popularity: 0 },
      ],
      { force: true }
    );

    expect(refreshOrder).toHaveBeenCalledWith("US", ["stale"]);
    expect(result.reauthError).toBe(reauth);
    expect(result.popularityFailures).toHaveLength(1);
    // A never-enriched keyword needs a score first, so it is skipped, not run.
    expect(run).not.toHaveBeenCalled();
    expect(result.skippedKeywords).toEqual(["deferred"]);
  });

  it("falls back to the ranking-only crawl when the full enrichment fails", async () => {
    getKeywordsMock.mockReturnValue([
      storedKeyword("stale", expiredPopularity()),
    ]);
    fetchPopularityMock.mockResolvedValue({
      popularities: { stale: 50 },
      failedKeywords: [],
    });
    enrichAndPersist.mockResolvedValue({
      items: [],
      failedKeywords: [
        {
          keyword: "stale",
          stage: "enrichment",
          reasonCode: "INSUFFICIENT_DOCS",
          message: "x",
          retryable: true,
          attempts: 1,
        },
      ],
    });

    const result = await service.refreshStartup(
      "US",
      [{ keyword: "stale", popularity: 40 }],
      { force: true }
    );

    expect(refreshOrder).toHaveBeenCalledWith("US", ["stale"]);
    expect(result.items).toHaveLength(1);
    expect(writeRepo.clearFailures).toHaveBeenCalledWith("US", ["stale"]);
  });

  it("returns ranking failures instead of swallowing them", async () => {
    getKeywordsMock.mockReturnValue([storedKeyword("a"), storedKeyword("b")]);
    refreshOrder.mockRestore();
    refreshOrderLocalMock.mockImplementation(async (_country, keyword) => {
      if (keyword === "b") {
        throw Object.assign(new Error("Keyword order unavailable"), {
          code: "EMPTY_ORDER",
        });
      }
      return {
        keyword,
        normalizedKeyword: keyword,
        appCount: 2,
        orderedAppIds: ["9", "8"],
      };
    });

    const result = await service.refreshStartup(
      "US",
      [
        { keyword: "a", popularity: 40 },
        { keyword: "b", popularity: 40 },
      ],
      { force: true }
    );

    expect(result.items.map((item) => item.keyword)).toEqual(["a"]);
    expect(result.failedKeywords).toEqual([
      expect.objectContaining({ keyword: "b", reasonCode: "EMPTY_ORDER" }),
    ]);
    // Only the keyword that was actually crawled is written; "b" keeps its
    // previous order and updatedAt.
    const written = writeRepo.upsertKeywordItems.mock.calls.flatMap(
      ([, items]) => items.map((item) => item.keyword)
    );
    expect(written).toEqual(["a"]);
    // Order failures do not mark the stored keyword as failed in the API.
    expect(writeRepo.persistFailures).not.toHaveBeenCalled();
  });

  it("does the ranking-only work when the Apple session is unavailable", async () => {
    getKeywordsMock.mockReturnValue([
      storedKeyword("fresh"),
      storedKeyword("stale", expiredPopularity()),
    ]);

    await service.refreshStartup(
      "US",
      [
        { keyword: "fresh", popularity: 40 },
        { keyword: "stale", popularity: 40 },
      ],
      { force: true, skipPopularity: true }
    );

    expect(run).not.toHaveBeenCalled();
    expect(fetchPopularityMock).not.toHaveBeenCalled();
    expect(refreshOrder).toHaveBeenCalledWith("US", ["fresh", "stale"]);
  });

  it("skips a never-enriched keyword when the session is unavailable, since it has no score yet", async () => {
    getKeywordsMock.mockReturnValue([]);

    const result = await service.refreshStartup(
      "US",
      [{ keyword: "deferred", popularity: 0 }],
      { force: true, skipPopularity: true }
    );

    expect(run).not.toHaveBeenCalled();
    expect(refreshOrder).not.toHaveBeenCalled();
    expect(result.skippedKeywords).toEqual(["deferred"]);
  });

  it("sends a never-enriched keyword through the full pipeline and keeps its failures", async () => {
    getKeywordsMock.mockReturnValue([]);
    run.mockResolvedValue({
      items: [],
      failedKeywords: [
        {
          keyword: "deferred",
          stage: "popularity",
          reasonCode: "POPULARITY_MISSING",
          message: "x",
          retryable: true,
          attempts: 1,
        },
      ],
      filteredOut: [],
    });

    const result = await service.refreshStartup(
      "US",
      [{ keyword: "deferred", popularity: 0 }],
      { force: true }
    );

    expect(run).toHaveBeenCalledWith("US", ["deferred"], {
      allowInteractiveAuthRecovery: false,
      resolveWhenAllFail: true,
    });
    expect(refreshOrder).not.toHaveBeenCalled();
    expect(result.failedKeywords).toHaveLength(1);
  });

  it("treats a fresh keyword as a cache hit when not forced", async () => {
    getKeywordsMock.mockReturnValue([storedKeyword("fresh")]);

    const result = await service.refreshStartup("US", [
      { keyword: "fresh", popularity: 40 },
    ]);

    expect(refreshOrder).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });
});
