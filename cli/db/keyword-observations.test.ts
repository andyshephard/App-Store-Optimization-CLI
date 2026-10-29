import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  insertKeywordObservations,
  listKeywordObservations,
  pruneKeywordObservationsBefore,
} from "./keyword-observations";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-observations-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

const row = (keyword: string, observedAt: string) => ({
  keyword,
  country: "gb",
  metric: "rank" as const,
  value: 3,
  source: "asocli/mzsearch+searchpage",
  sourceObservedAt: observedAt,
  runId: 7,
  appId: "6692632196",
  rank: 3,
  ranked: true,
  rankDepth: 240,
  appCount: 240,
  storefrontLanguage: "en-GB",
});

describe("keyword-observations", () => {
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

  it("pages forward by cursor, returning each row exactly once", () => {
    insertKeywordObservations([
      row("a", "2026-10-29T03:00:00.000Z"),
      row("b", "2026-10-29T03:01:00.000Z"),
      row("c", "2026-10-29T03:02:00.000Z"),
    ]);

    const first = listKeywordObservations({ sinceCursor: 0, limit: 2 });
    expect(first.items.map((item) => item.keyword)).toEqual(["a", "b"]);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toMatchObject({
      country: "GB",
      ranked: true,
      rankDepth: 240,
      runId: 7,
      popularityIsFloor: null,
    });

    insertKeywordObservations([row("d", "2026-10-29T03:03:00.000Z")]);
    const second = listKeywordObservations({ sinceCursor: first.nextCursor, limit: 10 });
    expect(second.items.map((item) => item.keyword)).toEqual(["c", "d"]);
    expect(second.hasMore).toBe(false);

    const empty = listKeywordObservations({ sinceCursor: second.nextCursor, limit: 10 });
    expect(empty).toEqual({ items: [], nextCursor: second.nextCursor, hasMore: false });
  });

  it("prunes by real observation time", () => {
    insertKeywordObservations([
      row("old", "2024-01-01T00:00:00.000Z"),
      row("new", "2026-10-29T00:00:00.000Z"),
    ]);
    expect(pruneKeywordObservationsBefore("2024-10-29T00:00:00.000Z")).toBe(1);
    expect(listKeywordObservations({ sinceCursor: 0, limit: 10 }).items.map((i) => i.keyword)).toEqual(["new"]);
  });
});
