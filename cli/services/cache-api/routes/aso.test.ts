import { jest } from "@jest/globals";
import { enrichAsoKeywords } from "../keyword-cache-service";
import { enrichKeyword } from "../services/aso-enrichment-service";

jest.mock("../services/aso-enrichment-service", () => ({
  enrichKeyword: jest.fn(),
  // Ratings mode enriches the items as one batch; this stand-in delegates to
  // the per-keyword mock with the same worker limit, so the expectations
  // below still describe per-keyword behaviour.
  enrichKeywordsFromRatingsBatch: jest.fn(
    async (items: any[], options: unknown, concurrency: number) => {
      const { enrichKeyword: single } = jest.requireMock(
        "../services/aso-enrichment-service"
      ) as { enrichKeyword: (item: unknown, options: unknown) => Promise<unknown> };
      const settled: PromiseSettledResult<unknown>[] = new Array(items.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          try {
            settled[index] = { status: "fulfilled", value: await single(items[index], options) };
          } catch (reason) {
            settled[index] = { status: "rejected", reason };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker)
      );
      return settled;
    }
  ),
}));

const mockEnrichKeyword = jest.mocked(enrichKeyword);

describe("ASO routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ASO_KEYWORD_ENRICHMENT_CONCURRENCY = "4";
  });

  afterEach(() => {
    delete process.env.ASO_KEYWORD_ENRICHMENT_CONCURRENCY;
  });

  it("limits keyword enrichment concurrency and preserves result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        keyword,
        normalizedKeyword: keyword,
        popularity,
        difficultyScore: 10,
        minDifficultyScore: 5,
        isBrandKeyword: false,
        appCount: 20,
        keywordMatch: "titleAllWords",
        orderedAppIds: [],
        appDocs: [
          {
            appId: `app-${keyword}`,
            country: "US",
            name: `App ${keyword}`,
            averageUserRating: 4.5,
            userRatingCount: 100,
          },
        ],
      };
    });

    const items = Array.from({ length: 10 }, (_, index) => ({
      keyword: `kw-${index}`,
      popularity: 50,
    }));

    const repository = {
      upsertMany: jest.fn(async ({ country, items: enriched }: any) =>
        enriched.map((item: any) => ({
          ...item,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }))
      ),
    };

    const result = await enrichAsoKeywords(
      {
        country: "US",
        items,
      },
      { repository: repository as any }
    );

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(result.items.map((item) => item.keyword)).toEqual(
      items.map((item) => item.keyword)
    );
    expect(result.failedKeywords).toEqual([]);
    expect(repository.upsertMany).toHaveBeenCalledWith(
      expect.objectContaining({
        appDocs: expect.arrayContaining([
          expect.objectContaining({
            country: "US",
          }),
        ]),
      })
    );
    expect(mockEnrichKeyword).toHaveBeenCalledTimes(10);
  });

  it("isolates per-keyword enrichment failures", async () => {
    mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) => {
      if (keyword === "bad") {
        throw new Error("upstream timeout");
      }
      return {
        keyword,
        normalizedKeyword: keyword,
        popularity,
        difficultyScore: 10,
        minDifficultyScore: 5,
        isBrandKeyword: false,
        appCount: 20,
        keywordMatch: "titleAllWords",
        orderedAppIds: [],
        appDocs: [],
      };
    });
    const repository = {
      upsertMany: jest.fn(async ({ country, items: enriched }: any) =>
        enriched.map((item: any) => ({
          ...item,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }))
      ),
    };
    const result = await enrichAsoKeywords(
      {
        country: "US",
        items: [
          { keyword: "good", popularity: 50 },
          { keyword: "bad", popularity: 50 },
        ],
      },
      { repository: repository as any }
    );
    expect(result.items.map((item) => item.keyword)).toEqual(["good"]);
    expect(result.failedKeywords).toHaveLength(1);
    expect(result.failedKeywords[0]).toMatchObject({
      keyword: "bad",
      stage: "enrichment",
    });
  });

  it("surfaces INSUFFICIENT_DOCS as a retryable per-keyword enrichment failure", async () => {
    mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) => {
      if (keyword === "needs-retry") {
        const error = new Error("insufficient top docs");
        (error as Error & { code: string; statusCode: number }).code =
          "INSUFFICIENT_DOCS";
        (error as Error & { code: string; statusCode: number }).statusCode = 503;
        throw error;
      }
      return {
        keyword,
        normalizedKeyword: keyword,
        popularity,
        difficultyScore: 10,
        minDifficultyScore: 5,
        isBrandKeyword: false,
        appCount: 20,
        keywordMatch: "titleAllWords",
        orderedAppIds: [],
        appDocs: [],
      };
    });
    const repository = {
      upsertMany: jest.fn(async ({ country, items: enriched }: any) =>
        enriched.map((item: any) => ({
          ...item,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }))
      ),
    };
    const result = await enrichAsoKeywords(
      {
        country: "US",
        items: [
          { keyword: "ok", popularity: 50 },
          { keyword: "needs-retry", popularity: 50 },
        ],
      },
      { repository: repository as any }
    );

    expect(result.items.map((item) => item.keyword)).toEqual(["ok"]);
    expect(result.failedKeywords).toEqual([
      expect.objectContaining({
        keyword: "needs-retry",
        stage: "enrichment",
        reasonCode: "INSUFFICIENT_DOCS",
        retryable: true,
      }),
    ]);
  });

  describe("batched enrichment edge cases", () => {
    const enrichedFor = (keyword: string, popularity: number, extra = {}) => ({
      keyword,
      normalizedKeyword: keyword,
      popularity,
      difficultyScore: 10,
      minDifficultyScore: 5,
      isBrandKeyword: false,
      appCount: 20,
      keywordMatch: "titleAllWords",
      orderedAppIds: [],
      appDocs: [],
      ...extra,
    });
    const echoRepository = (shouldThrow: (items: any[]) => boolean = () => false) => ({
      upsertMany: jest.fn(async ({ country, items }: any) => {
        if (shouldThrow(items)) throw new Error("SQLITE_CONSTRAINT");
        return items.map((item: any) => ({
          ...item,
          normalizedKeyword: item.keyword,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: item.updatedAt ?? "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }));
      }),
    });

    it("fails only an item with an invalid popularity", async () => {
      mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) =>
        enrichedFor(keyword, popularity) as never
      );
      const result = await enrichAsoKeywords(
        {
          country: "US",
          items: [
            { keyword: "good", popularity: 50 },
            { keyword: "broken", popularity: Number.NaN },
            { keyword: "also-good", popularity: 20 },
          ],
        },
        { repository: echoRepository() as any }
      );
      expect(result.items.map((item) => item.keyword)).toEqual(["good", "also-good"]);
      expect(result.failedKeywords).toEqual([
        expect.objectContaining({ keyword: "broken", reasonCode: "INVALID_REQUEST", retryable: false }),
      ]);
      expect(mockEnrichKeyword).toHaveBeenCalledTimes(2);
    });

    it("returns per-item failures when every item is invalid", async () => {
      const result = await enrichAsoKeywords(
        { country: "US", items: [{ keyword: "broken", popularity: 101 }] },
        { repository: echoRepository() as any }
      );
      expect(result.items).toEqual([]);
      expect(result.failedKeywords.map((failure) => failure.keyword)).toEqual(["broken"]);
      expect(mockEnrichKeyword).not.toHaveBeenCalled();
    });

    it("falls back to per-keyword writes when the batch write throws", async () => {
      mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) =>
        enrichedFor(keyword, popularity) as never
      );
      const repository = echoRepository(
        (items) => items.length > 1 || items[0]?.keyword === "poison"
      );
      const result = await enrichAsoKeywords(
        {
          country: "US",
          items: [
            { keyword: "one", popularity: 10 },
            { keyword: "poison", popularity: 10 },
            { keyword: "two", popularity: 10 },
          ],
        },
        { repository: repository as any }
      );
      expect(result.items.map((item) => item.keyword)).toEqual(["one", "two"]);
      expect(result.failedKeywords).toEqual([
        expect.objectContaining({ keyword: "poison", stage: "enrichment" }),
      ]);
      expect(repository.upsertMany).toHaveBeenCalledTimes(4);
    });

    it("stamps each keyword with its own observedAt", async () => {
      mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) =>
        enrichedFor(keyword, popularity, {
          observedAt: keyword === "early" ? "2026-10-29T01:00:00.000Z" : "2026-10-29T01:05:00.000Z",
        }) as never
      );
      const repository = echoRepository();
      await enrichAsoKeywords(
        {
          country: "US",
          items: [
            { keyword: "early", popularity: 10 },
            { keyword: "late", popularity: 10 },
          ],
        },
        { repository: repository as any }
      );
      const written = (repository.upsertMany.mock.calls[0][0] as any).items;
      expect(written.map((item: any) => [item.keyword, item.updatedAt, item.positionCapturedAt])).toEqual([
        ["early", "2026-10-29T01:00:00.000Z", "2026-10-29T01:00:00.000Z"],
        ["late", "2026-10-29T01:05:00.000Z", "2026-10-29T01:05:00.000Z"],
      ]);
    });
  });
});
