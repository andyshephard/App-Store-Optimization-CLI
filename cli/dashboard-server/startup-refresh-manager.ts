import type { StoredAppKeyword, StoredAsoKeyword } from "../db/types";
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

export type StartupRefreshCounters = {
  eligibleKeywordCount: number;
  refreshedKeywordCount: number;
  failedKeywordCount: number;
  /** Storefronts abandoned early because they looked throttled. */
  skippedCountries: string[];
};

export type StartupRefreshState = {
  status: StartupRefreshStatus;
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
  enrichKeywords: (
    country: string,
    items: KeywordRefreshItem[],
    options: { force: boolean }
  ) => Promise<unknown>;
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
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  keywordBatchSize?: number;
};

export type StartupRefreshManager = {
  start: (options?: { force?: boolean }) => void;
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
    skippedCountries: [],
  };
}

function initialState(): StartupRefreshState {
  return {
    status: "idle",
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
  if (typeof statusCode === "number" && isKnownTransientStatusCode(statusCode)) {
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

  const refreshCountryInBatches = async (
    country: string,
    force: boolean
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
    if (items.length === 0) return;

    const batches = chunkItems(items, keywordBatchSize);
    let consecutiveFailedKeywords = 0;
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
      try {
        await withOneRetry(async () => {
          await deps.enrichKeywords(country, batch, { force });
        }, sleep, (error) => {
          if (deps.isAuthReauthRequiredError?.(error) === true) {
            return false;
          }
          if (isExhaustedBatchFailure(error)) {
            return false;
          }
          return isTransientStartupFailure(error);
        });
        state.counters.refreshedKeywordCount += batch.length;
        consecutiveFailedKeywords = 0;
      } catch (error) {
        const isAuthReauthRequired =
          deps.isAuthReauthRequiredError?.(error) === true;
        state.counters.failedKeywordCount += batch.length;
        setFailure(error, {
          phase: "startup-keyword-refresh",
          country,
          batchSize: batch.length,
          keywordPreview: batch.slice(0, 5).map((item) => item.keyword),
          isAuthReauthRequired,
        });
        if (isAuthReauthRequired) {
          break;
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
          state.counters.skippedCountries.push(country);
          break;
        }
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
      // A reauth prompt applies to the Apple session itself, so continuing on
      // to the next storefront would just fail the same way.
      if (state.requiresReauthentication) break;
    }
  };

  const run = async (force: boolean): Promise<void> => {
    state = {
      status: "running",
      startedAt: new Date(nowMs()).toISOString(),
      finishedAt: null,
      lastError: null,
      requiresReauthentication: false,
      stopRequested: false,
      counters: initialCounters(),
    };
    stopRequested = false;

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
  };

  return {
    start: (options?: { force?: boolean }) => {
      if (runPromise) return;
      runPromise = run(options?.force === true)
        .catch((error) => {
          setFailure(error, { phase: "startup-refresh-unhandled" });
          state = {
            ...state,
            status: "failed",
            finishedAt: new Date(nowMs()).toISOString(),
            stopRequested: false,
          };
        })
        .finally(() => {
          stopRequested = false;
          runPromise = null;
        });
    },
    stop: () => {
      if (!runPromise) return;
      stopRequested = true;
      state = {
        ...state,
        stopRequested: true,
      };
    },
    getState: () => ({
      ...state,
      counters: {
        ...state.counters,
        skippedCountries: [...state.counters.skippedCountries],
      },
    }),
  };
}
