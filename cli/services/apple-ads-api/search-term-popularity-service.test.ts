import { fetchSearchTermPopularitySnapshots } from "./search-term-popularity-service";
import { appleAdsApiPost } from "./apple-ads-api-client";

jest.mock("./apple-ads-api-client", () => ({
  appleAdsApiPost: jest.fn(),
}));

const mockPost = appleAdsApiPost as jest.MockedFunction<typeof appleAdsApiPost>;

const row = (overrides: Partial<Record<string, unknown>>) => ({
  week: "2026-08-02",
  countryOrRegion: "US",
  genre: "EDUCATION",
  searchTerm: "duolingo",
  rankInGenre: 2,
  searchPopularityInGenre: 97,
  searchPopularity1to100: 78,
  searchPopularity1to5: 4,
  ...overrides,
});

describe("fetchSearchTermPopularitySnapshots", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("returns the latest week's country-wide score and full history", async () => {
    mockPost.mockResolvedValueOnce({
      result: {
        rows: [
          row({ week: "2026-07-26", searchPopularity1to100: 80 }),
          row({ week: "2026-08-02", searchPopularity1to100: 78 }),
        ],
      },
      pagination: null,
    });
    const snapshots = await fetchSearchTermPopularitySnapshots("us", [
      "Duolingo",
    ]);
    const snapshot = snapshots.get("Duolingo");
    expect(snapshot).toMatchObject({
      popularity: 78,
      week: "2026-08-02",
      genre: "EDUCATION",
      rankInGenre: 2,
    });
    expect(snapshot?.history.map((point) => point.week)).toEqual([
      "2026-07-26",
      "2026-08-02",
    ]);
    const body = mockPost.mock.calls[0][1] as {
      filters: Array<{ field: string; value: unknown }>;
    };
    expect(body.filters).toEqual([
      { field: "countryOrRegion", operator: "EQUALS", value: "US" },
      { field: "searchTerm", operator: "IN", value: ["duolingo"] },
    ]);
  });

  it("keeps the best-ranked genre row when a term charts in several genres", async () => {
    mockPost.mockResolvedValueOnce({
      result: {
        rows: [
          row({ genre: "REFERENCE", rankInGenre: 40, searchPopularity1to100: 70 }),
          row({ genre: "EDUCATION", rankInGenre: 2, searchPopularity1to100: 78 }),
        ],
      },
      pagination: null,
    });
    const snapshots = await fetchSearchTermPopularitySnapshots("US", [
      "duolingo",
    ]);
    expect(snapshots.get("duolingo")).toMatchObject({
      genre: "EDUCATION",
      rankInGenre: 2,
      popularity: 78,
    });
    expect(snapshots.get("duolingo")?.history).toHaveLength(1);
  });

  it("omits keywords absent from the dataset", async () => {
    mockPost.mockResolvedValueOnce({ result: { rows: [] }, pagination: null });
    const snapshots = await fetchSearchTermPopularitySnapshots("US", [
      "microlearning",
    ]);
    expect(snapshots.size).toBe(0);
  });

  it("splits large keyword sets into batches", async () => {
    mockPost.mockResolvedValue({ result: { rows: [] }, pagination: null });
    const keywords = Array.from({ length: 201 }, (_, i) => `keyword ${i}`);
    await fetchSearchTermPopularitySnapshots("US", keywords);
    expect(mockPost).toHaveBeenCalledTimes(2);
    const firstBatch = (
      mockPost.mock.calls[0][1] as {
        filters: Array<{ field: string; value: string[] }>;
      }
    ).filters[1].value;
    expect(firstBatch).toHaveLength(200);
  });
});
