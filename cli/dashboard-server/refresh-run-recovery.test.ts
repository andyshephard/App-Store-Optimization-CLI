import {
  decideInterruptedRunCatchUp,
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
});
