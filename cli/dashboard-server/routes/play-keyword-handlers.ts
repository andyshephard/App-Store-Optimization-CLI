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
  addPlayCompetitorApp,
  listPlayAppDetails,
  listPlayCompetitorApps,
  listPlayRosterAppIds,
  removePlayCompetitorApp,
} from "../../db/play-competitors";
import {
  isPlayRefreshRunning,
  refreshPlayAutocomplete,
  refreshPlayKeywords,
} from "../../services/play/play-keyword-service";
import { PACKAGE_ID, PLAY_MAX_KEYWORD_LENGTH } from "../../services/play/play-search-parser";
import { isPlayPackageId } from "../../domain/play-package";

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
/** Competitors add no requests (their ranks come from the same page), only history rows. */
const MAX_PLAY_COMPETITORS = 50;

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
    if (appId && !PACKAGE_ID.test(appId)) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", "appId is not a valid Google Play package name.");
      return null;
    }
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
    const requestedCompetitors = parseAppIds(query.competitors);
    if (requestedCompetitors.some((id) => !PACKAGE_ID.test(id))) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", "competitors must be Google Play package names.");
      return;
    }
    const competitorAppIds = Array.from(
      new Set([...listPlayRosterAppIds(), ...requestedCompetitors])
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
    if (keywords.some((keyword) => keyword.length > PLAY_MAX_KEYWORD_LENGTH)) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        `Keywords must be at most ${PLAY_MAX_KEYWORD_LENGTH} characters.`
      );
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

  /**
   * GET /api/apps?platform=android: our app (ASO_PLAY_APP_ID) first, then
   * each competitor with where it comes from. Names and icons are from stored
   * search results; null until the package shows up in a crawled top 30.
   */
  function handlePlayAppsGet(res: http.ServerResponse): void {
    const stored = new Map(listPlayCompetitorApps().map((app) => [app.appId, app.addedAt]));
    const envRoster = new Set(ASO_ENV.playRosterAppIds);
    const ours = ASO_ENV.playAppId;
    const competitorIds = listPlayRosterAppIds();
    const details = listPlayAppDetails(ours ? [ours, ...competitorIds] : competitorIds);
    const describe = (appId: string) => ({
      id: appId,
      name: details.get(appId)?.title ?? null,
      developer: details.get(appId)?.developer ?? null,
      iconUrl: details.get(appId)?.iconUrl ?? null,
    });
    const items = [
      ...(ours
        ? [{ ...describe(ours), kind: "owned", source: "ASO_PLAY_APP_ID", removable: false, addedAt: null }]
        : []),
      ...competitorIds.map((appId) => ({
        ...describe(appId),
        kind: "competitor",
        source: envRoster.has(appId) ? "ASO_PLAY_ROSTER_APP_IDS" : "dashboard",
        // A package from the environment stays until the variable changes.
        removable: !envRoster.has(appId),
        addedAt: stored.get(appId) ?? null,
      })),
    ];
    deps.sendJson(res, 200, { success: true, data: { platform: "android", items } });
  }

  function parsePackageFromBody(res: http.ServerResponse, body: Record<string, unknown>): string | null {
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    if (!isPlayPackageId(appId)) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "appId must be a Google Play package name, e.g. com.example.app."
      );
      return null;
    }
    return appId;
  }

  /**
   * POST /api/apps with platform "android": adds a competitor package. Its
   * ranks are read from the stored top 30 at once, and its rank history is
   * recorded from the next crawl. No Play request is made.
   */
  function handlePlayAppsPost(res: http.ServerResponse, body: Record<string, unknown>): void {
    const appId = parsePackageFromBody(res, body);
    if (!appId) return;
    if (appId === ASO_ENV.playAppId) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", `${appId} is our app (ASO_PLAY_APP_ID).`);
      return;
    }
    const roster = listPlayRosterAppIds();
    if (!roster.includes(appId) && roster.length >= MAX_PLAY_COMPETITORS) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        `At most ${MAX_PLAY_COMPETITORS} Google Play competitors can be tracked.`
      );
      return;
    }
    const added = !roster.includes(appId) && addPlayCompetitorApp(appId);
    deps.sendJson(res, 201, {
      success: true,
      data: {
        platform: "android",
        id: appId,
        name: listPlayAppDetails([appId]).get(appId)?.title ?? null,
        added,
      },
    });
  }

  /** DELETE /api/apps with platform "android": stops tracking a competitor; its history is kept. */
  function handlePlayAppsDelete(res: http.ServerResponse, body: Record<string, unknown>): void {
    const appId = parsePackageFromBody(res, body);
    if (!appId) return;
    if (removePlayCompetitorApp(appId)) {
      deps.sendJson(res, 200, { success: true, data: { platform: "android", id: appId } });
      return;
    }
    if (ASO_ENV.playRosterAppIds.includes(appId) || appId === ASO_ENV.playAppId) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        `${appId} is set by ${appId === ASO_ENV.playAppId ? "ASO_PLAY_APP_ID" : "ASO_PLAY_ROSTER_APP_IDS"}; change the environment to remove it.`
      );
      return;
    }
    deps.sendApiError(res, 404, "NOT_FOUND", "App not found.");
  }

  return {
    handlePlayAppsGet,
    handlePlayAppsPost,
    handlePlayAppsDelete,
    handlePlayKeywordsGet,
    handlePlayKeywordsPost,
    handlePlayKeywordsDelete,
    handlePlayAutocompleteGet,
    handlePlayAutocompleteRefreshPost,
    handlePlayRefreshStartPost,
    handlePlayPositionHistoryGet,
  };
}
