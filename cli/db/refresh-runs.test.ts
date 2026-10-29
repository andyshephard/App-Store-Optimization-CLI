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
