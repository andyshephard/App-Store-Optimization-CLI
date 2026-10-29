import type { StoredAppKeyword, StoredAsoKeyword } from "../db/types";
import { logger } from "../utils/logger";
import { normalizeKeyword } from "../shared/aso-keyword-utils";
import {
  isKnownTransientStatusCode,
  isTransientTransportFailure,
} from "../shared/aso-transient-error";
import {
  isCompleteStoredAsoKeyword,
  isStoredKeywordOrderFresh,
  isStoredKeywordPopularityFresh,
} from "../shared/aso-keyword-validity";

export type StartupRefreshStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type StartupRefreshTrigger =
  | "scheduled"
  | "catch-up"
  | "manual"
  | "startup";

/** One storefront's share of a run. Persisted per run in refresh_run_storefronts. */
export type StorefrontRefreshCounters = {
  country: string;
  eligible: number;
  /** Ranking re-crawled (or, for a new keyword, fully enriched). */
  refreshed: number;
  /** Ranking not refreshed this pass; the stored row was left untouched. */
  failed: number;
  /** Not attempted: stop requested, storefront abandoned, or no session for a new keyword. */
  skipped: number;
  /** Popularity not refreshed. Counted separately: the ranking may still have been. */
  popularityFailed: number;
  /** reasonCode -> count, popularity reasons prefixed "popularity:". */
  failureReasons: Record<string, number>;
  abandoned: boolean;
  startedAt: string | null;
  finishedAt: string | null;
};

export type StartupRefreshCounters = {
  eligibleKeywordCount: number;
  refreshedKeywordCount: number;
  failedKeywordCount: number;
  /** Keywords whose popularity could not be refreshed (ranking may still be). */
  popularityFailedKeywordCount: number;
  /** Storefronts abandoned early because they looked throttled. */
  skippedCountries: string[];
  /** Per-storefront breakdown, in run order. */
  storefronts: StorefrontRefreshCounters[];
};

/**
 * Optional persistence for runs, so "did last night's refresh finish?" is
 * answerable after a restart. Every call is best effort: a failing store must
 * never stop the crawl it is recording.
 */
export type RefreshRunRecorder = {
  start: (params: { trigger: StartupRefreshTrigger; startedAt: string }) => number | null;
  saveStorefront: (runId: number, counters: StorefrontRefreshCounters) => void;
  finish: (runId: number, state: StartupRefreshState) => void;
};

export type StartupRefreshState = {
  status: StartupRefreshStatus;
  trigger: StartupRefreshTrigger | null;
  /** refresh_runs.id when a recorder is wired, else null. */
  runId: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  requiresReauthentication: boolean;
  stopRequested: boolean;
  counters: StartupRefreshCounters;
};

export type KeywordRefreshItem = {
  keyword: string;
  popularity: number;
};

export const STARTUP_KEYWORD_REFRESH_BATCH_SIZE = 25;
const FOREGROUND_PAUSE_MS = 300;

const RETRY_DELAY_MS = 500;

