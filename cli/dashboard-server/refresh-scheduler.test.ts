import {
  createRefreshScheduler,
  getNextRunTimestamp,
  parseDailyTime,
} from "./refresh-scheduler";

const PRAGUE = "Europe/Prague";

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

describe("parseDailyTime", () => {
  it("accepts valid 24-hour times", () => {
    expect(parseDailyTime("04:00")).toEqual({ hours: 4, minutes: 0 });
    expect(parseDailyTime("00:00")).toEqual({ hours: 0, minutes: 0 });
    expect(parseDailyTime("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(parseDailyTime(" 9:30 ")).toEqual({ hours: 9, minutes: 30 });
  });

  it("rejects anything else, so a typo disables rather than misfires", () => {
    expect(parseDailyTime(null)).toBeNull();
    expect(parseDailyTime("")).toBeNull();
    expect(parseDailyTime("24:00")).toBeNull();
    expect(parseDailyTime("4am")).toBeNull();
    expect(parseDailyTime("04:60")).toBeNull();
  });
});

describe("getNextRunTimestamp", () => {
  const at4am = { hours: 4, minutes: 0 };

  it("picks today when the time is still ahead", () => {
    // 01:00 Prague (winter, UTC+1) on 15 Jan 2026
    const from = Date.parse("2026-01-15T00:00:00Z");
    expect(iso(getNextRunTimestamp(from, at4am, PRAGUE))).toBe(
      "2026-01-15T03:00:00.000Z"
    );
  });

  it("rolls to tomorrow once the time has passed", () => {
    // 05:00 Prague, already past 04:00
    const from = Date.parse("2026-01-15T04:00:00Z");
    expect(iso(getNextRunTimestamp(from, at4am, PRAGUE))).toBe(
      "2026-01-16T03:00:00.000Z"
    );
  });

  it("never returns the current instant", () => {
    const exactly4am = Date.parse("2026-01-15T03:00:00Z");
    expect(getNextRunTimestamp(exactly4am, at4am, PRAGUE)).toBeGreaterThan(
      exactly4am
    );
  });

  it("tracks summer time rather than drifting an hour", () => {
    // July: Prague is UTC+2, so 04:00 local is 02:00Z - an hour earlier in UTC
    // than the winter answer above. A naive +24h scheduler drifts here.
    const from = Date.parse("2026-07-15T00:00:00Z");
    expect(iso(getNextRunTimestamp(from, at4am, PRAGUE))).toBe(
      "2026-07-15T02:00:00.000Z"
    );
  });

  it("handles the spring-forward day, where 02:00-03:00 does not exist", () => {
    // Prague moves 02:00 -> 03:00 on 29 Mar 2026. 04:00 still exists.
    const from = Date.parse("2026-03-29T00:00:00Z");
    const next = getNextRunTimestamp(from, { hours: 4, minutes: 0 }, PRAGUE);
    expect(iso(next)).toBe("2026-03-29T02:00:00.000Z");
  });

  it("handles the autumn day that runs 25 hours", () => {
    // Prague moves 03:00 -> 02:00 on 25 Oct 2026.
    const from = Date.parse("2026-10-25T00:00:00Z");
    const next = getNextRunTimestamp(from, { hours: 4, minutes: 0 }, PRAGUE);
    expect(iso(next)).toBe("2026-10-25T03:00:00.000Z");
  });

  it("works for a zone ahead of UTC", () => {
    const from = Date.parse("2026-01-15T00:00:00Z");
    expect(iso(getNextRunTimestamp(from, at4am, "Asia/Tokyo"))).toBe(
      "2026-01-15T19:00:00.000Z"
    );
  });
});

describe("createRefreshScheduler", () => {
  type Timer = { id: number; callback: () => void; delayMs: number };

  function harness(options: { dailyAt: string | null; startAt: string }) {
    let now = Date.parse(options.startAt);
    const timers: Timer[] = [];
    let nextId = 1;
    const runs: string[] = [];

    const scheduler = createRefreshScheduler({
      dailyAt: options.dailyAt,
      timeZone: PRAGUE,
      run: () => {
        runs.push(new Date(now).toISOString());
      },
      now: () => now,
      setTimer: (callback, delayMs) => {
        const timer: Timer = { id: nextId++, callback, delayMs };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      },
      clearTimer: (timer) => {
        const index = timers.findIndex(
          (candidate) => candidate.id === (timer as unknown as Timer).id
        );
        if (index >= 0) timers.splice(index, 1);
      },
    });

    /** Advance to the pending timer's due time and fire it. */
    const fireNext = () => {
      const timer = timers.pop();
      if (!timer) throw new Error("no timer scheduled");
      now += timer.delayMs;
      timer.callback();
    };

    return { scheduler, runs, timers, fireNext, setNow: (v: string) => { now = Date.parse(v); } };
  }

  it("does nothing when no time is configured", () => {
    const { scheduler, timers } = harness({
      dailyAt: null,
      startAt: "2026-01-15T00:00:00Z",
    });

    scheduler.start();

    expect(timers).toHaveLength(0);
    expect(scheduler.getState().enabled).toBe(false);
  });

  it("schedules the next run and reports it", () => {
    const { scheduler } = harness({
      dailyAt: "04:00",
      startAt: "2026-01-15T00:00:00Z",
    });

    scheduler.start();

    expect(scheduler.getState()).toMatchObject({
      enabled: true,
      dailyAt: "04:00",
      timeZone: PRAGUE,
      nextRunAt: "2026-01-15T03:00:00.000Z",
      lastRunAt: null,
    });
  });

  it("runs at the due time and immediately schedules the following day", () => {
    const { scheduler, runs, fireNext } = harness({
      dailyAt: "04:00",
      startAt: "2026-01-15T00:00:00Z",
    });

    scheduler.start();
    fireNext();

    expect(runs).toEqual(["2026-01-15T03:00:00.000Z"]);
    expect(scheduler.getState().nextRunAt).toBe("2026-01-16T03:00:00.000Z");

    fireNext();
    expect(runs).toEqual([
      "2026-01-15T03:00:00.000Z",
      "2026-01-16T03:00:00.000Z",
    ]);
  });

  it("stops firing once stopped", () => {
    const { scheduler, timers } = harness({
      dailyAt: "04:00",
      startAt: "2026-01-15T00:00:00Z",
    });

    scheduler.start();
    scheduler.stop();

    expect(timers).toHaveLength(0);
    expect(scheduler.getState().nextRunAt).toBeNull();
  });

  it("survives a failing run and still schedules the next one", () => {
    let now = Date.parse("2026-01-15T00:00:00Z");
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const errors: unknown[] = [];

    const scheduler = createRefreshScheduler({
      dailyAt: "04:00",
      timeZone: PRAGUE,
      run: () => {
        throw new Error("refresh exploded");
      },
      now: () => now,
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return {} as NodeJS.Timeout;
      },
      clearTimer: () => {},
      onError: (error) => errors.push(error),
    });

    scheduler.start();
    const due = timers.pop();
    now += due!.delayMs;
    due!.callback();

    expect(errors).toHaveLength(1);
    expect(scheduler.getState().nextRunAt).toBe("2026-01-16T03:00:00.000Z");
  });
});
