import { jest } from "@jest/globals";
import { KeywordWriteRepository } from "./keyword-write-repository";
import { getKeywords, upsertKeywords } from "../../db/aso-keywords";
import {
  getAssociationsForKeyword,
  setPreviousPosition,
} from "../../db/app-keywords";
import {
  insertAppKeywordPositionHistoryPoints,
  pruneAppKeywordPositionHistoryBefore,
} from "../../db/app-keyword-position-history";
import { getMetadataValue, setMetadataValue } from "../../db/metadata";

jest.mock("../../db/aso-keywords", () => ({
  getKeywords: jest.fn(() => []),
  upsertKeywords: jest.fn(),
}));

jest.mock("../../db/app-keywords", () => ({
  getAssociationsForKeyword: jest.fn(() => []),
  setPreviousPosition: jest.fn(),
}));

jest.mock("../../db/app-keyword-position-history", () => ({
  insertAppKeywordPositionHistoryPoints: jest.fn(),
  pruneAppKeywordPositionHistoryBefore: jest.fn(() => 0),
}));

jest.mock("../../db/metadata", () => ({
  getMetadataValue: jest.fn(() => null),
  setMetadataValue: jest.fn(),
}));

describe("keyword-write-repository", () => {
  const mockGetKeywords = jest.mocked(getKeywords);
  const mockUpsertKeywords = jest.mocked(upsertKeywords);
  const mockGetAssociationsForKeyword = jest.mocked(getAssociationsForKeyword);
  const mockSetPreviousPosition = jest.mocked(setPreviousPosition);
  const mockInsertAppKeywordPositionHistoryPoints = jest.mocked(
    insertAppKeywordPositionHistoryPoints
  );
  const mockPruneAppKeywordPositionHistoryBefore = jest.mocked(
    pruneAppKeywordPositionHistoryBefore
  );
  const mockGetMetadataValue = jest.mocked(getMetadataValue);
  const mockSetMetadataValue = jest.mocked(setMetadataValue);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-13T00:00:00.000Z"));
    mockGetKeywords.mockReturnValue([]);
    mockGetAssociationsForKeyword.mockReturnValue([]);
    mockGetMetadataValue.mockReturnValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("appends ranked history points and updates previous position baseline", () => {
    const repository = new KeywordWriteRepository();
    mockGetKeywords.mockReturnValue([
      {
        keyword: "term",
        normalizedKeyword: "term",
        country: "US",
        popularity: 50,
        difficultyScore: 40,
        minDifficultyScore: 20,
        isBrandKeyword: null,
        appCount: 100,
        keywordMatch: "none",
        orderedAppIds: ["app-1", "app-2"],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        orderExpiresAt: "2026-04-02T00:00:00.000Z",
        popularityExpiresAt: "2026-04-02T00:00:00.000Z",
      },
    ]);
    mockGetAssociationsForKeyword.mockReturnValue([
      {
        appId: "app-1",
        keyword: "term",
        country: "US",
        isFavorite: false,
        previousPosition: null,
      },
    ]);

    repository.upsertKeywordItems("US", [
      {
        keyword: "term",
        popularity: 55,
        difficultyScore: 38,
        minDifficultyScore: 19,
        isBrandKeyword: false,
        appCount: 100,
        keywordMatch: "titleExactPhrase",
        orderedAppIds: ["app-2", "app-1"],
      },
    ]);

    expect(mockSetPreviousPosition).toHaveBeenCalledWith(
      "term",
      "US",
      "app-1",
      1
    );
    expect(mockUpsertKeywords).toHaveBeenCalledTimes(1);
    expect(mockInsertAppKeywordPositionHistoryPoints).toHaveBeenCalledWith([
      {
        appId: "app-1",
        keyword: "term",
        country: "US",
        position: 2,
        capturedAt: "2026-04-13T00:00:00.000Z",
      },
    ]);
    expect(mockPruneAppKeywordPositionHistoryBefore).toHaveBeenCalledWith(
      "2026-01-13T00:00:00.000Z"
    );
    expect(mockSetMetadataValue).toHaveBeenCalledWith(
      "app-keyword-position-history-pruned-at",
      "2026-04-13T00:00:00.000Z"
    );
  });

  it("skips daily prune when prune watermark is still fresh", () => {
    const repository = new KeywordWriteRepository();
    mockGetAssociationsForKeyword.mockReturnValue([
      {
        appId: "app-1",
        keyword: "term",
        country: "US",
        isFavorite: false,
        previousPosition: null,
      },
    ]);
    mockGetMetadataValue.mockReturnValue("2026-04-12T12:00:00.000Z");

    repository.upsertKeywordItems("US", [
      {
        keyword: "term",
        popularity: 55,
        difficultyScore: 38,
        minDifficultyScore: 19,
        isBrandKeyword: false,
        appCount: 100,
        keywordMatch: "titleExactPhrase",
        orderedAppIds: ["app-1"],
      },
    ]);

    expect(mockInsertAppKeywordPositionHistoryPoints).toHaveBeenCalledTimes(1);
    expect(mockPruneAppKeywordPositionHistoryBefore).not.toHaveBeenCalled();
    expect(mockSetMetadataValue).not.toHaveBeenCalled();
  });
});
describe("upsertPopularityOnly", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAssociationsForKeyword as jest.Mock).mockReturnValue([]);
  });

  const storedKeyword = {
    keyword: "meditation",
    normalizedKeyword: "meditation",
    country: "US",
    popularity: 40,
    difficultyScore: 31,
    minDifficultyScore: 12,
    isBrandKeyword: false,
    appCount: 220,
    keywordMatch: "none",
    orderedAppIds: ["111", "222"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    orderExpiresAt: "2026-07-02T00:00:00.000Z",
    popularityExpiresAt: "2026-07-31T00:00:00.000Z",
  };

  it("carries the enrichment forward instead of blanking it", () => {
    // Popularity expires for every keyword at once, so nulling these emptied
    // the whole table until each row was re-crawled - and lost the data
    // outright for any row whose re-crawl then failed.
    (getKeywords as jest.Mock).mockReturnValue([storedKeyword]);
    const repository = new KeywordWriteRepository();

    repository.upsertPopularityOnly("US", [
      { keyword: "meditation", popularity: 55 },
    ]);

    const written = (upsertKeywords as jest.Mock).mock.calls[0][1] as Array<
      Record<string, unknown>
    >;
    expect(written[0]).toMatchObject({
      popularity: 55,
      difficultyScore: 31,
      minDifficultyScore: 12,
      appCount: 220,
      keywordMatch: "none",
      orderedAppIds: ["111", "222"],
    });
  });

  it("leaves the order TTL alone, because the ranking was not rechecked", () => {
    (getKeywords as jest.Mock).mockReturnValue([storedKeyword]);
    const repository = new KeywordWriteRepository();

    repository.upsertPopularityOnly("US", [
      { keyword: "meditation", popularity: 55 },
    ]);

    const written = (upsertKeywords as jest.Mock).mock.calls[0][1] as Array<
      Record<string, unknown>
    >;
    expect(written[0].orderExpiresAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("records no position movement, having observed no ranking", () => {
    (getKeywords as jest.Mock).mockReturnValue([storedKeyword]);
    (getAssociationsForKeyword as jest.Mock).mockReturnValue([
      { appId: "111", keyword: "meditation", country: "US" },
    ]);
    const repository = new KeywordWriteRepository();

    repository.upsertPopularityOnly("US", [
      { keyword: "meditation", popularity: 55 },
    ]);

    expect(setPreviousPosition).not.toHaveBeenCalled();
    expect(insertAppKeywordPositionHistoryPoints).not.toHaveBeenCalled();
  });

  it("still writes a keyword that has never been enriched", () => {
    (getKeywords as jest.Mock).mockReturnValue([]);
    const repository = new KeywordWriteRepository();

    repository.upsertPopularityOnly("US", [
      { keyword: "brand new", popularity: 7 },
    ]);

    const written = (upsertKeywords as jest.Mock).mock.calls[0][1] as Array<
      Record<string, unknown>
    >;
    expect(written[0]).toMatchObject({
      popularity: 7,
      difficultyScore: null,
      orderedAppIds: [],
    });
  });
});