type StartupRefreshDeps = {
  country: string;
  /**
   * Storefronts to refresh, in order. Defaults to `[country]` so existing
   * single-storefront callers behave exactly as before. The dashboard passes
   * every enabled storefront, because keywords tracked in a non-default
   * storefront would otherwise never be refreshed in the background.
   */
  listRefreshCountries?: () => string[];
  listKeywords: (country: string) => StoredAsoKeyword[];
  listAppKeywords: (country: string) => StoredAppKeyword[];
  listAssociatedAppIds: () => Set<string>;
  listOrderRelevantAppIds: () => Set<string>;
  /**
   * Resolves with either an array of refreshed items (legacy shape: anything
   * not returned is counted as failed) or a StartupRefreshBatchOutcome with the
   * per-keyword failures, which the manager counts per storefront.
   */
  enrichKeywords: (
    country: string,
    items: KeywordRefreshItem[],
    options: { force: boolean; skipPopularity: boolean }
  ) => Promise<unknown>;
  recorder?: RefreshRunRecorder;
  /** Called after every run, whatever the outcome. */
  onRunFinished?: (state: StartupRefreshState) => void;
  /** Resident memory, logged per batch. Defaults to process.memoryUsage(). */
  readMemoryUsage?: () => { rss: number; heapUsed: number };
  isForegroundBusy: () => boolean;
  /**
   * Pause between storefronts. Apple throttles the app-detail endpoint per
   * storefront and answers 403 once a burst is too large; 403 is deliberately
   * not treated as transient, so a throttled storefront fails every remaining
   * batch fast and the loop would otherwise march into the next one hot.
   * Defaults to 0, keeping existing callers and tests unchanged.
   */
  interCountryDelayMs?: number;
  /** Pause between batches inside one storefront. Defaults to 0. */
  interBatchDelayMs?: number;
  /**
   * Abandon a storefront once this many consecutive keywords have failed
   * outright. Counting keywords rather than batches matters: a batch may hold a
   * single keyword, and a couple of unlucky keywords should not abandon a
   * storefront, whereas fifty in a row is a throttle rather than bad luck.
   * Defaults to 0, which disables the check entirely.
   */
  abandonCountryAfterFailedKeywords?: number;
  reportError?: (error: unknown, metadata: Record<string, unknown>) => void;
  isAuthReauthRequiredError?: (error: unknown) => boolean;
  /**
   * Called once per run, the first time a batch reports that the Apple session
   * is gone. Once, not per batch: the remaining storefronts still run without
   * the popularity stage, and each would otherwise repeat the notification.
   */
  onReauthenticationRequired?: (detail: string | null) => void;
  /** Called after a run that finished with the session intact. */
  onRunHealthy?: () => void;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  keywordBatchSize?: number;
};

export type StartupRefreshBatchOutcome = {
  items: unknown[];
  failedKeywords: Array<{ keyword: string; reasonCode: string }>;
  popularityFailures?: Array<{ keyword: string; reasonCode: string }>;
  skippedKeywords?: string[];
  reauthError?: unknown;
};

function isBatchOutcome(value: unknown): value is StartupRefreshBatchOutcome {
  return (
    value != null &&
    typeof value === "object" &&
    Array.isArray((value as StartupRefreshBatchOutcome).items) &&
    Array.isArray((value as StartupRefreshBatchOutcome).failedKeywords)
  );
}

export type StartupRefreshManager = {
  /** Returns false when a run is already in progress and nothing was started. */
  start: (options?: {
    force?: boolean;
    trigger?: StartupRefreshTrigger;
  }) => boolean;
  stop: () => void;
  getState: () => StartupRefreshState;
};

export function selectKeywordRefreshCandidates(params: {
  keywords: StoredAsoKeyword[];
  appKeywords: StoredAppKeyword[];
  associatedAppIds: Set<string>;
  orderRelevantAppIds: Set<string>;
  nowMs: number;
  /**
   * Ignore freshness and re-crawl every tracked keyword. Used by the manual
   * "refresh all" control, where the point is to get current data now rather
   * than to skip anything still inside its TTL.
   */
  force?: boolean;
}): KeywordRefreshItem[] {
  const associatedKeywords = new Set(
    params.appKeywords
      .filter((row) => params.associatedAppIds.has(row.appId))
      .map((row) => normalizeKeyword(row.keyword))
      .filter(Boolean)
  );
  const orderRelevantKeywords = new Set(
    params.appKeywords
      .filter((row) => params.orderRelevantAppIds.has(row.appId))
      .map((row) => normalizeKeyword(row.keyword))
      .filter(Boolean)
  );

  // Keywords added while Apple auth was unavailable have an association but no
  // cached row yet. They are invisible to the freshness checks below - which
  // read stored rows - so pick them up explicitly, otherwise a deferred add
  // never gets enriched.
  const storedKeywords = new Set(
    params.keywords.map((keyword) => keyword.normalizedKeyword)
  );
  const pendingFirstEnrichment: KeywordRefreshItem[] = [];
  const seenPending = new Set<string>();
  for (const row of params.appKeywords) {
    if (!params.associatedAppIds.has(row.appId)) continue;
    const normalized = normalizeKeyword(row.keyword);
    if (!normalized || storedKeywords.has(normalized)) continue;
    if (seenPending.has(normalized)) continue;
    seenPending.add(normalized);
    // Popularity is unknown until the pipeline fetches it.
    pendingFirstEnrichment.push({ keyword: row.keyword, popularity: 0 });
  }

  const refreshable = params.keywords
    .filter((keyword) => associatedKeywords.has(keyword.normalizedKeyword))
    .filter(
      (keyword) =>
        typeof keyword.popularity === "number" &&
        Number.isFinite(keyword.popularity)
    )
    .filter((keyword) => {
      if (params.force) return true;
      const orderFresh = isStoredKeywordOrderFresh(keyword, params.nowMs);
      const popularityFresh = isStoredKeywordPopularityFresh(
        keyword,
        params.nowMs
      );
      if (!isCompleteStoredAsoKeyword(keyword) || !popularityFresh) {
        return true;
      }
      if (!orderRelevantKeywords.has(keyword.normalizedKeyword)) {
        return false;
      }
      return !orderFresh;
    })
    .map((keyword) => ({
      keyword: keyword.keyword,
      popularity: keyword.popularity,
    }));

  return [...pendingFirstEnrichment, ...refreshable];
}

