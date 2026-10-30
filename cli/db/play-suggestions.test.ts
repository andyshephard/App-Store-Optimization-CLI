import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { closeDbForTests, getDb, SCHEMA_VERSION } from "./store";
import { addPlayAppKeywords } from "./play-keywords";
import { listPlaySuggestions, prunePlaySuggestions, recordPlaySuggestions } from "./play-suggestions";

const TEST_DB_PATH = path.join(os.tmpdir(), `aso-play-suggestions-${process.pid}-${Date.now()}.sqlite`);
const OURS = "com.andyshephard.chunks";
const DAY1 = "2026-10-29T03:00:00.000Z";
const DAY2 = "2026-10-30T03:00:00.000Z";

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("play_keyword_suggestions", () => {
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

  it("keeps each term's shortest prefix, its position and seed, and counts the prefixes", () => {
    recordPlaySuggestions({
      country: "US",
      prefix: "micro",
      seed: "microlearning",
      suggestions: ["microsoft teams", "micro learning courses"],
      seenAt: DAY1,
    });
    recordPlaySuggestions({
      country: "US",
      prefix: "microl",
      seed: "microlearning",
      suggestions: ["micro learning courses", "microlearning", "Microlab "],
      seenAt: DAY2,
    });

    expect(listPlaySuggestions({ country: "US", since: "2026-10-01" })).toEqual([
      expect.objectContaining({ keyword: "microsoft teams", letters: 5, position: 1, prefixCount: 1 }),
      {
        keyword: "micro learning courses",
        country: "US",
        prefix: "micro",
        letters: 5,
        position: 2,
        seed: "microlearning",
        prefixCount: 2,
        firstSeenAt: DAY1,
        lastSeenAt: DAY2,
        tracked: false,
      },
      expect.objectContaining({ keyword: "microlearning", prefix: "microl", letters: 6, position: 2 }),
      expect.objectContaining({ keyword: "microlab", prefix: "microl", letters: 6, position: 3 }),
    ]);
  });

  it("leaves out tracked terms unless asked, and terms not seen in the window", () => {
    addPlayAppKeywords(OURS, ["microlearning"], "US");
    recordPlaySuggestions({ country: "US", prefix: "microl", seed: "microlearning", suggestions: ["microlearning", "microlab"], seenAt: DAY2 });
    recordPlaySuggestions({ country: "US", prefix: "hi", seed: "history", suggestions: ["hinge"], seenAt: DAY1 });
    recordPlaySuggestions({ country: "GB", prefix: "microl", seed: "microlearning", suggestions: ["microlearning"], seenAt: DAY2 });

    expect(listPlaySuggestions({ country: "US", since: DAY2 }).map((s) => s.keyword)).toEqual(["microlab"]);
    expect(
      listPlaySuggestions({ country: "US", since: DAY1, includeTracked: true }).map((s) => [s.keyword, s.tracked])
    ).toEqual([
      ["hinge", false],
      ["microlearning", true],
      ["microlab", false],
    ]);
    // Tracked in the US only: still an idea in GB.
    expect(listPlaySuggestions({ country: "GB", since: DAY1 }).map((s) => s.keyword)).toEqual(["microlearning"]);
  });

  it("replaces a prefix's answer, keeping first_seen for terms still suggested", () => {
    recordPlaySuggestions({ country: "US", prefix: "st", seed: "stoic", suggestions: ["steam", "stoic"], seenAt: DAY1 });
    recordPlaySuggestions({ country: "US", prefix: "st", seed: "stoicism", suggestions: ["stoic", "stocks"], seenAt: DAY2 });

    expect(listPlaySuggestions({ country: "US", since: "2026-10-01" })).toEqual([
      expect.objectContaining({ keyword: "stoic", position: 1, seed: "stoicism", firstSeenAt: DAY1, lastSeenAt: DAY2 }),
      expect.objectContaining({ keyword: "stocks", position: 2, firstSeenAt: DAY2 }),
    ]);

    // An empty answer clears the prefix.
    recordPlaySuggestions({ country: "US", prefix: "st", seed: "stoic", suggestions: [], seenAt: DAY2 });
    expect(listPlaySuggestions({ country: "US", since: "2026-10-01" })).toEqual([]);
  });

  it("prunes rows not seen since the cut-off", () => {
    recordPlaySuggestions({ country: "US", prefix: "an", seed: "ancient", suggestions: ["angry birds"], seenAt: DAY1 });
    recordPlaySuggestions({ country: "US", prefix: "anc", seed: "ancient", suggestions: ["ancestry"], seenAt: DAY2 });
    expect(prunePlaySuggestions(DAY2)).toBe(1);
    expect(listPlaySuggestions({ country: "US", since: "2026-10-01" }).map((s) => s.keyword)).toEqual(["ancestry"]);
  });

  it("adds the table to a schema-5 database without touching its data", () => {
    addPlayAppKeywords(OURS, ["chunks"], "US");
    closeDbForTests();
    const legacy = new Database(TEST_DB_PATH);
    legacy.exec(`DROP TABLE play_keyword_suggestions; PRAGMA user_version = 5;`);
    legacy.close();

    expect(getDb().pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(6);
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM play_app_keywords`).get() as { n: number }).n
    ).toBe(1);
    recordPlaySuggestions({ country: "US", prefix: "ch", seed: "chunks", suggestions: ["chrome"], seenAt: DAY2 });
    expect(listPlaySuggestions({ country: "US", since: DAY1 }).map((s) => s.keyword)).toEqual(["chrome"]);
  });
});
