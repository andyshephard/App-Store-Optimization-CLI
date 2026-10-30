import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDbForTests } from "../db/store";
import { listPlayAppKeywords } from "../db/play-keywords";
import { collectKeywords, runTrackCommand } from "./play-commands";

const TEST_DB_PATH = path.join(os.tmpdir(), `aso-play-cmd-${process.pid}-${Date.now()}.sqlite`);
const KEYWORD_FILE = path.join(os.tmpdir(), `aso-play-cmd-${process.pid}.txt`);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("play commands", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
    process.env.ASO_PLAY_COUNTRIES = "US,GB";
    fs.writeFileSync(KEYWORD_FILE, "# seed\nHistory\n\n  stoicism  \nhistory\n");
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    fs.unlinkSync(KEYWORD_FILE);
    delete process.env.ASO_DB_PATH;
    delete process.env.ASO_PLAY_COUNTRIES;
  });

  it("collects keywords from the argument and a file, skipping comments and duplicates", () => {
    expect(collectKeywords("chunks, Chunks App", KEYWORD_FILE)).toEqual([
      "chunks",
      "chunks app",
      "history",
      "stoicism",
    ]);
  });

  it("tracks and untracks Google Play keywords per country", () => {
    runTrackCommand({
      action: "track",
      platform: "android",
      keywords: ["history", "stoicism"],
      countries: "us,GB",
      appId: "com.andyshephard.chunks",
    });
    expect(listPlayAppKeywords().map((r) => `${r.country}:${r.keyword}`)).toEqual([
      "GB:history",
      "GB:stoicism",
      "US:history",
      "US:stoicism",
    ]);
    runTrackCommand({
      action: "untrack",
      platform: "android",
      keywords: ["history"],
      countries: "US",
      appId: "com.andyshephard.chunks",
    });
    expect(listPlayAppKeywords({ country: "US" }).map((r) => r.keyword)).toEqual(["stoicism"]);
  });

  it("refuses a Play country that is not enabled, and a missing package", () => {
    expect(() =>
      runTrackCommand({ action: "track", platform: "android", keywords: ["x"], countries: "AU", appId: "a.b" })
    ).toThrow(/AU is not enabled/);
    expect(() =>
      runTrackCommand({ action: "track", platform: "android", keywords: ["x"], countries: "US" })
    ).toThrow(/ASO_PLAY_APP_ID/);
    expect(() =>
      runTrackCommand({ action: "track", platform: "android", keywords: ["x"], countries: "US", appId: "../etc" })
    ).toThrow(/not a valid Google Play package/);
    expect(() =>
      runTrackCommand({ action: "track", platform: "android", keywords: ["y".repeat(101)], countries: "US", appId: "a.b" })
    ).toThrow(/at most 100/);
  });
});