function chunkItems<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunkSize = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}

function initialCounters(): StartupRefreshCounters {
  return {
    eligibleKeywordCount: 0,
    refreshedKeywordCount: 0,
    failedKeywordCount: 0,
    popularityFailedKeywordCount: 0,
    skippedCountries: [],
    storefronts: [],
  };
}

function initialStorefrontCounters(
  country: string,
  startedAt: string
): StorefrontRefreshCounters {
  return {
    country,
    eligible: 0,
    refreshed: 0,
    failed: 0,
    skipped: 0,
    popularityFailed: 0,
    failureReasons: {},
    abandoned: false,
    startedAt,
    finishedAt: null,
  };
}

function addReason(
  reasons: Record<string, number>,
  reason: string,
  count: number = 1
): void {
  if (count <= 0) return;
  reasons[reason] = (reasons[reason] ?? 0) + count;
}

function reasonFromError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim()) return code.trim();
  if (isExhaustedBatchFailure(error)) return "ALL_KEYWORDS_FAILED";
  return "BATCH_ERROR";
}

const BYTES_PER_MB = 1024 * 1024;

function initialState(): StartupRefreshState {
  return {
    status: "idle",
    trigger: null,
    runId: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    requiresReauthentication: false,
    stopRequested: false,
    counters: initialCounters(),
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  const raw = String(error ?? "");
  return raw.trim() || "Background refresh failed.";
}

function isExhaustedBatchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.trim();
  if (!message) return false;
  return message.startsWith("All keywords failed (");
}

function isTransientStartupFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (
    typeof statusCode === "number" &&
    isKnownTransientStatusCode(statusCode)
  ) {
    return true;
  }
  return isTransientTransportFailure({
    code: String((error as { code?: unknown }).code ?? ""),
    message: String((error as { message?: unknown }).message ?? ""),
  });
}

async function withOneRetry(
  operation: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  shouldRetry?: (error: unknown) => boolean
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (shouldRetry?.(error) === false) {
      throw error;
    }
    await sleep(RETRY_DELAY_MS);
    await operation();
  }
}

