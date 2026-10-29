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
 * Pure: storage is the caller's, so the restart-loop rule is testable.
 */
export function recordProcessStart(
  previous: string[],
  nowMs: number
): string[] {
  const cutoff = nowMs - RESTART_LOOP_WINDOW_MS;
  const kept = previous.filter((iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms >= cutoff && ms <= nowMs;
  });
  kept.push(new Date(nowMs).toISOString());
  return kept.slice(-20);
}

export function isRestartLoop(recentStarts: string[]): boolean {
  return recentStarts.length >= RESTART_LOOP_THRESHOLD;
}
