import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  countRefreshRunsSince,
  finishRefreshRun,
  getLatestFinishedRefreshRun,
  getLatestRefreshRun,
  insertRefreshRun,
  listRefreshRunStorefronts,
  listStorefrontLastSuccessAt,
  markUnfinishedRefreshRunsInterrupted,
  pruneRefreshRuns,
  upsertRefreshRunStorefront,
} from "./refresh-runs";
import Database from "better-sqlite3";
import { closeDbForTests, getDb, SCHEMA_VERSION } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-refresh-runs-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function storefront(country: string, overrides: Record<string, unknown> = {}) {
  return {
    country,
    eligible: 10,
    refreshed: 8,
    failed: 2,
    skipped: 0,
    popularityFailed: 1,
    abandoned: false,
    failureReasons: { EMPTY_ORDER: 2 },
    startedAt: "2026-10-28T03:00:00.000Z",
    finishedAt: "2026-10-28T03:05:00.000Z",
    ...overrides,
  };
}

describe("refresh-runs", () => {
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

  it("stamps the schema version on a new database", () => {
    expect(getDb().pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("upgrades an existing pre-v1 database without touching its data", () => {
    // Build a database as the previous release left it: every older table,
    // real keyword data, user_version 0 and no refresh tables.
    getDb();
    closeDbForTests();
    const legacy = new Database(TEST_DB_PATH);
    legacy.exec(`
      DROP TABLE refresh_run_storefronts;
      DROP TABLE refresh_runs;
      PRAGMA user_version = 0;
      INSERT INTO aso_keywords (
        country, normalized_keyword, keyword, popularity, difficulty_score,
        min_difficulty_score, is_brand_keyword, app_count, keyword_match,
        ordered_app_ids, created_at, updated_at, order_expires_at, popularity_expires_at
      ) VALUES (
        'GB', 'meditation', 'meditation', 41, 55, 50, 0, 240, 'none',
        '["1","2","3"]', '2026-01-01T00:00:00.000Z', '2026-10-27T03:10:00.000Z',
        '2026-10-28T03:10:00.000Z', '2026-11-20T00:00:00.000Z'
      );
      INSERT INTO app_keywords (app_id, keyword, country, is_favorite, previous_position, added_at)
        VALUES ('6692632196', 'meditation', 'GB', 1, 7, '2026-01-01T00:00:00.000Z');
      INSERT INTO metadata (key, value, updated_at)
        VALUES ('dashboard:scheduled-refresh:last-run-at', '2026-10-27T03:00:00.000Z', '2026-10-27T03:00:00.000Z');
    `);
    const snapshot = (db: Database.Database) => ({
      keywords: db.prepare("SELECT * FROM aso_keywords ORDER BY normalized_keyword").all(),
      appKeywords: db.prepare("SELECT * FROM app_keywords").all(),
      metadata: db.prepare("SELECT * FROM metadata").all(),
    });
    const before = snapshot(legacy);
    expect(legacy.pragma("user_version", { simple: true })).toBe(0);
    legacy.close();

    const upgraded = getDb();

    expect(upgraded.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(snapshot(upgraded)).toEqual(before);
    expect(before.keywords).toHaveLength(1);
    // The new tables exist and work.
    const id = insertRefreshRun({ trigger: "scheduled", startedAt: "2026-10-29T03:00:00.000Z" });
    expect(getLatestRefreshRun()?.id).toBe(id);

    // Opening again is a no-op.
    closeDbForTests();
    expect(snapshot(getDb())).toEqual(before);
    expect(getLatestRefreshRun()?.id).toBe(id);
  });

  it("records a run, its storefronts and its completion", () => {
    const id = insertRefreshRun({
      trigger: "scheduled",
      startedAt: "2026-10-28T03:00:00.000Z",
    });
    upsertRefreshRunStorefront(id, storefront("US"));
    upsertRefreshRunStorefront(id, storefront("GB", { refreshed: 0, failed: 10, abandoned: true }));
    // Re-saving a storefront updates it rather than duplicating it.
    upsertRefreshRunStorefront(id, storefront("US", { refreshed: 9, failed: 1 }));
    finishRefreshRun(id, {
      status: "completed",
      finishedAt: "2026-10-28T03:20:00.000Z",
      counters: { refreshedKeywordCount: 9 },
      lastError: null,
    });

    expect(getLatestRefreshRun()).toMatchObject({
      id,
      status: "completed",
      trigger: "scheduled",
      finishedAt: "2026-10-28T03:20:00.000Z",
      counters: { refreshedKeywordCount: 9 },
    });
    expect(listRefreshRunStorefronts(id)).toEqual([
      expect.objectContaining({ country: "US", refreshed: 9, failed: 1, failureReasons: { EMPTY_ORDER: 2 } }),
      expect.objectContaining({ country: "GB", abandoned: true }),
    ]);
    // An abandoned storefront is not a success.
    expect(listStorefrontLastSuccessAt()).toEqual({
      US: "2026-10-28T03:05:00.000Z",
    });
  });

  it("marks runs left running by a dead process as interrupted", () => {
    const finished = insertRefreshRun({ trigger: "scheduled", startedAt: "2026-10-27T03:00:00.000Z" });
    finishRefreshRun(finished, {
      status: "completed",
      finishedAt: "2026-10-27T03:20:00.000Z",
      counters: {},
      lastError: null,
    });
    const dead = insertRefreshRun({ trigger: "scheduled", startedAt: "2026-10-28T03:00:00.000Z" });

    expect(markUnfinishedRefreshRunsInterrupted()).toBe(1);
    expect(getLatestRefreshRun(["scheduled", "catch-up"])).toMatchObject({
      id: dead,
      status: "interrupted",
      finishedAt: null,
    });
    expect(getLatestFinishedRefreshRun()?.id).toBe(finished);
  });

  it("counts runs by trigger since a time and prunes old ones", () => {
    insertRefreshRun({ trigger: "catch-up", startedAt: "2026-10-27T01:00:00.000Z" });
    insertRefreshRun({ trigger: "catch-up", startedAt: "2026-10-28T01:00:00.000Z" });
    insertRefreshRun({ trigger: "manual", startedAt: "2026-10-28T02:00:00.000Z" });

    expect(countRefreshRunsSince("catch-up", "2026-10-28T00:00:00.000Z")).toBe(1);
    expect(pruneRefreshRuns("2026-10-28T00:00:00.000Z")).toBe(1);
    expect(countRefreshRunsSince("catch-up", "2000-01-01T00:00:00.000Z")).toBe(1);
  });
});
