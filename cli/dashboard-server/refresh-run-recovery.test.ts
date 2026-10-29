import {
  decideInterruptedRunCatchUp,
  isCatchUpCapReached,
  isRestartLoop,
  recordProcessStart,
  recoverInterruptedScheduledRun,
} from "./refresh-run-recovery";

describe("refresh-run-recovery", () => {
  const now = Date.parse("2026-10-29T05:00:00.000Z");

  it("does nothing when the last scheduled run finished", () => {
    expect(
      decideInterruptedRunCatchUp({
        lastScheduledRun: { id: 3, status: "completed" },
        catchUpsInLastDay: 0,
        maxCatchUpsPerDay: 2,
      })
    ).toEqual({ action: "none" });
    expect(
      decideInterruptedRunCatchUp({
        lastScheduledRun: null,
        catchUpsInLastDay: 0,
        maxCatchUpsPerDay: 2,
      })
    ).toEqual({ action: "none" });
  });

  it("catches up an interrupted scheduled run once", () => {
    const startCatchUp = jest.fn(() => true);
    const countCatchUpsSince = jest.fn(() => 0);

    const decision = recoverInterruptedScheduledRun({
      getLastScheduledRun: () => ({ id: 7, status: "interrupted" }),
      countCatchUpsSince,
      maxCatchUpsPerDay: 2,
      startCatchUp,
      now: () => now,
    });

    expect(decision).toEqual({ action: "catch-up", interruptedRunId: 7 });
    expect(startCatchUp).toHaveBeenCalledTimes(1);
    expect(countCatchUpsSince).toHaveBeenCalledWith("2026-10-28T05:00:00.000Z");
  });

  it("stops catching up once the daily cap is reached, so a crashing crawl cannot loop", () => {
    const startCatchUp = jest.fn(() => true);
    const onSuppressed = jest.fn();

    const decision = recoverInterruptedScheduledRun({
      // The catch-up itself was interrupted too.
      getLastScheduledRun: () => ({ id: 9, status: "interrupted" }),
      countCatchUpsSince: () => 2,
      maxCatchUpsPerDay: 2,
      startCatchUp,
      onSuppressed,
      now: () => now,
    });

    expect(decision).toEqual({
      action: "suppressed",
      interruptedRunId: 9,
      catchUpsInLastDay: 2,
    });
    expect(startCatchUp).not.toHaveBeenCalled();
    expect(onSuppressed).toHaveBeenCalledWith(decision);
  });

  it("treats a cap of 0 as catch-up disabled", () => {
    expect(
      decideInterruptedRunCatchUp({
        lastScheduledRun: { id: 1, status: "interrupted" },
        catchUpsInLastDay: 0,
        maxCatchUpsPerDay: 0,
      }).action
    ).toBe("suppressed");
  });

  it("detects a restart loop from recent process starts", () => {
    let starts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      starts = recordProcessStart(starts, now + i * 60_000);
    }
    expect(isRestartLoop(starts)).toBe(false);
    starts = recordProcessStart(starts, now + 4 * 60_000);
    expect(isRestartLoop(starts)).toBe(true);
    // Starts older than the window drop out: a deploy a day later is not a loop.
    expect(recordProcessStart(starts, now + 24 * 60 * 60_000)).toHaveLength(1);
  });

  it("does not count starts that follow a clean stop (deploys, config changes)", () => {
    let starts: string[] = [];
    // Six deploys in an hour: each start follows a SIGTERM.
    for (let i = 0; i < 6; i += 1) {
      starts = recordProcessStart(starts, now + i * 10 * 60_000, true);
    }
    expect(isRestartLoop(starts)).toBe(false);
    // Crashes still count, alongside the deploys.
    for (let i = 0; i < 4; i += 1) {
      starts = recordProcessStart(starts, now + 61 * 60_000 + i * 60_000);
    }
    expect(isRestartLoop(starts)).toBe(true);
  });

  it("lets a detected restart loop decay as the starts age out of the window", () => {
    let starts: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      starts = recordProcessStart(starts, now + i * 60_000);
    }
    // No further starts: the same log, read later, no longer counts.
    expect(isRestartLoop(starts, now + 5 * 60_000)).toBe(true);
    expect(isRestartLoop(starts, now + 3 * 60 * 60_000)).toBe(false);
  });

  it("clears the catch-up cap once the scheduled run completes or catch-ups age out", () => {
    const interrupted = { id: 9, status: "interrupted" };
    expect(
      isCatchUpCapReached({ lastScheduledRun: interrupted, catchUpsInLastDay: 2, maxCatchUpsPerDay: 2 })
    ).toBe(true);
    // Next night's scheduled run completed.
    expect(
      isCatchUpCapReached({
        lastScheduledRun: { id: 10, status: "completed" },
        catchUpsInLastDay: 2,
        maxCatchUpsPerDay: 2,
      })
    ).toBe(false);
    // The catch-ups fell out of the 24h window.
    expect(
      isCatchUpCapReached({ lastScheduledRun: interrupted, catchUpsInLastDay: 0, maxCatchUpsPerDay: 2 })
    ).toBe(false);
  });

  it("does not call catch-up disabled by configuration a restart loop", () => {
    expect(
      isCatchUpCapReached({
        lastScheduledRun: { id: 9, status: "interrupted" },
        catchUpsInLastDay: 0,
        maxCatchUpsPerDay: 0,
      })
    ).toBe(false);
  });
});
