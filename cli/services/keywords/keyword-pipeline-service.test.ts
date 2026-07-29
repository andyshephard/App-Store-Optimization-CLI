import { KeywordPipelineService } from "./keyword-pipeline-service";
import { getKeywords } from "../../db/aso-keywords";
import type { StoredAsoKeyword } from "../../db/types";

jest.mock("../../db/aso-keywords", () => ({
  getKeywords: jest.fn(),
}));

const getKeywordsMock = getKeywords as jest.MockedFunction<typeof getKeywords>;

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

describe("KeywordPipelineService.refreshStartup with force", () => {
  let service: KeywordPipelineService;
  let run: jest.SpyInstance;
  let refreshOrder: jest.SpyInstance;

  beforeEach(() => {
    service = new KeywordPipelineService();
    run = jest
      .spyOn(service, "run")
      .mockResolvedValue({ items: [], failedKeywords: [], filteredOut: [] });
    refreshOrder = jest.spyOn(service, "refreshOrder").mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("refreshes only the ranking for keywords whose popularity is still fresh", async () => {
    getKeywordsMock.mockReturnValue([storedKeyword("meditation")]);

    await service.refreshStartup(
      "US",
      [{ keyword: "meditation", popularity: 40 }],
      {
        force: true,
      }
    );

    expect(refreshOrder).toHaveBeenCalledWith("US", ["meditation"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("routes a keyword with expired popularity through the full pipeline", async () => {
    // refreshOrder copies the stored popularity verbatim, so an expired score
    // would freeze forever if a forced pass sent every known keyword there.
    getKeywordsMock.mockReturnValue([
      storedKeyword("meditation", {
        popularityExpiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    ]);

    await service.refreshStartup(
      "US",
      [{ keyword: "meditation", popularity: 40 }],
      {
        force: true,
      }
    );

    expect(run).toHaveBeenCalledWith("US", ["meditation"], {
      allowInteractiveAuthRecovery: false,
    });
    expect(refreshOrder).not.toHaveBeenCalled();
  });

  it("splits a mixed batch so neither group is dropped", async () => {
    getKeywordsMock.mockReturnValue([
      storedKeyword("fresh"),
      storedKeyword("stale", {
        popularityExpiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    ]);

    await service.refreshStartup(
      "US",
      [
        { keyword: "fresh", popularity: 40 },
        { keyword: "stale", popularity: 40 },
      ],
      { force: true }
    );

    expect(run).toHaveBeenCalledWith("US", ["stale"], {
      allowInteractiveAuthRecovery: false,
    });
    expect(refreshOrder).toHaveBeenCalledWith("US", ["fresh"]);
  });

  it("sends a never-enriched keyword through the full pipeline, not refreshOrder", async () => {
    getKeywordsMock.mockReturnValue([]);

    await service.refreshStartup(
      "US",
      [{ keyword: "deferred", popularity: 0 }],
      {
        force: true,
      }
    );

    expect(run).toHaveBeenCalledWith("US", ["deferred"], {
      allowInteractiveAuthRecovery: false,
    });
    expect(refreshOrder).not.toHaveBeenCalled();
  });
});
