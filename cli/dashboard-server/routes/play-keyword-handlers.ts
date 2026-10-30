import * as http from "http";
import { logger } from "../../utils/logger";
import { ASO_ENV } from "../../shared/aso-env";
import {
  isEnabledPlayCountry,
  listEnabledPlayCountries,
} from "../../shared/play-countries";
import { sanitizeKeywords } from "../../domain/keywords/policy";
import { ASO_MAX_KEYWORDS, ASO_MAX_KEYWORDS_PER_REQUEST_ERROR } from "../../shared/aso-keyword-limits";
import {
  addPlayAppKeywords,
  listPlayAppKeywords,
  listPlayDailyPositionHistory,
  listPlayKeywordAutocomplete,
  listPlayKeywordRowsForApp,
  removePlayAppKeywords,
  type PlayKeywordListRow,
} from "../../db/play-keywords";
import {
  isPlayRefreshRunning,
  refreshPlayAutocomplete,
  refreshPlayKeywords,
} from "../../services/play/play-keyword-service";

/**
 * Google Play on the existing keyword endpoints. Every endpoint keeps its App
 * Store behaviour and response shape unless the request says
 * `platform=android` (query string, or `platform` in a JSON body); see
 * docs/google-play.md for the shapes.
 */

export type StorePlatform = "ios" | "android";

