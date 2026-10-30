import { logger } from "../../utils/logger";
import { ASO_ENV } from "../../shared/aso-env";
import { listEnabledPlayCountries } from "../../shared/play-countries";
import {
  createPacedHintFetcher,
  measureAutocomplete,
} from "../keywords/autocomplete-demand-service";
import {
  countTrackedPlayKeywords,
  getPlayKeyword,
  listPlayKeywordsDueForAutocomplete,
  listPlayKeywordsForRefresh,
  PLAY_POSITION_HISTORY_RETENTION_DAYS,
  prunePlayPositionHistory,
  recordPlayKeywordFailure,
  savePlayKeywordObservation,
  upsertPlayKeywordAutocomplete,
  type PlayKeywordObservation,
} from "../../db/play-keywords";
import { fetchPlaySearch, fetchPlaySuggestions } from "./play-client";
import { calculatePlayDifficulty, PLAY_DIFFICULTY_MODEL_VERSION } from "./play-difficulty";
import { PlayContractError, type PlaySearchParseResult } from "./play-search-parser";

/**
 * Google Play keyword crawl: one search page per keyword and country (rank,
 * result count, difficulty), plus Play autocomplete as the demand signal.
 * Called from the background refresh after the App Store crawl, and for
 * newly added keywords. Every keyword fails softly: a failure is recorded in
 * play_keyword_failures and the stored observation is left as it was.
 */

export type PlaySearchFetcher = (keyword: string, country: string) => Promise<PlaySearchParseResult>;
export type PlaySuggestFetcher = (prefix: string, country: string) => Promise<string[]>;

/** Abandon a country after this many keywords fail in a row (throttled, or a contract change). */
const ABANDON_AFTER_CONSECUTIVE_FAILURES = 10;
const AUTOCOMPLETE_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOREGROUND_PAUSE_MS = 300;

export type PlayCountryRefreshCounters = {
  country: string;
  eligible: number;
  refreshed: number;
  failed: number;
  skipped: number;
  abandoned: boolean;
  failureReasons: Record<string, number>;
  autocompleteChecked: number;
  autocompleteSuggested: number;
  autocompleteFailed: number;
  startedAt: string;
  finishedAt: string | null;
};

export type PlayRefreshCounters = {
  eligibleKeywordCount: number;
  refreshedKeywordCount: number;
  failedKeywordCount: number;
  countries: PlayCountryRefreshCounters[];
  /** Set when the Play phase itself threw; the App Store run is unaffected. */
  error?: string;
  /** The phase hit its time cap (ASO_PLAY_PHASE_MAX_MINUTES); the rest waits for the next run. */
  timedOut?: boolean;
  /** Why the phase did nothing, e.g. "already-running" (another Play crawl held the lock). */
  skipped?: string;
};

export function reasonCodeForPlayError(error: unknown): string {
  if (error instanceof PlayContractError) return error.code;
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === "number") return `HTTP_${status}`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim()) return code.trim();
  return "PLAY_FETCH_FAILED";
}

function statusCodeOf(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Crawls one keyword's search page and turns it into an observation. */
export async function evaluatePlayKeyword(
  keyword: string,
  country: string,
  search: PlaySearchFetcher = fetchPlaySearch,
  now: () => Date = () => new Date()
): Promise<PlayKeywordObservation> {
  const parsed = await search(keyword, country);
  return {
    country,
    keyword,
    difficultyScore: calculatePlayDifficulty(parsed.apps, keyword),
    difficultyModelVersion: PLAY_DIFFICULTY_MODEL_VERSION,
    resultCount: parsed.apps.length,
    rankDepth: parsed.apps.length,
    layout: parsed.layout,
    orderedAppIds: parsed.apps.map((app) => app.appId),
    topApps: parsed.apps.map((app) => ({
      appId: app.appId,
      title: app.title,
      developer: app.developer,
      category: app.category,
      installs: app.installs,
      installsBand: app.installsBand,
      rating: app.rating,
      ratingCount: app.ratingCount,
      isTopCard: app.isTopCard,
    })),
    observedAt: now().toISOString(),
  };
}

/**
 * Fewest letters (from 2) typed before Play suggests the keyword, and its
 * position (1-5) in that list - the same measure as App Store autocomplete
 * (autocomplete-demand-service.ts), reused as is.
 */
export function measurePlayAutocomplete(
  keyword: string,
  country: string,
  hints: PlaySuggestFetcher = fetchPlaySuggestions
): Promise<{ lettersNeeded: number | null; hintRank: number | null }> {
  return measureAutocomplete(keyword, country, hints);
}

let running = false;

export function isPlayRefreshRunning(): boolean {
  return running;
}

/**
 * The background refresh's Play phase. If an ad-hoc Play crawl (keywords just
 * added, a manual Play refresh) holds the single-flight lock, waits for it up
 * to `waitMs`; if it is still running, records the phase as skipped
 * ("already-running") rather than silently doing nothing.
 */
export async function refreshPlayKeywordsForRun(
  options: PlayRefreshOptions & { waitMs?: number; pollMs?: number }
): Promise<PlayRefreshCounters> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const waitUntil = now().getTime() + (options.waitMs ?? 10 * 60 * 1000);
  while (running && now().getTime() < waitUntil && !(options.isStopRequested?.() ?? false)) {
    await sleep(options.pollMs ?? 5000);
  }
  const counters = await refreshPlayKeywords(options);
  if (counters) return counters;
  logger.warn("[play-refresh] skipped: another Play crawl is still running");
  return {
    eligibleKeywordCount: 0,
    refreshedKeywordCount: 0,
    failedKeywordCount: 0,
    countries: [],
    skipped: "already-running",
  };
}

