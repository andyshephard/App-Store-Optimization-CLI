import { fetchKeywordPopularitiesPreferringAdsApi } from "./aso-popularity-source";
import { asoPopularityService } from "./aso-popularity-service";
import { isAppleAdsApiConfigured } from "../apple-ads-api/apple-ads-api-config";
import { fetchSearchTermPopularitySnapshots } from "../apple-ads-api/search-term-popularity-service";
import { keywordWriteRepository } from "./keyword-write-repository";

jest.mock("./aso-popularity-service", () => ({
  asoPopularityService: {
    fetchKeywordPopularitiesWithFailures: jest.fn(),
  },
  summarizeFailedPopularityKeywords: jest.fn(),
}));
jest.mock("../apple-ads-api/apple-ads-api-config", () => ({
  isAppleAdsApiConfigured: jest.fn(),
}));
jest.mock("../apple-ads-api/search-term-popularity-service", () => ({
  fetchSearchTermPopularitySnapshots: jest.fn(),
}));
jest.mock("./keyword-write-repository", () => ({
  keywordWriteRepository: {
    persistPopularityHistory: jest.fn(),
  },
}));

const mockLegacy = asoPopularityService.fetchKeywordPopularitiesWithFailures as jest.Mock;
const mockConfigured = isAppleAdsApiConfigured as jest.Mock;
const mockSnapshots = fetchSearchTermPopularitySnapshots as jest.Mock;
const mockPersistHistory =
  keywordWriteRepository.persistPopularityHistory as jest.Mock;

const snapshot = (popularity: number) => ({
  popularity,
  week: "2026-08-02",
  genre: "EDUCATION",
  rankInGenre: 5,
  history: [
    {
      week: "2026-08-02",
      countryOrRegion: "US",
      genre: "EDUCATION",
      searchTerm: "x",
      rankInGenre: 5,
      searchPopularityInGenre: 90,
      searchPopularity1to100: popularity,
      searchPopularity1to5: 4,
    },
  ],
});

describe("fetchKeywordPopularitiesPreferringAdsApi", () => {
  beforeEach(() => {
    process.env.ASO_POPULARITY_SOURCE = "ads-api";
    jest.clearAllMocks();
  });

  afterAll(() => {
    delete process.env.ASO_POPULARITY_SOURCE;
  });

  it("passes straight through to the legacy service when not configured", async () => {
    mockConfigured.mockReturnValue(false);
    const legacyResult = { popularities: { a: 20 }, failedKeywords: [] };
    mockLegacy.mockResolvedValue(legacyResult);
    const result = await fetchKeywordPopularitiesPreferringAdsApi("US", ["a"]);
    expect(result).toBe(legacyResult);
    expect(mockSnapshots).not.toHaveBeenCalled();
    expect(mockLegacy).toHaveBeenCalledWith(["a"]);
  });

  it("forwards allowInteractiveAuthRecovery: false to the legacy service", async () => {
    mockConfigured.mockReturnValue(false);
    mockLegacy.mockResolvedValue({ popularities: {}, failedKeywords: [] });
    await fetchKeywordPopularitiesPreferringAdsApi("US", ["a"], {
      allowInteractiveAuthRecovery: false,
    });
    expect(mockLegacy).toHaveBeenCalledWith(["a"], {
      allowInteractiveAuthRecovery: false,
    });
  });

  it("uses Ads API scores for covered keywords and legacy for the rest", async () => {
    mockConfigured.mockReturnValue(true);
    mockSnapshots.mockResolvedValue(new Map([["covered", snapshot(70)]]));
    mockLegacy.mockResolvedValue({
      popularities: { longtail: 8 },
      failedKeywords: [],
    });
    const result = await fetchKeywordPopularitiesPreferringAdsApi("GB", [
      "covered",
      "longtail",
    ]);
    expect(result.popularities).toEqual({ covered: 70, longtail: 8 });
    expect(mockLegacy).toHaveBeenCalledWith(["longtail"]);
    expect(mockPersistHistory).toHaveBeenCalledWith("GB", [
      expect.objectContaining({
        keyword: "covered",
        week: "2026-08-02",
        popularity: 70,
        genre: "EDUCATION",
        rankInGenre: 5,
      }),
    ]);
  });

  it("skips the legacy call entirely when every keyword is covered", async () => {
    mockConfigured.mockReturnValue(true);
    mockSnapshots.mockResolvedValue(new Map([["covered", snapshot(70)]]));
    const result = await fetchKeywordPopularitiesPreferringAdsApi("US", [
      "covered",
    ]);
    expect(result).toEqual({
      popularities: { covered: 70 },
      failedKeywords: [],
    });
    expect(mockLegacy).not.toHaveBeenCalled();
  });

  it("keeps covered scores and fails only uncovered keywords when legacy throws", async () => {
    mockConfigured.mockReturnValue(true);
    mockSnapshots.mockResolvedValue(new Map([["covered", snapshot(70)]]));
    mockLegacy.mockRejectedValue(new Error("login failed"));
    const result = await fetchKeywordPopularitiesPreferringAdsApi("US", [
      "covered",
      "longtail",
    ]);
    expect(result.popularities).toEqual({ covered: 70 });
    expect(result.failedKeywords).toEqual([
      expect.objectContaining({
        keyword: "longtail",
        stage: "popularity",
        reasonCode: "LEGACY_POPULARITY_UNAVAILABLE",
        retryable: true,
      }),
    ]);
  });

  it("propagates a legacy error when the Ads API covered nothing", async () => {
    mockConfigured.mockReturnValue(true);
    mockSnapshots.mockResolvedValue(new Map());
    mockLegacy.mockRejectedValue(new Error("reauth required"));
    await expect(
      fetchKeywordPopularitiesPreferringAdsApi("US", ["a"])
    ).rejects.toThrow("reauth required");
  });

  it("falls back to legacy for all keywords when the Ads API call fails", async () => {
    mockConfigured.mockReturnValue(true);
    mockSnapshots.mockRejectedValue(new Error("boom"));
    const legacyResult = { popularities: { a: 20, b: 30 }, failedKeywords: [] };
    mockLegacy.mockResolvedValue(legacyResult);
    const result = await fetchKeywordPopularitiesPreferringAdsApi("US", [
      "a",
      "b",
    ]);
    expect(result).toBe(legacyResult);
    expect(mockLegacy).toHaveBeenCalledWith(["a", "b"]);
    expect(mockPersistHistory).not.toHaveBeenCalled();
  });
});