export function createStartupRefreshManager(
  deps: StartupRefreshDeps
): StartupRefreshManager {
  const nowMs = () => deps.nowMs?.() ?? Date.now();
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const keywordBatchSize = Math.min(
    100,
    Math.max(1, deps.keywordBatchSize ?? STARTUP_KEYWORD_REFRESH_BATCH_SIZE)
  );
  const interCountryDelayMs = Math.max(0, deps.interCountryDelayMs ?? 0);
  const interBatchDelayMs = Math.max(0, deps.interBatchDelayMs ?? 0);
  const abandonCountryAfterFailedKeywords = Math.max(
    0,
    deps.abandonCountryAfterFailedKeywords ?? 0
  );

  let state: StartupRefreshState = initialState();
  let runPromise: Promise<void> | null = null;
  let stopRequested = false;
  /**
   * Latched once a batch reports that reauthentication is required. Popularity
   * is account-level, so a dead session blocks it everywhere - but rank, app
   * count and difficulty come from the public search page and need no session.
   * The rest of the run continues without the popularity stage rather than
   * abandoning eleven storefronts' worth of collectable data.
   */
  let popularityUnavailable = false;

  const setFailure = (error: unknown, metadata: Record<string, unknown>) => {
    const isAuthReauthRequired =
      deps.isAuthReauthRequiredError?.(error) === true;
    if (!state.lastError) {
      state.lastError = errorToMessage(error);
    }
    if (isAuthReauthRequired) {
      state.requiresReauthentication = true;
    }
    deps.reportError?.(error, metadata);
  };

  const resolveRefreshCountries = (): string[] => {
    const countries = deps.listRefreshCountries?.() ?? [deps.country];
    const unique: string[] = [];
    for (const entry of countries) {
      const normalized = entry.trim().toUpperCase();
      if (normalized && !unique.includes(normalized)) {
        unique.push(normalized);
      }
    }
    return unique.length > 0 ? unique : [deps.country];
  };

  const readMemoryUsage =
    deps.readMemoryUsage ??
    (() => {
      const usage = process.memoryUsage();
      return { rss: usage.rss, heapUsed: usage.heapUsed };
    });

  const recordStorefront = (counters: StorefrontRefreshCounters): void => {
    if (!deps.recorder || state.runId == null) return;
    try {
      deps.recorder.saveStorefront(state.runId, counters);
    } catch (error) {
      deps.reportError?.(error, { phase: "refresh-run-record-storefront" });
    }
  };

  const refreshCountryInBatches = async (
    country: string,
    force: boolean
  ): Promise<void> => {
    const sf = initialStorefrontCounters(
      country,
      new Date(nowMs()).toISOString()
    );
    state.counters.storefronts.push(sf);
    try {
      await refreshCountryBatches(country, force, sf);
    } finally {
      sf.finishedAt = new Date(nowMs()).toISOString();
      // Anything neither refreshed nor failed was never attempted.
      sf.skipped = Math.max(0, sf.eligible - sf.refreshed - sf.failed);
      recordStorefront(sf);
      const level =
        sf.failed > 0 || sf.abandoned || sf.popularityFailed > 0
          ? "warn"
          : "info";
      logger[level](
        `[aso-refresh] storefront done country=${country} eligible=${sf.eligible} refreshed=${sf.refreshed} failed=${sf.failed} skipped=${sf.skipped} popularityFailed=${sf.popularityFailed} abandoned=${sf.abandoned} reasons=${JSON.stringify(sf.failureReasons)}`
      );
    }
  };

  const refreshCountryBatches = async (
    country: string,
    force: boolean,
    sf: StorefrontRefreshCounters
  ): Promise<void> => {
    const items = selectKeywordRefreshCandidates({
      force,
      keywords: deps.listKeywords(country),
      appKeywords: deps.listAppKeywords(country),
      associatedAppIds: deps.listAssociatedAppIds(),
      orderRelevantAppIds: deps.listOrderRelevantAppIds(),
      nowMs: nowMs(),
    });
    state.counters.eligibleKeywordCount += items.length;
    sf.eligible = items.length;
    if (items.length === 0) return;

    const batches = chunkItems(items, keywordBatchSize);
    let consecutiveFailedKeywords = 0;
    const countFailed = (count: number, reason: string) => {
      if (count <= 0) return;
      state.counters.failedKeywordCount += count;
      sf.failed += count;
      addReason(sf.failureReasons, reason, count);
    };
    const handleReauthRequired = (error: unknown) => {
      state.requiresReauthentication = true;
      if (!popularityUnavailable) {
        popularityUnavailable = true;
        try {
          deps.onReauthenticationRequired?.(errorToMessage(error));
        } catch (notifyError) {
          // Failing to raise the alarm must not stop the rest of the crawl.
          deps.reportError?.(notifyError, {
            phase: "startup-refresh-reauth-notify",
            country,
          });
        }
      }
    };
    for (const [batchIndex, batch] of batches.entries()) {
      if (stopRequested) break;
      if (batchIndex > 0 && interBatchDelayMs > 0) {
        await sleep(interBatchDelayMs);
        if (stopRequested) break;
      }
      while (deps.isForegroundBusy()) {
        if (stopRequested) break;
        await sleep(FOREGROUND_PAUSE_MS);
      }
      if (stopRequested) break;
      let result: unknown;
      try {
        await withOneRetry(
          async () => {
            result = await deps.enrichKeywords(country, batch, {
              force,
              skipPopularity: popularityUnavailable,
            });
          },
          sleep,
          (error) => {
            if (deps.isAuthReauthRequiredError?.(error) === true) {
              return false;
            }
            if (isExhaustedBatchFailure(error)) {
              return false;
            }
            return isTransientStartupFailure(error);
          }
        );
      } catch (error) {
        const isAuthReauthRequired =
          deps.isAuthReauthRequiredError?.(error) === true;
        countFailed(batch.length, reasonFromError(error));
        setFailure(error, {
          phase: "startup-keyword-refresh",
          country,
          batchSize: batch.length,
          keywordPreview: batch.slice(0, 5).map((item) => item.keyword),
          isAuthReauthRequired,
        });
        logger.warn(
          `[aso-refresh] batch failed country=${country} batch=${batchIndex + 1}/${batches.length} size=${batch.length} error=${errorToMessage(error)}`
        );
        if (isAuthReauthRequired) {
          // Retrying the popularity stage would just fail the same way and burn
          // another login attempt per batch. Drop to the auth-free work and
          // keep going; the state already records that a login is needed.
          handleReauthRequired(error);
          continue;
        }
        // Every keyword in a batch failing usually means the storefront itself
        // is throttled, not that these particular keywords are bad. Continuing
        // burns the rest of the list against a wall.
        consecutiveFailedKeywords = isExhaustedBatchFailure(error)
          ? consecutiveFailedKeywords + batch.length
          : 0;
        if (
          abandonCountryAfterFailedKeywords > 0 &&
          consecutiveFailedKeywords >= abandonCountryAfterFailedKeywords
        ) {
          sf.abandoned = true;
          state.counters.skippedCountries.push(country);
          break;
        }
        continue;
      }

      // Partial success is normal - the pipeline resolves with the keywords it
      // managed to refresh and reports the rest. Counting the whole batch as
      // refreshed made a run that half worked look complete.
      let refreshedInBatch: number;
      let failedInBatch: number;
      if (isBatchOutcome(result)) {
        refreshedInBatch = Math.min(batch.length, result.items.length);
        failedInBatch = Math.min(
          batch.length - refreshedInBatch,
          result.failedKeywords.length
        );
        for (const failure of result.failedKeywords) {
          addReason(sf.failureReasons, failure.reasonCode || "UNKNOWN");
        }
        const popularityFailures = result.popularityFailures ?? [];
        sf.popularityFailed += popularityFailures.length;
        state.counters.popularityFailedKeywordCount += popularityFailures.length;
        for (const failure of popularityFailures) {
          addReason(
            sf.failureReasons,
            `popularity:${failure.reasonCode || "UNKNOWN"}`
          );
        }
        if (result.reauthError != null) {
          setFailure(result.reauthError, {
            phase: "startup-keyword-refresh-popularity",
            country,
            batchSize: batch.length,
            isAuthReauthRequired: true,
          });
          handleReauthRequired(result.reauthError);
        }
      } else {
        refreshedInBatch = Array.isArray(result)
          ? Math.min(batch.length, result.length)
          : batch.length;
        failedInBatch = batch.length - refreshedInBatch;
        addReason(sf.failureReasons, "NOT_RETURNED", failedInBatch);
      }
      state.counters.refreshedKeywordCount += refreshedInBatch;
      sf.refreshed += refreshedInBatch;
      state.counters.failedKeywordCount += failedInBatch;
      sf.failed += failedInBatch;

      const memory = readMemoryUsage();
      logger.info(
        `[aso-refresh] batch country=${country} batch=${batchIndex + 1}/${batches.length} refreshed=${refreshedInBatch} failed=${failedInBatch} rssMb=${Math.round(memory.rss / BYTES_PER_MB)} heapUsedMb=${Math.round(memory.heapUsed / BYTES_PER_MB)}`
      );

      if (refreshedInBatch === 0 && failedInBatch > 0) {
        // Same signal as a thrown "All keywords failed": the storefront is
        // most likely throttled. Recorded as the run's error too, so the
        // status does not read "completed" over a wall of failures.
        const error = new Error(
          `All keywords failed (${failedInBatch}) in ${country} batch ${batchIndex + 1}/${batches.length}`
        );
        setFailure(error, {
          phase: "startup-keyword-refresh",
          country,
          batchSize: batch.length,
          keywordPreview: batch.slice(0, 5).map((item) => item.keyword),
          isAuthReauthRequired: false,
        });
        consecutiveFailedKeywords += failedInBatch;
        if (
          abandonCountryAfterFailedKeywords > 0 &&
          consecutiveFailedKeywords >= abandonCountryAfterFailedKeywords
        ) {
          sf.abandoned = true;
          state.counters.skippedCountries.push(country);
          break;
        }
      } else {
        consecutiveFailedKeywords = 0;
      }
    }
  };

  const refreshKeywordsInBatches = async (force: boolean): Promise<void> => {
    const countries = resolveRefreshCountries();
    for (const [index, country] of countries.entries()) {
      if (stopRequested) break;
      if (index > 0 && interCountryDelayMs > 0) {
        await sleep(interCountryDelayMs);
        if (stopRequested) break;
      }
      await refreshCountryInBatches(country, force);
    }
  };

  const run = async (
    force: boolean,
    trigger: StartupRefreshTrigger
  ): Promise<void> => {
    const startedAt = new Date(nowMs()).toISOString();
    let runId: number | null = null;
    if (deps.recorder) {
      try {
        runId = deps.recorder.start({ trigger, startedAt });
      } catch (error) {
        deps.reportError?.(error, { phase: "refresh-run-record-start" });
      }
    }
    logger.info(
      `[aso-refresh] run started trigger=${trigger} force=${force} runId=${runId ?? "none"}`
    );
    state = {
      status: "running",
      trigger,
      runId,
      startedAt,
      finishedAt: null,
      lastError: null,
      requiresReauthentication: false,
      stopRequested: false,
      counters: initialCounters(),
    };
    stopRequested = false;
    popularityUnavailable = false;

    await refreshKeywordsInBatches(force);

    const finalStatus: StartupRefreshStatus =
      state.requiresReauthentication || (!stopRequested && state.lastError)
        ? "failed"
        : stopRequested
          ? "stopped"
          : "completed";

    state = {
      ...state,
      status: finalStatus,
      finishedAt: new Date(nowMs()).toISOString(),
      stopRequested: false,
    };
    finishRun();

    // A run that got through with the session intact clears the alert
    // suppression, so the next outage is reported straight away rather than
    // being swallowed by a window left over from the previous one.
    if (!state.requiresReauthentication && !stopRequested) {
      try {
        deps.onRunHealthy?.();
      } catch {
        // Nothing here is worth failing a completed run for.
      }
    }
  };

  let finishedRunId: number | null = null;
  const finishRun = (): void => {
    // Once per run, even if the unhandled-error path below runs after it.
    if (state.runId != null && finishedRunId === state.runId) return;
    finishedRunId = state.runId;
    const c = state.counters;
    const level = state.status === "completed" ? "info" : "warn";
    logger[level](
      `[aso-refresh] run finished status=${state.status} trigger=${state.trigger} eligible=${c.eligibleKeywordCount} refreshed=${c.refreshedKeywordCount} failed=${c.failedKeywordCount} popularityFailed=${c.popularityFailedKeywordCount} skippedCountries=${c.skippedCountries.join(",") || "none"}${state.lastError ? ` lastError=${state.lastError}` : ""}`
    );
    if (deps.recorder && state.runId != null) {
      try {
        deps.recorder.finish(state.runId, getState());
      } catch (error) {
        deps.reportError?.(error, { phase: "refresh-run-record-finish" });
      }
    }
    try {
      deps.onRunFinished?.(getState());
    } catch (error) {
      deps.reportError?.(error, { phase: "refresh-run-finished-hook" });
    }
  };

  const getState = (): StartupRefreshState => ({
    ...state,
    counters: {
      ...state.counters,
      skippedCountries: [...state.counters.skippedCountries],
      storefronts: state.counters.storefronts.map((sf) => ({
        ...sf,
        failureReasons: { ...sf.failureReasons },
      })),
    },
  });

  return {
    start: (options?: { force?: boolean; trigger?: StartupRefreshTrigger }) => {
      if (runPromise) return false;
      runPromise = run(options?.force === true, options?.trigger ?? "manual")
        .catch((error) => {
          setFailure(error, { phase: "startup-refresh-unhandled" });
          state = {
            ...state,
            status: "failed",
            finishedAt: new Date(nowMs()).toISOString(),
            stopRequested: false,
          };
          finishRun();
        })
        .finally(() => {
          stopRequested = false;
          runPromise = null;
        });
      return true;
    },
    stop: () => {
      if (!runPromise) return;
      stopRequested = true;
      state = {
        ...state,
        stopRequested: true,
      };
    },
    getState,
  };
}