export type PlayRefreshOptions = {
  /** Re-crawl every keyword, ignoring how recently it was crawled. */
  force?: boolean;
  /** Countries to crawl; default every enabled Play country. */
  countries?: string[];
  /** Only these keywords (normalized), e.g. ones just added. */
  keywords?: string[];
  /** Also run the weekly-spread autocomplete check (default true). */
  autocomplete?: boolean;
  isStopRequested?: () => boolean;
  isForegroundBusy?: () => boolean;
  /** Stop starting new keywords after this long; counters.timedOut says it happened. */
  maxDurationMs?: number;
  search?: PlaySearchFetcher;
  suggest?: PlaySuggestFetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

/**
 * Crawls tracked Play keywords. Single-flight: a call while one runs returns
 * null. Never throws for a keyword; only a store failure can escape, and the
 * caller treats that as a soft failure of the Play phase.
 */
export async function refreshPlayKeywords(
  options: PlayRefreshOptions = {}
): Promise<PlayRefreshCounters | null> {
  if (running) return null;
  running = true;
  try {
    return await runPlayRefresh(options);
  } finally {
    running = false;
  }
}

async function runPlayRefresh(options: PlayRefreshOptions): Promise<PlayRefreshCounters> {
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isStopRequested = options.isStopRequested ?? (() => false);
  const isForegroundBusy = options.isForegroundBusy ?? (() => false);
  const search = options.search ?? fetchPlaySearch;
  const countries =
    options.countries ?? listEnabledPlayCountries().map((entry) => entry.country);
  const only = options.keywords ? new Set(options.keywords) : null;
  const startedAtMs = now().getTime();
  const deadlineReached = (): boolean =>
    options.maxDurationMs != null && now().getTime() - startedAtMs >= options.maxDurationMs;
  const freshForMs = ASO_ENV.keywordOrderTtlHours * 60 * 60 * 1000;
  const counters: PlayRefreshCounters = {
    eligibleKeywordCount: 0,
    refreshedKeywordCount: 0,
    failedKeywordCount: 0,
    countries: [],
  };

  for (const country of countries) {
    if (isStopRequested()) break;
    if (deadlineReached()) {
      counters.timedOut = true;
      break;
    }
    const cc: PlayCountryRefreshCounters = {
      country,
      eligible: 0,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      abandoned: false,
      failureReasons: {},
      autocompleteChecked: 0,
      autocompleteSuggested: 0,
      autocompleteFailed: 0,
      startedAt: now().toISOString(),
      finishedAt: null,
    };
    counters.countries.push(cc);

    const keywords = listPlayKeywordsForRefresh(country).filter((keyword) => {
      if (only && !only.has(keyword)) return false;
      if (options.force) return true;
      const stored = getPlayKeyword(country, keyword);
      return !stored || now().getTime() - Date.parse(stored.observedAt) >= freshForMs;
    });
    cc.eligible = keywords.length;
    counters.eligibleKeywordCount += keywords.length;

    let consecutiveFailures = 0;
    for (const keyword of keywords) {
      if (isStopRequested()) break;
      if (deadlineReached()) {
        counters.timedOut = true;
        break;
      }
      while (isForegroundBusy() && !isStopRequested()) await sleep(FOREGROUND_PAUSE_MS);
      try {
        const observation = await evaluatePlayKeyword(keyword, country, search, now);
        savePlayKeywordObservation(observation, { rosterAppIds: ASO_ENV.playRosterAppIds });
        cc.refreshed += 1;
        counters.refreshedKeywordCount += 1;
        consecutiveFailures = 0;
      } catch (error) {
        const reasonCode = reasonCodeForPlayError(error);
        cc.failed += 1;
        counters.failedKeywordCount += 1;
        cc.failureReasons[reasonCode] = (cc.failureReasons[reasonCode] ?? 0) + 1;
        consecutiveFailures += 1;
        recordPlayKeywordFailure({
          country,
          keyword,
          stage: "search",
          reasonCode,
          message: messageOf(error),
          statusCode: statusCodeOf(error),
        });
        logger.warn(`[play-refresh] ${country} "${keyword}" failed: ${reasonCode}`);
        if (consecutiveFailures >= ABANDON_AFTER_CONSECUTIVE_FAILURES) {
          cc.abandoned = true;
          break;
        }
      }
    }
    cc.skipped = Math.max(0, cc.eligible - cc.refreshed - cc.failed);

    if (options.autocomplete !== false && !cc.abandoned && !isStopRequested() && !deadlineReached()) {
      await refreshPlayAutocompleteForCountry(country, cc, {
        suggest: options.suggest,
        isStopRequested: () => isStopRequested() || deadlineReached(),
        now,
        keywords: only ? Array.from(only) : undefined,
      });
    }
    cc.finishedAt = now().toISOString();
    logger.info(
      `[play-refresh] country=${country} eligible=${cc.eligible} refreshed=${cc.refreshed} failed=${cc.failed} skipped=${cc.skipped} abandoned=${cc.abandoned} autocomplete=${cc.autocompleteChecked}/${cc.autocompleteSuggested} reasons=${JSON.stringify(cc.failureReasons)}`
    );
  }

  prunePlayPositionHistory(
    new Date(now().getTime() - PLAY_POSITION_HISTORY_RETENTION_DAYS * DAY_MS).toISOString()
  );
  return counters;
}

/**
 * Re-measures autocomplete for keywords not checked in 7 days. Like the App
 * Store check, a run takes about a seventh of the country's keywords (oldest
 * first), so the nightly refresh covers all of them once a week; newly added
 * keywords (`keywords`) are measured straight away.
 */
async function refreshPlayAutocompleteForCountry(
  country: string,
  cc: PlayCountryRefreshCounters,
  options: {
    suggest?: PlaySuggestFetcher;
    isStopRequested: () => boolean;
    now: () => Date;
    keywords?: string[];
  }
): Promise<void> {
  const cutoff = new Date(options.now().getTime() - AUTOCOMPLETE_MAX_AGE_DAYS * DAY_MS).toISOString();
  const limit = options.keywords
    ? options.keywords.length
    : Math.max(1, Math.ceil(countTrackedPlayKeywords(country) / AUTOCOMPLETE_MAX_AGE_DAYS));
  const due = listPlayKeywordsDueForAutocomplete(country, cutoff, options.keywords ? 1_000_000 : limit)
    .filter((keyword) => !options.keywords || options.keywords.includes(keyword))
    .slice(0, limit);
  // The limiter paces the requests; this only shares prefixes between keywords.
  const fetcher = createPacedHintFetcher({
    delayMs: 0,
    fetch: options.suggest ?? fetchPlaySuggestions,
  });
  for (const keyword of due) {
    if (options.isStopRequested()) break;
    try {
      const result = await measurePlayAutocomplete(keyword, country, fetcher.hints);
      upsertPlayKeywordAutocomplete({
        country,
        keyword,
        ...result,
        checkedAt: options.now().toISOString(),
      });
      cc.autocompleteChecked += 1;
      if (result.lettersNeeded != null) cc.autocompleteSuggested += 1;
    } catch (error) {
      cc.autocompleteFailed += 1;
      const reasonCode = reasonCodeForPlayError(error);
      recordPlayKeywordFailure({
        country,
        keyword,
        stage: "autocomplete",
        reasonCode,
        message: messageOf(error),
        statusCode: statusCodeOf(error),
      });
      // A changed RPC fails every keyword the same way; stop asking.
      if (error instanceof PlayContractError) break;
    }
  }
}

/**
 * Only the autocomplete check for one country (the weekly seventh), outside a
 * refresh. Shares the single-flight guard with refreshPlayKeywords; null when
 * a Play crawl is already running.
 */
export async function refreshPlayAutocomplete(
  country: string,
  options: { suggest?: PlaySuggestFetcher; now?: () => Date } = {}
): Promise<{ checked: number; suggested: number } | null> {
  if (running) return null;
  running = true;
  try {
    const now = options.now ?? (() => new Date());
    const cc: PlayCountryRefreshCounters = {
      country,
      eligible: 0,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      abandoned: false,
      failureReasons: {},
      autocompleteChecked: 0,
      autocompleteSuggested: 0,
      autocompleteFailed: 0,
      startedAt: now().toISOString(),
      finishedAt: null,
    };
    await refreshPlayAutocompleteForCountry(country, cc, {
      suggest: options.suggest,
      isStopRequested: () => false,
      now,
    });
    return { checked: cc.autocompleteChecked, suggested: cc.autocompleteSuggested };
  } finally {
    running = false;
  }
}
