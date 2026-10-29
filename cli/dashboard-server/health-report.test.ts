import {
  buildHealthReport,
  listHealthAlertConditions,
  type HealthInputs,
} from "./health-report";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-29T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now - h * HOUR).toISOString();

function inputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    nowMs: now,
    uptimeSeconds: 100 * 3600,
    memory: { rss: 300 * 1024 * 1024, heapUsed: 100 * 1024 * 1024, heapTotal: 150 * 1024 * 1024 },
    db: { writable: true, error: null },
    enabledCountries: ["US", "GB"],
    storefrontLastSuccessAt: { US: hoursAgo(8), GB: hoursAgo(8) },
    countriesWithRunHistory: new Set(["US", "GB"]),
    keywordLastUpdatedAt: {},
    lastRun: {
      id: 4,
      trigger: "scheduled",
      status: "completed",
      startedAt: hoursAgo(8.5),
      finishedAt: hoursAgo(8),
      lastError: null,
      storefronts: [
        { country: "US", eligible: 10, refreshed: 9, failed: 1, skipped: 0, popularityFailed: 2, abandoned: false, failureReasons: { EMPTY_ORDER: 1, "popularity:HTTP_500": 2 }, finishedAt: hoursAgo(8.2) },
        { country: "GB", eligible: 5, refreshed: 5, failed: 0, skipped: 0, popularityFailed: 0, abandoned: false, failureReasons: {}, finishedAt: hoursAgo(8) },
      ],
    },
    lastFinishedRunAt: hoursAgo(8),
    currentRun: { status: "completed", trigger: "scheduled", startedAt: hoursAgo(8.5), requiresReauthentication: false },
    scheduler: { enabled: true, dailyAt: "04:00", timeZone: "Europe/Prague", nextRunAt: hoursAgo(-15), lastRunAt: hoursAgo(8.5) },
    session: { keeperEnabled: true, lastOkAt: hoursAgo(2), lastCheckAt: hoursAgo(2), ok: true, needsTwoFactor: false },
    restartLoop: { detected: false, recentStarts: 1 },
    ...overrides,
  };
}

describe("buildHealthReport", () => {
  it("reports ok with per-storefront and per-reason detail", () => {
    const report = buildHealthReport(inputs());

    expect(report.status).toBe("ok");
    expect(report.reasons).toEqual([]);
    expect(report.lastRun).toMatchObject({
      completed: true,
      eligible: 15,
      refreshed: 14,
      failed: 1,
      popularityFailed: 2,
      failuresByReason: { EMPTY_ORDER: 1, "popularity:HTTP_500": 2 },
    });
    expect(report.storefronts[0]).toMatchObject({ country: "US", stale: false, lastSuccessSource: "runs" });
    expect(report.memory.rssMb).toBe(300);
  });

  it("is degraded when one storefront has not succeeded in 30h, even though the process is fine", () => {
    const report = buildHealthReport(
      inputs({ storefrontLastSuccessAt: { US: hoursAgo(8), GB: hoursAgo(31) } })
    );

    expect(report.status).toBe("degraded");
    expect(report.reasons).toEqual(["storefront_stale:GB"]);
    expect(listHealthAlertConditions(report).find((c) => c.key === "storefront-stale")).toMatchObject({
      active: true,
      subject: expect.stringContaining("GB"),
    });
  });

  it("is degraded when no run has completed in 26h, or 2FA is needed", () => {
    const report = buildHealthReport(
      inputs({
        lastFinishedRunAt: hoursAgo(27),
        session: { keeperEnabled: true, lastOkAt: hoursAgo(40), lastCheckAt: hoursAgo(1), ok: false, needsTwoFactor: true },
      })
    );

    expect(report.reasons).toEqual(["no_completed_run_26h", "two_factor_required"]);
    expect(report.status).toBe("degraded");
  });

  it("does not count an interrupted run as completed", () => {
    const report = buildHealthReport(
      inputs({
        lastRun: { ...inputs().lastRun!, status: "interrupted", finishedAt: null },
      })
    );
    expect(report.lastRun?.completed).toBe(false);
  });

  it("falls back to keyword writes before any run history, with a grace period on a fresh process", () => {
    const report = buildHealthReport(
      inputs({
        uptimeSeconds: 600,
        storefrontLastSuccessAt: {},
        countriesWithRunHistory: new Set(),
        keywordLastUpdatedAt: { US: hoursAgo(40) },
        lastRun: null,
        lastFinishedRunAt: null,
      })
    );

    expect(report.storefronts).toEqual([
      expect.objectContaining({ country: "US", lastSuccessSource: "keywords", stale: true }),
      expect.objectContaining({ country: "GB", lastSuccessAt: null, stale: false }),
    ]);
    // No run yet, but the process has only been up ten minutes.
    expect(report.reasons).toEqual(["storefront_stale:US"]);
  });

  it("is down when the database cannot be written", () => {
    const report = buildHealthReport(
      inputs({ db: { writable: false, error: "SQLITE_READONLY" } })
    );
    expect(report.status).toBe("down");
    expect(report.reasons).toContain("db_not_writable");
  });

  it("flags a restart loop as an alert condition", () => {
    const report = buildHealthReport(
      inputs({ restartLoop: { detected: true, recentStarts: 5 } })
    );
    expect(report.status).toBe("degraded");
    expect(listHealthAlertConditions(report).find((c) => c.key === "restart-loop")?.active).toBe(true);
  });
});
