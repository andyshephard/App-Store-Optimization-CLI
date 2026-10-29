/**
 * Startup recovery for a scheduled refresh that a restart cut short.
 *
 * The scheduler already catches up an occurrence that was *missed* (the
 * process was down at the scheduled minute). It could not see one that
 * *started* and then died - OOM, deploy, host reboot - because it records the
 * fire time before running. That run left yesterday's data in place for a
 * whole day with nothing saying so. Runs are now persisted (db/refresh-runs),
 * so on startup a scheduled run that never finished is re-run once.
 *
 * If the crawl itself is what kills the process, re-running it on every start
 * is a crash loop, so catch-ups are capped per 24h and the cap is reported.
 */

export type InterruptedRunCatchUpDecision =
  | { action: "none" }
  | { action: "catch-up"; interruptedRunId: number }
  | {
      action: "suppressed";
      interruptedRunId: number;
      catchUpsInLastDay: number;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Triggers whose interruption warrants a catch-up. Manual runs are not re-run. */
export const SCHEDULED_RUN_TRIGGERS = ["scheduled", "catch-up"];

export function decideInterruptedRunCatchUp(params: {
  lastScheduledRun: { id: number; status: string } | null;
  catchUpsInLastDay: number;
  maxCatchUpsPerDay: number;
}): InterruptedRunCatchUpDecision {
  const run = params.lastScheduledRun;
  if (!run || run.status !== "interrupted") return { action: "none" };
  if (params.catchUpsInLastDay >= params.maxCatchUpsPerDay) {
    return {
      action: "suppressed",
      interruptedRunId: run.id,
      catchUpsInLastDay: params.catchUpsInLastDay,
    };
  }
  return { action: "catch-up", interruptedRunId: run.id };
}

type RecoveryDeps = {
  getLastScheduledRun: () => { id: number; status: string } | null;
  countCatchUpsSince: (sinceIso: string) => number;
  maxCatchUpsPerDay: number;
  /** Starts a forced catch-up run; returns false when one is already running. */
  startCatchUp: () => boolean;
  now?: () => number;
  onSuppressed?: (decision: InterruptedRunCatchUpDecision) => void;
};

/**
 * Call after the scheduler has started: if it already fired its own catch-up
 * for a missed occurrence, `startCatchUp` returns false and nothing doubles up.
 */
export function recoverInterruptedScheduledRun(
  deps: RecoveryDeps
): InterruptedRunCatchUpDecision {
  const now = deps.now?.() ?? Date.now();
  const decision = decideInterruptedRunCatchUp({
    lastScheduledRun: deps.getLastScheduledRun(),
    catchUpsInLastDay: deps.countCatchUpsSince(
      new Date(now - DAY_MS).toISOString()
    ),
    maxCatchUpsPerDay: deps.maxCatchUpsPerDay,
  });
  if (decision.action === "catch-up") {
    deps.startCatchUp();
  } else if (decision.action === "suppressed") {
    deps.onSuppressed?.(decision);
  }
  return decision;
}

/** Starts within this window that count towards a restart loop. */
export const RESTART_LOOP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** This many starts inside the window is a loop, not a deploy. */
export const RESTART_LOOP_THRESHOLD = 4;

/**
 * Appends this start to the recent-start log and returns the trimmed log.
 * A start that follows a clean stop (SIGTERM from a deploy, a config change
 * or a reboot) is not appended: only crashes and kills count towards a loop.
 * Pure: storage is the caller's, so the restart-loop rule is testable.
 */
export function recordProcessStart(
  previous: string[],
  nowMs: number,
  afterCleanStop: boolean = false
): string[] {
  const kept = trimProcessStarts(previous, nowMs);
  if (!afterCleanStop) kept.push(new Date(nowMs).toISOString());
  return kept.slice(-20);
}

/** Starts still inside the restart-loop window at `nowMs`. Pure, no append. */
export function trimProcessStarts(starts: string[], nowMs: number): string[] {
  const cutoff = nowMs - RESTART_LOOP_WINDOW_MS;
  return starts.filter((iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms >= cutoff && ms <= nowMs;
  });
}

/**
 * Evaluated at report time against the current clock, so a burst of restarts
 * stops counting once it falls out of the window instead of latching for the
 * life of the process.
 */
export function isRestartLoop(recentStarts: string[], nowMs?: number): boolean {
  const live =
    nowMs == null ? recentStarts : trimProcessStarts(recentStarts, nowMs);
  return live.length >= RESTART_LOOP_THRESHOLD;
}

/**
 * The catch-up cap is "reached" only while the last scheduled run is still
 * interrupted and the cap is used up. Derived from the run history rather than
 * latched in memory, so it clears as soon as a scheduled or catch-up run
 * completes, or the catch-ups age out of the 24h window.
 */
export function isCatchUpCapReached(params: {
  lastScheduledRun: { id: number; status: string } | null;
  catchUpsInLastDay: number;
  maxCatchUpsPerDay: number;
}): boolean {
  // A cap of 0 means catch-up is switched off by configuration, not that a
  // loop used it up.
  if (params.maxCatchUpsPerDay <= 0) return false;
  return decideInterruptedRunCatchUp(params).action === "suppressed";
}
