import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getLatestPopularityTrends,
  listKeywordPopularityHistory,
  upsertKeywordPopularityHistoryPoints,
} from "./aso-keyword-popularity-history";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-keyword-popularity-history-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("aso-keyword-popularity-history", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
  });

  it("stores weekly points keyed by normalized keyword, ascending by week", () => {
    upsertKeywordPopularityHistoryPoints([
      {
        country: "GB",
        keyword: "  Language Learning ",
        week: "2026-08-02",
        popularity: 59,
        genre: "EDUCATION",
        rankInGenre: 80,
      },
      {
        country: "GB",
        keyword: "language learning",
        week: "2026-07-26",
        popularity: 61,
      },
    ]);
    const history = listKeywordPopularityHistory("GB", "Language Learning");
    expect(history.map((point) => point.week)).toEqual([
      "2026-07-26",
      "2026-08-02",
    ]);
    expect(history[1]).toMatchObject({
      normalizedKeyword: "language learning",
      popularity: 59,
      genre: "EDUCATION",
      rankInGenre: 80,
    });
    expect(history[0].genre).toBeNull();
  });

  it("re-upserting the same week replaces the row instead of duplicating it", () => {
    const point = {
      country: "US",
      keyword: "flashcards",
      week: "2026-08-02",
      popularity: 48,
    };
    upsertKeywordPopularityHistoryPoints([point]);
    upsertKeywordPopularityHistoryPoints([{ ...point, popularity: 50 }]);
    const history = listKeywordPopularityHistory("US", "flashcards");
    expect(history).toHaveLength(1);
    expect(history[0].popularity).toBe(50);
  });

  it("computes latest/previous trends per keyword and scopes by country", () => {
    upsertKeywordPopularityHistoryPoints([
      { country: "US", keyword: "duolingo", week: "2026-07-26", popularity: 80 },
      { country: "US", keyword: "duolingo", week: "2026-08-02", popularity: 78 },
      { country: "US", keyword: "flashcards", week: "2026-08-02", popularity: 48 },
      { country: "GB", keyword: "duolingo", week: "2026-08-02", popularity: 79 },
    ]);
    const trends = getLatestPopularityTrends("US", [
      "duolingo",
      "flashcards",
      "unknown keyword",
    ]);
    expect(trends.get("duolingo")).toEqual({ latest: 78, previous: 80 });
    expect(trends.get("flashcards")).toEqual({ latest: 48, previous: null });
    expect(trends.has("unknown keyword")).toBe(false);
  });
});
