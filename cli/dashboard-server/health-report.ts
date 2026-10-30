/**
 * Truthful health for GET /api/aso/health.
 *
 * `/health` only proves the HTTP server answers, which it did throughout a
 * stretch where eleven of twelve storefronts silently stopped refreshing. This
 * report is built from the persisted run history instead, so it can say
 * "degraded" while the process looks perfectly alive.
 *
 * Pure: every input is gathered by the caller, so the rules are testable.
 */

export type HealthStatus = "ok" | "degraded" | "down";

/** A storefront with no successful pass for this long is stale. */
export const STOREFRONT_STALE_MS = 30 * 60 * 60 * 1000;
/** No run reaching its end for this long means the daily refresh is not happening. */
export const NO_COMPLETED_RUN_MS = 26 * 60 * 60 * 1000;

const BYTES_PER_MB = 1024 * 1024;

export type HealthRunInput = {
  id: number;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  storefronts: Array<{
    country: string;
    eligible: number;
    refreshed: number;
    failed: number;
    skipped: number;
    popularityFailed: number;
    abandoned: boolean;
    failureReasons: Record<string, number>;
    finishedAt: string | null;
  }>;
  /** Apple requests during the run, per host (refresh_runs counters). */
  requests?: {
    durationMs: number;
    byHost: Record<
      string,
      {
        requests: number;
        status429: number;
        status403: number;
        status5xx: number;
        throttles: number;
        perMin: number;
      }
    >;
    rates: Record<string, unknown> | null;
  } | null;
  /** The run's Google Play phase (refresh_runs counters.play), if it had one. */
  play?: Record<string, unknown> | null;
};

export type HealthInputs = {
  nowMs: number;
  uptimeSeconds: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  db: { writable: boolean; error: string | null };
  enabledCountries: string[];
  /** From run history, per storefront. */
  storefrontLastSuccessAt: Record<string, string>;
  /** Storefronts that appear in run history at all. */
  countriesWithRunHistory: Set<string>;
  /** Newest keyword write per storefront, used only before any run history. */
  keywordLastUpdatedAt: Record<string, string>;
  lastRun: HealthRunInput | null;
  lastFinishedRunAt: string | null;
  currentRun: {
    status: string;
    trigger: string | null;
    startedAt: string | null;
    requiresReauthentication: boolean;
  };
  scheduler: {
    enabled: boolean;
    dailyAt: string | null;
    timeZone: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
  };
  session: {
    /** False when no unattended credentials are configured. */
    keeperEnabled: boolean;
    lastOkAt: string | null;
    lastCheckAt: string | null;
    ok: boolean | null;
    needsTwoFactor: boolean;
  };
  restartLoop: { detected: boolean; recentStarts: number };
  /** Per-host request caps and current effective rates (AIMD-reduced after a throttle). */
  rateLimits?: Record<string, unknown>;
};

export type HealthStorefront = {
  country: string;
  lastSuccessAt: string | null;
  /** "runs" when from run history; "keywords" before any run was recorded. */
  lastSuccessSource: "runs" | "keywords" | null;
  stale: boolean;
  lastRun: {
    eligible: number;
    refreshed: number;
    failed: number;
    skipped: number;
    popularityFailed: number;
    abandoned: boolean;
    failureReasons: Record<string, number>;
  } | null;
};

export type HealthReport = {
  status: HealthStatus;
  reasons: string[];
  checkedAt: string;
  uptimeSeconds: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  db: { writable: boolean; error: string | null };
  scheduler: HealthInputs["scheduler"];
  lastRun: {
    id: number;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    /** Ran to the end (completed or failed), rather than running, stopped or interrupted. */
    completed: boolean;
    lastError: string | null;
    eligible: number;
    refreshed: number;
    failed: number;
    popularityFailed: number;
    failuresByReason: Record<string, number>;
    /** Apple requests per host, 429/403/5xx and per-minute rate, and duration. */
    requests: HealthRunInput["requests"] | null;
    /**
     * Google Play counters for the run. Informational: Play failures never
     * change the health status.
     */
    play: Record<string, unknown> | null;
  } | null;
  lastCompletedRunAt: string | null;
  currentRun: HealthInputs["currentRun"];
  storefronts: HealthStorefront[];
  session: HealthInputs["session"];
  restartLoop: HealthInputs["restartLoop"];
  rateLimits: Record<string, unknown>;
};

function ageMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? nowMs - ms : null;
}

