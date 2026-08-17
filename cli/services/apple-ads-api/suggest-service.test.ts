import { buildKeywordSuggestions } from "./suggest-service";
import { isAppleAdsApiConfigured } from "./apple-ads-api-config";
import { fetchKeywordSuggestions } from "./keyword-suggestions-service";
import { fetchGenreTopSearchTerms } from "./search-term-popularity-service";
import { listKeywords } from "../../db/aso-keywords";

jest.mock("./apple-ads-api-config", () => ({
  isAppleAdsApiConfigured: jest.fn(),
}));
jest.mock("./keyword-suggestions-service", () => ({
  fetchKeywordSuggestions: jest.fn(),
}));
jest.mock("./search-term-popularity-service", () => ({
  fetchGenreTopSearchTerms: jest.fn(),
}));
jest.mock("../../db/aso-keywords", () => ({
  listKeywords: jest.fn(),
}));

const mockConfigured = isAppleAdsApiConfigured as jest.Mock;
const mockSuggestions = fetchKeywordSuggestions as jest.Mock;
const mockChart = fetchGenreTopSearchTerms as jest.Mock;
const mockListKeywords = listKeywords as jest.Mock;

const chartRow = (
  searchTerm: string,
  rankInGenre: number,
  searchPopularity1to100: number
) => ({
  week: "2026-08-09",
  countryOrRegion: "US",
  genre: "EDUCATION",
  searchTerm,
  rankInGenre,
  searchPopularityInGenre: searchPopularity1to100 + 5,
  searchPopularity1to100,
  searchPopularity1to5: 4,
});

describe("buildKeywordSuggestions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigured.mockReturnValue(true);
    mockListKeywords.mockReturnValue([]);
  });

  it("throws a setup error when the Ads API is not configured", async () => {
    mockConfigured.mockReturnValue(false);
    await expect(
      buildKeywordSuggestions({ appId: "1", country: "US" })
    ).rejects.toThrow(/credentials/);
  });

  it("splits results into ads targets and metadata candidates", async () => {
    mockSuggestions.mockResolvedValue([
      { text: "blinkist", popularity: 21 },
      { text: "headway", popularity: 23 },
    ]);
    mockChart.mockResolvedValue([
      chartRow("duolingo", 2, 78),
      chartRow("blinkist", 30, 60),
      chartRow("language learning", 80, 59),
    ]);
    const result = await buildKeywordSuggestions({
      appId: "6692632196",
      country: "us",
      genre: "EDUCATION",
      seeds: ["microlearning"],
    });
    expect(result.country).toBe("US");
    expect(result.adsTargets.map((t) => t.keyword)).toEqual([
      "headway",
      "blinkist",
    ]);
    // Terms Apple also recommends as bids (blinkist) are dropped from the
    // metadata list as likely brands.
    expect(result.metadataCandidates.map((c) => c.keyword)).toEqual([
      "duolingo",
      "language learning",
    ]);
    expect(mockSuggestions).toHaveBeenCalledWith("6692632196", "US", [
      "microlearning",
    ]);
  });

  it("flags keywords that are already tracked in the storefront", async () => {
    mockListKeywords.mockReturnValue([
      { normalizedKeyword: "language learning" },
    ]);
    mockSuggestions.mockResolvedValue([{ text: "headway", popularity: 23 }]);
    mockChart.mockResolvedValue([chartRow("language learning", 80, 59)]);
    const result = await buildKeywordSuggestions({
      appId: "1",
      country: "US",
      genre: "EDUCATION",
    });
    expect(result.metadataCandidates[0]).toMatchObject({
      keyword: "language learning",
      alreadyTracked: true,
    });
    expect(result.adsTargets[0].alreadyTracked).toBe(false);
  });

  it("skips the chart entirely when no genre is given", async () => {
    mockSuggestions.mockResolvedValue([]);
    const result = await buildKeywordSuggestions({ appId: "1", country: "US" });
    expect(mockChart).not.toHaveBeenCalled();
    expect(result.metadataCandidates).toEqual([]);
  });

  it("caps both lists at the limit, ads targets by popularity", async () => {
    mockSuggestions.mockResolvedValue([
      { text: "a", popularity: 10 },
      { text: "b", popularity: 30 },
      { text: "c", popularity: 20 },
    ]);
    mockChart.mockResolvedValue([
      chartRow("x", 1, 90),
      chartRow("y", 2, 80),
      chartRow("z", 3, 70),
    ]);
    const result = await buildKeywordSuggestions({
      appId: "1",
      country: "US",
      genre: "EDUCATION",
      limit: 2,
    });
    expect(result.adsTargets.map((t) => t.keyword)).toEqual(["b", "c"]);
    expect(result.metadataCandidates.map((c) => c.keyword)).toEqual(["x", "y"]);
  });
});