describe("fetchKeywordPopularitiesPreferringAdsApi (legacy source, the default)", () => {
  beforeEach(() => {
    delete process.env.ASO_POPULARITY_SOURCE;
    jest.clearAllMocks();
    mockConfigured.mockReturnValue(true);
  });

  it("scores from the legacy endpoint even where the Ads API covers the keyword", async () => {
    mockLegacy.mockResolvedValue({ popularities: { covered: 54, longtail: 8 }, failedKeywords: [] });
    mockSnapshots.mockResolvedValue(new Map([["covered", snapshot(70)]]));

    const result = await fetchKeywordPopularitiesPreferringAdsApi("US", ["covered", "longtail"]);

    expect(result.popularities).toEqual({ covered: 54, longtail: 8 });
    expect(result.failedKeywords).toEqual([]);
  });

  it("still records Ads API weekly history", async () => {
    mockLegacy.mockResolvedValue({ popularities: { covered: 54 }, failedKeywords: [] });
    mockSnapshots.mockResolvedValue(new Map([["covered", snapshot(70)]]));

    await fetchKeywordPopularitiesPreferringAdsApi("US", ["covered"]);

    expect(mockPersistHistory).toHaveBeenCalledWith(
      "US",
      [expect.objectContaining({ keyword: "covered", popularity: 70 })]
    );
  });

  it("fills a keyword the legacy call failed from the Ads API", async () => {
    const failure = {
      keyword: "covered",
      stage: "popularity",
      reasonCode: "X",
      message: "failed",
      retryable: true,
      attempts: 1,
    };
    mockLegacy.mockResolvedValue({ popularities: {}, failedKeywords: [failure] });
    mockSnapshots.mockResolvedValue(new Map([["covered", snapshot(70)]]));

    const result = await fetchKeywordPopularitiesPreferringAdsApi("US", ["covered"]);

    expect(result.popularities).toEqual({ covered: 70 });
    expect(result.failedKeywords).toEqual([]);
  });

  it("returns the legacy result unchanged when the Ads API errors", async () => {
    const legacyResult = { popularities: { a: 12 }, failedKeywords: [] };
    mockLegacy.mockResolvedValue(legacyResult);
    mockSnapshots.mockRejectedValue(new Error("ads api down"));

    await expect(fetchKeywordPopularitiesPreferringAdsApi("US", ["a"])).resolves.toBe(legacyResult);
  });

  it("propagates legacy errors so reauth signals reach the surfaces", async () => {
    const reauth = new Error("reauth required");
    mockLegacy.mockRejectedValue(reauth);

    await expect(fetchKeywordPopularitiesPreferringAdsApi("US", ["a"])).rejects.toBe(reauth);
    expect(mockSnapshots).not.toHaveBeenCalled();
  });
});