type Deps = {
  sendJson: (res: http.ServerResponse, status: number, data: unknown) => void;
  sendApiError: (
    res: http.ServerResponse,
    status: number,
    errorCode: string,
    message: string
  ) => void;
  isTruthyQueryParam: (value: string | undefined) => boolean;
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const POSITION_HISTORY_MAX_PAGE = 5000;

/** "ios" when absent; null (after a 400) when it is neither ios nor android. */
export function resolveRequestPlatform(
  res: http.ServerResponse,
  raw: unknown,
  sendApiError: Deps["sendApiError"]
): StorePlatform | null {
  if (raw == null || raw === "") return "ios";
  const value = String(raw).trim().toLowerCase();
  if (value === "ios" || value === "android") return value;
  sendApiError(res, 400, "INVALID_REQUEST", `platform must be "ios" or "android".`);
  return null;
}

function toBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseAppIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

type PlayKeywordItem = ReturnType<typeof toPlayKeywordItem>;

function toPlayKeywordItem(
  row: PlayKeywordListRow,
  options: { competitorAppIds: string[]; includeTopApps: boolean }
) {
  const observation = row.observation;
  const orderedAppIds = observation?.orderedAppIds ?? [];
  const rankOf = (appId: string) => {
    const index = orderedAppIds.indexOf(appId);
    return index >= 0 ? index + 1 : null;
  };
  const rank = rankOf(row.appId);
  const competitorRanks: Record<string, number | null> = {};
  for (const appId of options.competitorAppIds) {
    if (appId !== row.appId) competitorRanks[appId] = rankOf(appId);
  }
  const searchFailure = row.failures.find((failure) => failure.stage === "search") ?? null;
  const failure = searchFailure
    ? {
        stage: "search",
        reasonCode: searchFailure.reasonCode,
        message: searchFailure.message,
        statusCode: searchFailure.statusCode,
        retryable: searchFailure.reasonCode !== "PLAY_CONTRACT_CHANGED",
        attempts: searchFailure.attempts,
        updatedAt: searchFailure.updatedAt,
      }
    : null;
  return {
    platform: "android" as const,
    keyword: row.keyword,
    normalizedKeyword: row.normalizedKeyword,
    country: row.country,
    appId: row.appId,
    // Play publishes no search volume; autocomplete is the demand evidence.
    popularity: null,
    autocompleteLetters: row.autocomplete?.lettersNeeded ?? null,
    autocompleteRank: row.autocomplete?.hintRank ?? null,
    autocompleteCheckedAt: row.autocomplete?.checkedAt ?? null,
    difficultyScore: observation?.difficultyScore ?? null,
    difficultyModelVersion: observation?.difficultyModelVersion ?? null,
    isBrandKeyword: null,
    appCount: observation?.resultCount ?? null,
    resultCount: observation?.resultCount ?? null,
    rankDepth: observation?.rankDepth ?? null,
    layout: observation?.layout ?? null,
    rank,
    previousRank: row.previousPosition,
    rankChange: rank != null && row.previousPosition != null ? rank - row.previousPosition : null,
    orderedAppIds,
    ...(options.includeTopApps ? { topApps: observation?.topApps ?? [] } : {}),
    competitorRanks,
    isFavorite: row.isFavorite,
    addedAt: row.addedAt,
    updatedAt: observation?.observedAt ?? null,
    keywordStatus: failure ? "failed" : observation ? "ok" : "pending",
    failure,
    positions: [{ appId: row.appId, previousPosition: row.previousPosition, currentPosition: rank }],
  };
}

const SORTERS: Record<string, (a: PlayKeywordItem, b: PlayKeywordItem) => number> = {
  keyword: (a, b) => a.normalizedKeyword.localeCompare(b.normalizedKeyword),
  rank: (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity),
  difficulty: (a, b) => (a.difficultyScore ?? Infinity) - (b.difficultyScore ?? Infinity),
  autocomplete: (a, b) => (a.autocompleteLetters ?? Infinity) - (b.autocompleteLetters ?? Infinity),
  updatedAt: (a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""),
};

export function createPlayKeywordHandlers(deps: Deps) {
  function resolvePlayCountry(res: http.ServerResponse, raw: unknown): string | null {
    const country = String(raw ?? "US").trim().toUpperCase();
    if (isEnabledPlayCountry(country)) return country;
    const enabled = listEnabledPlayCountries()
      .map((entry) => entry.country)
      .join(", ");
    deps.sendApiError(
      res,
      400,
      "COUNTRY_NOT_ENABLED",
      `Google Play country ${country} is not enabled. Enabled Play countries: ${enabled || "none"} (ASO_PLAY_COUNTRIES).`
    );
    return null;
  }

  function resolvePlayAppId(res: http.ServerResponse, raw: unknown): string | null {
    const appId = typeof raw === "string" && raw.trim() ? raw.trim() : ASO_ENV.playAppId;
    if (appId) return appId;
    deps.sendApiError(
      res,
      400,
      "INVALID_REQUEST",
      "Please provide a Google Play appId (package name), or set ASO_PLAY_APP_ID."
    );
    return null;
  }

  /** GET /api/aso/keywords?platform=android */
  function handlePlayKeywordsGet(res: http.ServerResponse, query: Record<string, string>): void {
    const country = resolvePlayCountry(res, query.country);
    if (!country) return;
    const appId = resolvePlayAppId(res, query.appId);
    if (!appId) return;
    const competitorAppIds = Array.from(
      new Set([...ASO_ENV.playRosterAppIds, ...parseAppIds(query.competitors)])
    );
    const all = listPlayKeywordRowsForApp(appId, country).map((row) =>
      toPlayKeywordItem(row, {
        competitorAppIds,
        includeTopApps: deps.isTruthyQueryParam(query.includeTopApps),
      })
    );
    const keywordFilter = (query.keyword ?? "").trim().toLowerCase();
    const filtered = keywordFilter
      ? all.filter((item) => item.normalizedKeyword.includes(keywordFilter))
      : all;
    const sorter = SORTERS[query.sortBy ?? ""] ?? SORTERS.keyword;
    const direction = (query.sortDir ?? "").toLowerCase() === "desc" ? -1 : 1;
    filtered.sort((a, b) => direction * sorter(a, b) || SORTERS.keyword(a, b));

    const pageSize = toBoundedInteger(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(toBoundedInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER), totalPages);
    deps.sendJson(res, 200, {
      success: true,
      data: {
        platform: "android",
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        totalCount: filtered.length,
        totalPages,
        hasPrevPage: page > 1,
        hasNextPage: page < totalPages,
        associatedCount: all.length,
        failedCount: all.filter((item) => item.keywordStatus === "failed").length,
        pendingCount: all.filter((item) => item.keywordStatus === "pending").length,
      },
    });
  }

  function parseKeywordsFromBody(
    res: http.ServerResponse,
    body: Record<string, unknown>
  ): string[] | null {
    const raw = Array.isArray(body.keywords) ? body.keywords.map((k) => String(k)) : [];
    const keywords = sanitizeKeywords(raw);
    if (keywords.length === 0) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", "Please provide at least one keyword.");
      return null;
    }
    if (keywords.length > ASO_MAX_KEYWORDS) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", ASO_MAX_KEYWORDS_PER_REQUEST_ERROR);
      return null;
    }
    return keywords;
  }

  /**
   * POST /api/aso/keywords with platform "android". Tracks the keywords and,
   * unless `defer` is true, crawls the new ones in the background (Play is
   * rate-limited, so the response never waits for it).
   */
  function handlePlayKeywordsPost(res: http.ServerResponse, body: Record<string, unknown>): void {
    const country = resolvePlayCountry(res, body.country);
    if (!country) return;
    const appId = resolvePlayAppId(res, body.appId);
    if (!appId) return;
    const keywords = parseKeywordsFromBody(res, body);
    if (!keywords) return;
    const existing = new Set(
      listPlayAppKeywords({ appId, country }).map((row) => row.keyword)
    );
    const added = keywords.filter((keyword) => !existing.has(keyword));
    addPlayAppKeywords(appId, added, country);
    const deferred = body.defer === true;
    let refreshStarted = false;
    if (added.length > 0 && !deferred && !isPlayRefreshRunning()) {
      refreshStarted = true;
      void refreshPlayKeywords({ countries: [country], keywords: added, force: true }).then(
        (counters) =>
          logger.info(
            `[play] added ${added.length} in ${country}: refreshed ${counters?.refreshedKeywordCount ?? 0}, failed ${counters?.failedKeywordCount ?? 0}`
          ),
        (error) => logger.error(`[play] crawl of added keywords failed: ${String(error)}`)
      );
    }
    deps.sendJson(res, 201, {
      success: true,
      data: {
        platform: "android",
        country,
        appId,
        addedCount: added.length,
        cachedCount: 0,
        pendingCount: added.length,
        failedCount: 0,
        deferred,
        // False while another Play crawl runs: the keywords wait for the next refresh.
        refreshStarted,
      },
    });
  }

  /** DELETE /api/aso/keywords with platform "android". */
  function handlePlayKeywordsDelete(res: http.ServerResponse, body: Record<string, unknown>): void {
    const country = resolvePlayCountry(res, body.country);
    if (!country) return;
    const appId = resolvePlayAppId(res, body.appId);
    if (!appId) return;
    const keywords = parseKeywordsFromBody(res, body);
    if (!keywords) return;
    const removedCount = removePlayAppKeywords(appId, keywords, country);
    deps.sendJson(res, 200, { success: true, data: { platform: "android", removedCount } });
  }

  /** GET /api/aso/autocomplete?platform=android */
  function handlePlayAutocompleteGet(res: http.ServerResponse, query: Record<string, string>): void {
    const country = resolvePlayCountry(res, query.country);
    if (!country) return;
    deps.sendJson(res, 200, {
      success: true,
      data: {
        platform: "android",
        country,
        running: isPlayRefreshRunning(),
        items: listPlayKeywordAutocomplete(country),
      },
    });
  }

  /** POST /api/aso/autocomplete/refresh?platform=android */
  function handlePlayAutocompleteRefreshPost(
    res: http.ServerResponse,
    query: Record<string, string>
  ): void {
    const country = resolvePlayCountry(res, query.country);
    if (!country) return;
    const alreadyRunning = isPlayRefreshRunning();
    if (!alreadyRunning) {
      void refreshPlayAutocomplete(country).then(
        (r) => logger.info(`[play-autocomplete] ${country}: checked ${r?.checked ?? 0}, suggested ${r?.suggested ?? 0}`),
        (e) => logger.error(`[play-autocomplete] ${country} failed: ${String(e)}`)
      );
    }
    deps.sendJson(res, 202, {
      success: true,
      data: { platform: "android", country, started: !alreadyRunning },
    });
  }

  /** POST /api/aso/refresh/start?platform=android - a Play-only crawl. */
  function handlePlayRefreshStartPost(res: http.ServerResponse, query: Record<string, string>): void {
    const alreadyRunning = isPlayRefreshRunning();
    if (!alreadyRunning) {
      void refreshPlayKeywords({ force: deps.isTruthyQueryParam(query.force) }).then(
        (counters) =>
          logger.info(
            `[play] manual refresh: refreshed ${counters?.refreshedKeywordCount ?? 0}, failed ${counters?.failedKeywordCount ?? 0}`
          ),
        (error) => logger.error(`[play] manual refresh failed: ${String(error)}`)
      );
    }
    deps.sendJson(res, 202, {
      success: true,
      data: { platform: "android", started: !alreadyRunning },
    });
  }

  /** GET /api/aso/position-history?platform=android */
  function handlePlayPositionHistoryGet(res: http.ServerResponse, query: Record<string, string>): void {
    const since = /^\d{4}-\d{2}-\d{2}$/.test(query.since ?? "")
      ? query.since
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const limit = toBoundedInteger(query.limit, POSITION_HISTORY_MAX_PAGE, 1, POSITION_HISTORY_MAX_PAGE);
    const offset = toBoundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const items = listPlayDailyPositionHistory({
      since,
      appIds: parseAppIds(query.appIds),
      limit,
      offset,
    });
    deps.sendJson(res, 200, {
      success: true,
      data: {
        platform: "android",
        items,
        since,
        limit,
        offset,
        hasNextPage: items.length === limit,
        nextCursor: null,
      },
    });
  }

  return {
    handlePlayKeywordsGet,
    handlePlayKeywordsPost,
    handlePlayKeywordsDelete,
    handlePlayAutocompleteGet,
    handlePlayAutocompleteRefreshPost,
    handlePlayRefreshStartPost,
    handlePlayPositionHistoryGet,
  };
}