export function buildHealthReport(inputs: HealthInputs): HealthReport {
  const reasons: string[] = [];
  const uptimeMs = inputs.uptimeSeconds * 1000;

  const lastRunStorefronts = new Map(
    (inputs.lastRun?.storefronts ?? []).map((sf) => [sf.country, sf] as const)
  );
  const storefronts: HealthStorefront[] = inputs.enabledCountries.map(
    (country) => {
      const fromRuns = inputs.storefrontLastSuccessAt[country] ?? null;
      const fromKeywords = inputs.countriesWithRunHistory.has(country)
        ? null
        : (inputs.keywordLastUpdatedAt[country] ?? null);
      const lastSuccessAt = fromRuns ?? fromKeywords;
      const age = ageMs(lastSuccessAt, inputs.nowMs);
      // With nothing on record yet, give a fresh process one full window
      // before calling the storefront stale.
      const stale =
        age == null ? uptimeMs > STOREFRONT_STALE_MS : age > STOREFRONT_STALE_MS;
      const sf = lastRunStorefronts.get(country);
      return {
        country,
        lastSuccessAt,
        lastSuccessSource: fromRuns ? "runs" : fromKeywords ? "keywords" : null,
        stale,
        lastRun: sf
          ? {
              eligible: sf.eligible,
              refreshed: sf.refreshed,
              failed: sf.failed,
              skipped: sf.skipped,
              popularityFailed: sf.popularityFailed,
              abandoned: sf.abandoned,
              failureReasons: { ...sf.failureReasons },
            }
          : null,
      };
    }
  );
  for (const sf of storefronts) {
    if (sf.stale) reasons.push(`storefront_stale:${sf.country}`);
  }

  if (inputs.scheduler.enabled) {
    const age = ageMs(inputs.lastFinishedRunAt, inputs.nowMs);
    const noCompletedRun =
      age == null ? uptimeMs > NO_COMPLETED_RUN_MS : age > NO_COMPLETED_RUN_MS;
    if (noCompletedRun) reasons.push("no_completed_run_26h");
  }

  if (inputs.session.needsTwoFactor) reasons.push("two_factor_required");
  if (inputs.currentRun.requiresReauthentication) {
    reasons.push("reauthentication_required");
  }
  if (inputs.restartLoop.detected) reasons.push("restart_loop");
  if (!inputs.db.writable) reasons.push("db_not_writable");

  const status: HealthStatus = !inputs.db.writable
    ? "down"
    : reasons.length > 0
      ? "degraded"
      : "ok";

  const run = inputs.lastRun;
  const failuresByReason: Record<string, number> = {};
  let eligible = 0;
  let refreshed = 0;
  let failed = 0;
  let popularityFailed = 0;
  for (const sf of run?.storefronts ?? []) {
    eligible += sf.eligible;
    refreshed += sf.refreshed;
    failed += sf.failed;
    popularityFailed += sf.popularityFailed;
    for (const [reason, count] of Object.entries(sf.failureReasons)) {
      failuresByReason[reason] = (failuresByReason[reason] ?? 0) + count;
    }
  }

  return {
    status,
    reasons,
    checkedAt: new Date(inputs.nowMs).toISOString(),
    uptimeSeconds: Math.round(inputs.uptimeSeconds),
    memory: {
      rssMb: Math.round(inputs.memory.rss / BYTES_PER_MB),
      heapUsedMb: Math.round(inputs.memory.heapUsed / BYTES_PER_MB),
      heapTotalMb: Math.round(inputs.memory.heapTotal / BYTES_PER_MB),
    },
    db: inputs.db,
    scheduler: inputs.scheduler,
    lastRun: run
      ? {
          id: run.id,
          trigger: run.trigger,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          completed:
            run.finishedAt != null &&
            (run.status === "completed" || run.status === "failed"),
          lastError: run.lastError,
          eligible,
          refreshed,
          failed,
          popularityFailed,
          failuresByReason,
          requests: run.requests ?? null,
          play: run.play ?? null,
        }
      : null,
    lastCompletedRunAt: inputs.lastFinishedRunAt,
    currentRun: inputs.currentRun,
    storefronts,
    session: inputs.session,
    restartLoop: inputs.restartLoop,
    rateLimits: inputs.rateLimits ?? {},
  };
}

/** The conditions that send an email, keyed for once-per-day suppression. */
export type HealthAlertCondition = {
  key: "storefront-stale" | "no-completed-run" | "restart-loop";
  active: boolean;
  subject: string;
  text: string;
};

export function listHealthAlertConditions(
  report: HealthReport
): HealthAlertCondition[] {
  const stale = report.storefronts.filter((sf) => sf.stale);
  const staleLines = stale.map(
    (sf) =>
      `  ${sf.country}: last success ${sf.lastSuccessAt ?? "never recorded"}` +
      (sf.lastRun
        ? ` (last run: ${sf.lastRun.refreshed}/${sf.lastRun.eligible} refreshed, ${sf.lastRun.failed} failed${sf.lastRun.abandoned ? ", abandoned" : ""}, reasons ${JSON.stringify(sf.lastRun.failureReasons)})`
        : "")
  );
  return [
    {
      key: "storefront-stale",
      active: stale.length > 0,
      subject: `ASO keywords: ${stale.length} storefront(s) not refreshed in 30h (${stale
        .map((sf) => sf.country)
        .join(", ")})`,
      text: [
        "These storefronts have had no successful refresh pass for over 30 hours.",
        "Their rankings in the API are stale.",
        "",
        ...staleLines,
        "",
        "GET /api/aso/health has the per-storefront detail.",
      ].join("\n"),
    },
    {
      key: "no-completed-run",
      active: report.reasons.includes("no_completed_run_26h"),
      subject: "ASO keywords: no refresh run has completed in 26h",
      text: [
        "No background refresh run has run to completion for over 26 hours.",
        `Last completed run: ${report.lastCompletedRunAt ?? "none recorded"}.`,
        `Last run: ${report.lastRun ? `${report.lastRun.status} (${report.lastRun.trigger}, started ${report.lastRun.startedAt})` : "none recorded"}.`,
        `Scheduler next run: ${report.scheduler.nextRunAt ?? "not scheduled"}.`,
      ].join("\n"),
    },
    {
      key: "restart-loop",
      active: report.restartLoop.detected,
      subject: "ASO keywords: the service is restarting repeatedly",
      text: [
        `The process has started ${report.restartLoop.recentStarts} times in the last 2 hours,`,
        "or interrupted catch-up runs hit their daily cap. Something is killing it -",
        "check `docker logs asocli` and `docker inspect asocli` for OOMKilled.",
        "",
        `Memory now: rss ${report.memory.rssMb} MB, heap ${report.memory.heapUsedMb} MB.`,
      ].join("\n"),
    },
  ];
}
