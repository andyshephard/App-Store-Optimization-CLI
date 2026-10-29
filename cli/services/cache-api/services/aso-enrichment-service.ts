import { logger } from "../../../utils/logger";
import {
  computeAppExpiryIsoForApp,
  normalizeKeyword,
  normalizeTextForKeywordMatch,
} from "./aso-keyword-utils";
import {
  fetchAppStoreAdditionalLocalizations,
  fetchAppStoreLocalizedAppData,
} from "./aso-app-store-details";
import { normalizeCountryOnAppDocs } from "./aso-app-doc-utils";
import {
  fetchAppStoreLookupAppDocs,
  fetchItunesLookupAppDocs,
} from "./aso-app-doc-service";
import {
  calculateRatingDifficulty,
  RATING_DIFFICULTY_TOP_N,
} from "./aso-rating-difficulty";
import { ASO_ENV } from "../../../shared/aso-env";
import type { AsoAppDoc, AsoAppDocIcon } from "./aso-types";
import { asoAppleGet } from "./aso-apple-client";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";
import { currentRunLookupCache } from "../../keywords/observation-context";
import { getStorefrontDefaultLanguage } from "../../../shared/aso-storefront-localizations";
import {
  getAcceptLanguage,
  getDsLangCookieValue,
  getSearchUrl,
  getStoreFrontHeader,
} from "../../../shared/aso-storefronts";
import { parseLocalizedRatingCount } from "../../../shared/aso-rating-count";
import { ASO_APPLE_WEB_USER_AGENT } from "../../../shared/aso-apple-http";
import type { KeywordMatchType } from "../../../shared/aso-keyword-match";
import {
  calculateAppDifficultyBreakdown,
  calculateKeywordDifficultyBreakdown,
  keywordMatchToScore,
} from "./aso-difficulty";
import {
  hasRequiredTopDifficultyDocs,
  requiresTopDifficultyDocs,
  TOP_DIFFICULTY_DOC_LIMIT,
} from "../../../shared/aso-difficulty-policy";

interface MzSearchResponse {
  pageData?: {
    bubbles?: Array<{
      name?: string;
      results?: Array<{ id?: string | number }>;
    }>;
  };
}

interface AmpSearchLockup {
  adamId?: string;
  title?: string;
  subtitle?: string | null;
  developerName?: string;
  icon?: {
    template?: string;
    width?: number;
    height?: number;
    backgroundColor?: { red: number; green: number; blue: number };
    [key: string]: unknown;
  };
  rating?: number;
  ratingCount?: string | number;
}

interface AmpSearchResponse {
  data?: Array<{
    data?: {
      shelves?: Array<{
        contentType?: string;
        items?: Array<{
          $kind?: string;
          resultType?: string;
          lockup?: AmpSearchLockup;
        }>;
      }>;
      nextPage?: {
        results?: Array<{
          id?: string;
          type?: string;
        }>;
      };
    };
  }>;
}

const MZSEARCH_ORDER_URL = "https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search";
const INSUFFICIENT_DOCS_RETRY_COUNT = 1;
const INSUFFICIENT_DOCS_RETRY_BACKOFF_MS = 150;
const INCOMPLETE_TOP_DOC_LOOKUP_COOLDOWN_MS = 10 * 60 * 1000;
const incompleteTopDocLookupCooldownUntilByAppId = new Map<string, number>();

function isIncompleteTopDocLookupOnCooldown(
  appId: string,
  nowMs: number = Date.now()
): boolean {
  const cooldownUntil = incompleteTopDocLookupCooldownUntilByAppId.get(appId);
  if (cooldownUntil == null) return false;
  if (cooldownUntil <= nowMs) {
    incompleteTopDocLookupCooldownUntilByAppId.delete(appId);
    return false;
  }
  return true;
}

function markIncompleteTopDocLookupCooldown(
  appIds: string[],
  nowMs: number = Date.now()
): void {
  if (appIds.length === 0) return;
  const cooldownUntil = nowMs + INCOMPLETE_TOP_DOC_LOOKUP_COOLDOWN_MS;
  for (const appId of appIds) {
    incompleteTopDocLookupCooldownUntilByAppId.set(appId, cooldownUntil);
  }
}

function clearIncompleteTopDocLookupCooldown(appIds: string[]): void {
  if (appIds.length === 0) return;
  for (const appId of appIds) {
    incompleteTopDocLookupCooldownUntilByAppId.delete(appId);
  }
}

export function __resetIncompleteTopDocLookupCooldownForTests(): void {
  incompleteTopDocLookupCooldownUntilByAppId.clear();
}

class InsufficientDifficultyDocsError extends Error {
  readonly code = "INSUFFICIENT_DOCS";
  readonly statusCode = 503;

  constructor(params: {
    keyword: string;
    country: string;
    appCount: number;
    docsForDifficultyCount: number;
    missingTopIds: string[];
  }) {
    super(
      `Insufficient top-app docs for difficulty scoring: keyword="${params.keyword}" country="${params.country}" appCount=${params.appCount} docsForDifficulty=${params.docsForDifficultyCount} missingTopIds=${params.missingTopIds.join(",")}`
    );
    this.name = "InsufficientDifficultyDocsError";
  }
}

/**
 * MZSearch answered, but not with an order we can trust: either the response
 * shape drifted (no `pageData.bubbles[]`, or a software bubble without
 * `results[]`) or it listed no apps at all. Persisting that would write
 * appCount 0 and an empty order over the previous day's ranking, and bump
 * updatedAt so the keyword looked freshly refreshed. Throwing instead leaves
 * the stored row untouched and lets the caller count the keyword as failed.
 */
export class KeywordOrderUnavailableError extends Error {
  readonly code: "ORDER_CONTRACT_DRIFT" | "EMPTY_ORDER" | "SHALLOW_ORDER";
  readonly statusCode = 502;

  constructor(params: {
    code: "ORDER_CONTRACT_DRIFT" | "EMPTY_ORDER" | "SHALLOW_ORDER";
    keyword: string;
    country: string;
    detail: string;
  }) {
    super(
      `Keyword order unavailable (${params.code}): keyword="${params.keyword}" country="${params.country.toUpperCase()}" ${params.detail}`
    );
    this.name = "KeywordOrderUnavailableError";
    this.code = params.code;
  }
}

/** Looks up the keyword's currently stored order, if any. */
export type StoredOrderLookup = (normalizedKeyword: string) => string[] | null;

/**
 * Refuses an empty order only where it would destroy data: the keyword already
 * has a non-empty stored order. N apps yesterday and none today is far more
 * likely a degraded response than a real change, even when the response looks
 * like Apple's "no results" shape, so it is treated as unresolved and the
 * stored order is kept. A never-enriched keyword, or one that was already
 * empty, may genuinely have no results in a smaller storefront, and refusing
 * it would leave it failed forever. Without a lookup there is nothing to
 * protect.
 */
function assertUsableOrder(params: {
  keyword: string;
  country: string;
  orderedAppIds: string[];
  clearlyEmpty: boolean;
  source: string;
  getStoredOrderedAppIds?: StoredOrderLookup;
}): void {
  if (params.orderedAppIds.length > 0) return;
  const previous =
    params.getStoredOrderedAppIds?.(normalizeKeyword(params.keyword)) ?? null;
  if (!previous || previous.length === 0) return;
  throw new KeywordOrderUnavailableError({
    code: "EMPTY_ORDER",
    keyword: params.keyword,
    country: params.country,
    detail: `source=${params.source} returned no apps${params.clearlyEmpty ? " (no software bubble)" : ""}; keeping the stored order of ${previous.length}`,
  });
}

function safeDaysSince(isoDate: string | undefined): number {
  if (!isoDate) return 365;
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return 365;
  return Math.max(1, Math.floor((Date.now() - parsed) / (1000 * 60 * 60 * 24)));
}

function detectKeywordMatchType(
  name: string,
  subtitle: string | undefined,
  keyword: string
): KeywordMatchType {
  const normKeyword = normalizeTextForKeywordMatch(keyword);
  const keywordParts = new Set(normKeyword.split(" ").filter(Boolean));
  const normTitle = normalizeTextForKeywordMatch(name);

  if (normTitle.includes(normKeyword)) return "titleExactPhrase";

  const titleWords = new Set(normTitle.split(" ").filter(Boolean));
  if (
    keywordParts.size > 0 &&
    [...keywordParts].every((w) => titleWords.has(w))
  )
    return "titleAllWords";

  const normSubtitle = normalizeTextForKeywordMatch(subtitle || "");
  if (normSubtitle && normSubtitle.includes(normKeyword)) return "subtitleExactPhrase";

  const combined = `${normTitle} ${normSubtitle}`.trim();
  if (combined.includes(normKeyword)) return "combinedPhrase";

  const subtitleWords = new Set(normSubtitle.split(" ").filter(Boolean));
  if (
    keywordParts.size > 0 &&
    subtitleWords.size > 0 &&
    [...keywordParts].every((w) => subtitleWords.has(w))
  ) {
    return "subtitleAllWords";
  }

  return "none";
}

function detectBestKeywordMatchType(app: AsoAppDoc, keyword: string): KeywordMatchType {
  const localizations: Array<{ name: string; subtitle?: string }> = [
    { name: app.name, subtitle: app.subtitle },
  ];
  for (const localized of Object.values(app.additionalLocalizations ?? {})) {
    localizations.push({
      name: localized.name,
      subtitle: localized.subtitle,
    });
  }

  let bestMatch: KeywordMatchType = "none";
  let bestScore = 0;
  for (const localized of localizations) {
    const match = detectKeywordMatchType(localized.name, localized.subtitle, keyword);
    const score = keywordMatchToScore(match);
    if (score > bestScore) {
      bestMatch = match;
      bestScore = score;
      if (bestScore >= 1) {
        break;
      }
    }
  }
  return bestMatch;
}

function detectTopKeywordMatchType(apps: AsoAppDoc[], keyword: string): KeywordMatchType {
  let topMatch: KeywordMatchType = "none";
  let topScore = 0;
  for (const app of apps) {
    const match = detectBestKeywordMatchType(app, keyword);
    const score = keywordMatchToScore(match);
    if (score > topScore) {
      topMatch = match;
      topScore = score;
      if (topScore >= 1) {
        break;
      }
    }
  }
  return topMatch;
}

function tokenizeForBrand(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean);
}

function detectIsBrandKeyword(keyword: string, apps: AsoAppDoc[]): boolean {
  const leader = apps[0];
  if (!leader?.publisherName) return false;

  const keywordTokens = new Set(tokenizeForBrand(keyword));
  if (keywordTokens.size === 0) return false;

  const leaderPublisherTokens = new Set(tokenizeForBrand(leader.publisherName));
  if (leaderPublisherTokens.size === 0) return false;
  for (const token of keywordTokens) {
    if (!leaderPublisherTokens.has(token)) {
      return false;
    }
  }

  const leaderReviews = Math.max(0, leader.userRatingCount || 0);
  if (leaderReviews >= 1000) {
    return true;
  }

  const leaderPublisher = leader.publisherName.trim().toLowerCase();
  const independentRunnerUps = apps
    .slice(1, TOP_DIFFICULTY_DOC_LIMIT)
    .filter((app) => {
      const publisher = app.publisherName?.trim().toLowerCase();
      return Boolean(publisher && publisher !== leaderPublisher);
    });
  if (independentRunnerUps.length === 0) {
    return false;
  }

  const sortedRunnerUpRatings = independentRunnerUps
    .map((app) => Math.max(0, app.userRatingCount || 0))
    .sort((a, b) => a - b);
  const n = sortedRunnerUpRatings.length;
  const medianRunnerUpRatings =
    n % 2 === 1
      ? sortedRunnerUpRatings[Math.floor(n / 2)]
      : (sortedRunnerUpRatings[n / 2 - 1] + sortedRunnerUpRatings[n / 2]) / 2;
  return medianRunnerUpRatings >= 10000;
}

function appCompetitiveScore(app: AsoAppDoc, keyword: string): number {
  const ratingCount = app.userRatingCount || 0;
  const avgRating = app.averageUserRating ?? 0;
  const lastRelease = app.currentVersionReleaseDate || app.releaseDate;
  const firstRelease = app.releaseDate;
  const daysSinceLastRelease = safeDaysSince(lastRelease ?? undefined);
  const daysSinceFirstRelease = safeDaysSince(firstRelease ?? undefined);
  const keywordMatch = detectBestKeywordMatchType(app, keyword);

  return calculateAppDifficultyBreakdown({
    averageUserRating: avgRating,
    userRatingCount: ratingCount,
    daysSinceLastRelease,
    daysSinceFirstRelease,
    keywordMatch,
  }).score;
}

async function fetchPopularityOrderedIds(params: {
  keyword: string;
  country: string;
}): Promise<string[]> {
  return (await fetchPopularityOrder(params)).orderedAppIds;
}

/**
 * `clearlyEmpty` is true only when the response carries other bubbles but no
 * software bubble - Apple's shape for "no app results". A bare `bubbles: []`
 * or an empty software bubble is not: a degraded response looks like that
 * too. Diagnostic only; an empty order never replaces a stored one.
 */
async function fetchPopularityOrder(params: {
  keyword: string;
  country: string;
}): Promise<{ orderedAppIds: string[]; clearlyEmpty: boolean }> {
  const response = await asoAppleGet<MzSearchResponse>(
    MZSEARCH_ORDER_URL,
    {
      operation: "mzsearch.keyword-order",
      params: {
        clientApplication: "Software",
        term: params.keyword,
      },
      headers: {
        "User-Agent": ASO_APPLE_WEB_USER_AGENT,
        "Accept-Language": getAcceptLanguage(params.country),
        Cookie: `dslang=${getDsLangCookieValue(params.country)}`,
        "x-apple-store-front": getStoreFrontHeader(params.country),
      },
      timeout: 30000,
    }
  );

  const bubbles = response.data?.pageData?.bubbles;
  if (!Array.isArray(bubbles)) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "mzsearch.keyword-order",
      endpoint: MZSEARCH_ORDER_URL,
      statusCode: response.status,
      expectedContract: "MZSearch response has pageData.bubbles[]",
      actualSignal: `bubblesType=${typeof bubbles}`,
      context: {
        keyword: params.keyword,
        country: params.country.toUpperCase(),
      },
      isTerminal: false,
      dedupeKey: "mzsearch-keyword-order-bubbles-array",
    });
    throw new KeywordOrderUnavailableError({
      code: "ORDER_CONTRACT_DRIFT",
      keyword: params.keyword,
      country: params.country,
      detail: `bubblesType=${typeof bubbles}`,
    });
  }

  for (const bubble of bubbles) {
    if (bubble?.name !== "software") continue;
    if (!Array.isArray(bubble.results)) {
      reportAppleContractChange({
        provider: "apple-appstore",
        operation: "mzsearch.keyword-order",
        endpoint: MZSEARCH_ORDER_URL,
        statusCode: response.status,
        expectedContract: "software bubble has results[] entries",
        actualSignal: `softwareResultsType=${typeof bubble.results}`,
        context: {
          keyword: params.keyword,
          country: params.country.toUpperCase(),
        },
        isTerminal: false,
        dedupeKey: "mzsearch-keyword-order-software-results-array",
      });
      throw new KeywordOrderUnavailableError({
        code: "ORDER_CONTRACT_DRIFT",
        keyword: params.keyword,
        country: params.country,
        detail: `softwareResultsType=${typeof bubble.results}`,
      });
    }
    return {
      orderedAppIds: (bubble.results || [])
        .map((result) => `${result.id || ""}`.trim())
        .filter(Boolean),
      clearlyEmpty: false,
    };
  }

  // Only a response that carries other bubbles but no software bubble looks
  // like a real "no app results"; a bare `bubbles: []` says nothing.
  return { orderedAppIds: [], clearlyEmpty: bubbles.length > 0 };
}

function lockupToAppDoc(lockup: AmpSearchLockup, country: string): AsoAppDoc | null {
  const adamId = `${lockup?.adamId || ""}`.trim();
  if (!adamId) return null;
  const name = (lockup?.title ?? "").trim() || "Unknown";
  const subtitle = lockup?.subtitle?.trim() || undefined;
  const publisherName = lockup?.developerName?.trim() || undefined;
  const rating = lockup?.rating;
  const averageUserRating =
    typeof rating === "number" && !Number.isNaN(rating) ? rating : 0;
  const userRatingCount = parseLocalizedRatingCount(
    lockup?.ratingCount,
    country
  );
  const icon: AsoAppDocIcon | undefined = lockup?.icon
    ? {
        template: lockup.icon.template,
        width: lockup.icon.width,
        height: lockup.icon.height,
        backgroundColor: lockup.icon.backgroundColor,
      }
    : undefined;

  return {
    appId: adamId,
    country: country.toUpperCase(),
    name,
    subtitle,
    publisherName,
    averageUserRating,
    userRatingCount,
    icon,
  };
}

function isAppLikeSearchResultItem(item: {
  $kind?: string;
  resultType?: string;
}): boolean {
  const kind = (item.$kind ?? "").trim();
  const resultType = (item.resultType ?? "").trim().toLowerCase();
  if (kind === "BundleSearchResult" || resultType === "bundle") {
    return false;
  }
  return true;
}

/**
 * Organic app rows only (upstream a5ca459): an app result, or an app-event
 * row, which stands for that app's search slot. Ads, editorial, bundles and
 * unknown row types are skipped. Used for the ratings-mode rank prefix.
 */
function isOrganicAppSearchResultItem(item: {
  $kind?: string;
  resultType?: string;
}): boolean {
  const kind = (item.$kind ?? "").trim();
  const resultType = (item.resultType ?? "").trim().toLowerCase();
  return (
    (kind === "AppSearchResult" && resultType === "content") ||
    (kind === "AppEventSearchResult" && resultType === "appevent")
  );
}

/** Upstream 995fa56: keep the primary order, add fallback ids it has not seen. */
export function appendUnseenFallbackIds(
  primaryIds: string[],
  fallbackIds: string[]
): string[] {
  const seenIds = new Set(primaryIds);
  const mergedIds = [...primaryIds];
  for (const id of fallbackIds) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    mergedIds.push(id);
  }
  return mergedIds;
}

export type RankOrderSource = "mzsearch" | "searchpage" | "searchpage+mzsearch";

/**
 * Ranks from the App Store search page (~11 exact positions, what a user
 * sees) followed by MZSearch's remaining ids as the deep tail. The tail is
 * appended only when MZSearch is at least as long as the prefix; a shorter
 * MZSearch list is the less complete one, so the prefix stands alone. Any
 * search-page failure falls back to MZSearch order alone.
 */
async function resolveRatingsOrder(params: {
  keyword: string;
  country: string;
  mzSearchIds: string[];
  getStoredOrderedAppIds?: StoredOrderLookup;
}): Promise<{ orderedAppIds: string[]; orderSource: RankOrderSource }> {
  // An empty MZSearch list has already been through the empty-order guard;
  // a search-page prefix must not turn it into a short "valid" order.
  if (!ASO_ENV.rankSearchPagePrefix || params.mzSearchIds.length === 0) {
    return { orderedAppIds: params.mzSearchIds, orderSource: "mzsearch" };
  }
  let prefix: string[] = [];
  try {
    prefix = (
      await fetchSearchPageOrderedData({
        keyword: params.keyword,
        country: params.country,
        itemFilter: isOrganicAppSearchResultItem,
      })
    ).orderedAppIds;
  } catch (error) {
    logger.debug("[aso-enrichment] search-page prefix unavailable", {
      keyword: params.keyword,
      country: params.country.toUpperCase(),
      reason: error instanceof Error ? error.message : String(error),
    });
    return { orderedAppIds: params.mzSearchIds, orderSource: "mzsearch" };
  }
  if (params.mzSearchIds.length >= prefix.length) {
    return {
      orderedAppIds: appendUnseenFallbackIds(prefix, params.mzSearchIds),
      orderSource: "searchpage+mzsearch",
    };
  }
  // MZSearch came back shorter than the ~11-row prefix, so it looks degraded.
  // A prefix-only order must never replace a deeper stored one: that would
  // drop every tracked rank below ~11 overnight.
  const stored =
    params.getStoredOrderedAppIds?.(normalizeKeyword(params.keyword)) ?? null;
  if (stored && stored.length > prefix.length) {
    throw new KeywordOrderUnavailableError({
      code: "SHALLOW_ORDER",
      keyword: params.keyword,
      country: params.country,
      detail: `mzsearch=${params.mzSearchIds.length} searchpage=${prefix.length}; keeping the stored order of ${stored.length}`,
    });
  }
  return { orderedAppIds: prefix, orderSource: "searchpage" };
}

async function fetchSearchPageOrderedData(params: {
  keyword: string;
  country: string;
  itemFilter?: (item: { $kind?: string; resultType?: string }) => boolean;
}): Promise<{
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}> {
  const response = await asoAppleGet(getSearchUrl(params.country), {
    operation: "appstore.search-page",
    params: { term: params.keyword },
    headers: {
      "User-Agent": ASO_APPLE_WEB_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": getAcceptLanguage(params.country),
    },
    timeout: 30000,
  });

  const html = `${response.data || ""}`;
  const serializedDataMatch = html.match(
    /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!serializedDataMatch?.[1]) {
    throw new Error("serialized-server-data script not found in search page");
  }

  const parsed = JSON.parse(serializedDataMatch[1]) as AmpSearchResponse;
  const pageData = parsed.data?.[0]?.data;
  const searchShelf = (pageData?.shelves || []).find(
    (shelf) => shelf?.contentType === "searchResult"
  );

  const appDocs: AsoAppDoc[] = [];
  const leadingOrderedIds: string[] = [];
  const itemFilter = params.itemFilter ?? isAppLikeSearchResultItem;
  for (const item of searchShelf?.items || []) {
    if (!itemFilter(item)) {
      continue;
    }
    const lockup = item?.lockup;
    if (!lockup) continue;
    const doc = lockupToAppDoc(lockup, params.country);
    if (doc) {
      leadingOrderedIds.push(doc.appId);
      appDocs.push(doc);
    }
  }

  const tailIds = (pageData?.nextPage?.results || [])
    .filter((item) => item?.type === "apps")
    .map((item) => `${item.id || ""}`.trim())
    .filter(Boolean);
  const orderedAppIds = [...new Set([...leadingOrderedIds, ...tailIds])];
  if (orderedAppIds.length === 0) {
    throw new Error("Search page serialized data did not return ordered app ids");
  }

  return { orderedAppIds, appDocs };
}

export async function refreshKeywordOrder(params: {
  keyword: string;
  country: string;
  getStoredOrderedAppIds?: StoredOrderLookup;
}): Promise<{
  keyword: string;
  normalizedKeyword: string;
  appCount: number;
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
  /** Set in ratings mode, where difficulty is cheap enough to recompute with the order. */
  difficultyScore?: number;
  orderSource?: RankOrderSource;
}> {
  if (ASO_ENV.enrichmentMode !== "legacy") {
    const enriched = await enrichKeywordFromRatings(
      {
        keyword: params.keyword,
        country: params.country,
        popularity: 0,
      },
      params.getStoredOrderedAppIds
        ? { getStoredOrderedAppIds: params.getStoredOrderedAppIds }
        : undefined
    );
    return {
      keyword: enriched.keyword,
      normalizedKeyword: enriched.normalizedKeyword,
      appCount: enriched.appCount,
      orderedAppIds: enriched.orderedAppIds,
      appDocs: enriched.appDocs,
      difficultyScore: enriched.difficultyScore,
      orderSource: enriched.orderSource,
    };
  }
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);
  let orderedAppIds: string[] = [];
  let appDocs: AsoAppDoc[] = [];
  let sourceMode: "search-page" | "mzsearch-fallback" = "search-page";

  try {
    const searchPageData = await fetchSearchPageOrderedData({
      keyword: normalizedKeyword,
      country,
    });
    orderedAppIds = searchPageData.orderedAppIds;
    appDocs = searchPageData.appDocs;
    logger.debug("[aso-enrichment] order source", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      orderedAppIdsCount: orderedAppIds.length,
      appDocsCount: appDocs.length,
    });
  } catch (htmlErr) {
    sourceMode = "mzsearch-fallback";
    const htmlMessage =
      htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint: getSearchUrl(params.country),
      expectedContract:
        "Search page includes serialized-server-data with ordered app ids",
      actualSignal: htmlMessage,
      context: {
        keyword: params.keyword,
        country,
      },
      error: htmlErr,
      isTerminal: false,
      dedupeKey: "appstore-search-page-fallback",
    });
    orderedAppIds = await fetchPopularityOrderedIds({
      keyword: normalizedKeyword,
      country,
    });
    appDocs = [];
    logger.debug("[aso-enrichment] order source", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      fallbackReason: htmlMessage,
      orderedAppIdsCount: orderedAppIds.length,
      appDocsCount: appDocs.length,
    });
  }

  logger.debug("[aso-enrichment] order result", {
    keyword: params.keyword,
    country,
    mode: sourceMode,
    appCount: orderedAppIds.length,
    orderedAppIdsCount: orderedAppIds.length,
    appDocsCount: appDocs.length,
  });
  assertUsableOrder({
    keyword: params.keyword,
    country,
    orderedAppIds,
    clearlyEmpty: false,
    source: sourceMode,
    getStoredOrderedAppIds: params.getStoredOrderedAppIds,
  });
  return {
    keyword: params.keyword,
    normalizedKeyword,
    appCount: orderedAppIds.length,
    orderedAppIds,
    appDocs,
  };
}

type LookupDetails = {
  releaseDate: string | null;
  currentVersionReleaseDate: string | null;
  userRatingCount: number;
};

async function lookupDetailsForAppIds(params: {
  appIds: string[];
  country: string;
}): Promise<Map<string, LookupDetails>> {
  const map = new Map<string, LookupDetails>();
  if (params.appIds.length === 0) return map;
  try {
    const docs = await fetchAppStoreLookupAppDocs({
      country: params.country,
      appIds: params.appIds,
    });
    for (const doc of docs) {
      map.set(doc.appId, {
        releaseDate: doc.releaseDate ?? null,
        currentVersionReleaseDate: doc.currentVersionReleaseDate ?? null,
        userRatingCount: parseLocalizedRatingCount(
          doc.userRatingCount,
          params.country
        ),
      });
      if (!doc.releaseDate || !doc.currentVersionReleaseDate) {
        logger.debug("[aso-enrichment] lookup returned app with missing dates", {
          appId: doc.appId,
          country: params.country.toUpperCase(),
          hasReleaseDate: Boolean(doc.releaseDate),
          hasCurrentVersionReleaseDate: Boolean(doc.currentVersionReleaseDate),
        });
      }
    }
  } catch (error) {
    logger.debug("[aso-enrichment] lookup details fetch failed", {
      appIds: params.appIds,
      country: params.country.toUpperCase(),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return map;
}

async function buildAppDocsFromLookup(params: {
  appIds: string[];
  country: string;
}): Promise<AsoAppDoc[]> {
  const defaultLanguage = getStorefrontDefaultLanguage(params.country);
  let lookupDocs: AsoAppDoc[] = [];
  try {
    lookupDocs = await fetchAppStoreLookupAppDocs({
      country: params.country,
      appIds: params.appIds,
    });
  } catch {
    lookupDocs = [];
  }

  const byId = new Map(lookupDocs.map((doc) => [doc.appId, doc]));
  const results = await Promise.all(
    params.appIds.map(async (id): Promise<AsoAppDoc | null> => {
      const lookupDoc = byId.get(id);
      if (!lookupDoc) return null;
      try {
        const details = await fetchAppStoreLocalizedAppData(
          id,
          params.country,
          defaultLanguage
        );
        const additionalLocalizations = await fetchAppStoreAdditionalLocalizations(
          id,
          params.country
        );
        const averageUserRating =
          details?.ratingAverage ?? lookupDoc.averageUserRating;
        const userRatingCount =
          details?.totalNumberOfRatings == null
            ? lookupDoc.userRatingCount
            : parseLocalizedRatingCount(
                details.totalNumberOfRatings,
                params.country
              );
        return {
          ...lookupDoc,
          name: details?.title || lookupDoc.name || "Unknown",
          subtitle: details?.subtitle ?? undefined,
          averageUserRating,
          userRatingCount,
          ...(Object.keys(additionalLocalizations).length > 0
            ? { additionalLocalizations }
            : {}),
        };
      } catch {
        return lookupDoc;
      }
    })
  );

  return results.filter((d): d is AsoAppDoc => d != null);
}

function mergeSearchFieldsIntoAppDoc(
  cached: AsoAppDoc,
  searchDoc: AsoAppDoc
): AsoAppDoc {
  return {
    ...cached,
    country: searchDoc.country,
    name: searchDoc.name,
    subtitle: searchDoc.subtitle,
    publisherName: searchDoc.publisherName ?? cached.publisherName,
    averageUserRating: searchDoc.averageUserRating,
    userRatingCount: searchDoc.userRatingCount,
    icon: searchDoc.icon,
  };
}

async function hydrateMissingAdditionalLocalizations(params: {
  appDocs: AsoAppDoc[];
  appIds: string[];
  country: string;
}): Promise<AsoAppDoc[]> {
  if (params.appIds.length === 0 || params.appDocs.length === 0) {
    return params.appDocs;
  }

  const docsById = new Map(params.appDocs.map((doc) => [doc.appId, doc] as const));
  await Promise.all(
    params.appIds.map(async (appId) => {
      const existing = docsById.get(appId);
      if (!existing) return;
      if (
        existing.additionalLocalizations &&
        Object.keys(existing.additionalLocalizations).length > 0
      ) {
        return;
      }
      const additionalLocalizations = await fetchAppStoreAdditionalLocalizations(
        appId,
        params.country
      );
      if (Object.keys(additionalLocalizations).length === 0) {
        return;
      }
      docsById.set(appId, {
        ...existing,
        additionalLocalizations,
      });
    })
  );

  return params.appDocs.map((doc) => docsById.get(doc.appId) ?? doc);
}

function mergeAppDocsById(baseDocs: AsoAppDoc[], incomingDocs: AsoAppDoc[]): AsoAppDoc[] {
  if (incomingDocs.length === 0) return baseDocs;
  const merged = [...baseDocs];
  const indexById = new Map(merged.map((doc, index) => [doc.appId, index] as const));
  for (const doc of incomingDocs) {
    const existingIndex = indexById.get(doc.appId);
    if (existingIndex == null) {
      indexById.set(doc.appId, merged.length);
      merged.push(doc);
      continue;
    }
    merged[existingIndex] = doc;
  }
  return merged;
}

function hasCompleteDifficultyDoc(doc: AsoAppDoc | undefined): boolean {
  if (!doc) return false;
  return Boolean(doc.releaseDate && doc.currentVersionReleaseDate);
}

function listIncompleteTopDifficultyDocIds(params: {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}): string[] {
  const topIds = params.orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
  if (topIds.length === 0) return [];
  const docsById = new Map(params.appDocs.map((doc) => [doc.appId, doc] as const));
  return topIds.filter((id) => !hasCompleteDifficultyDoc(docsById.get(id)));
}

function reorderAppDocsForTopDifficultyIds(params: {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}): AsoAppDoc[] {
  const topIds = params.orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
  if (topIds.length === 0) return params.appDocs;
  const docsById = new Map(params.appDocs.map((doc) => [doc.appId, doc] as const));
  const topDocs = topIds
    .map((id) => docsById.get(id))
    .filter((doc): doc is AsoAppDoc => doc != null);
  const includedTopIds = new Set(topDocs.map((doc) => doc.appId));
  const remainingDocs = params.appDocs.filter((doc) => !includedTopIds.has(doc.appId));
  return [...topDocs, ...remainingDocs];
}

function getDocsForDifficultyCount(orderedAppIds: string[], appDocs: AsoAppDoc[]): number {
  const topIds = orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
  if (topIds.length === 0) return 0;
  const docsById = new Map(appDocs.map((doc) => [doc.appId, doc] as const));
  return topIds.filter((id) => hasCompleteDifficultyDoc(docsById.get(id))).length;
}

async function backfillMissingTopDifficultyDocs(params: {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
  country: string;
  cachedTopDocs?: AsoAppDoc[];
  getAppDocs?: (appIds: string[]) => Promise<AsoAppDoc[]>;
}): Promise<AsoAppDoc[]> {
  let mergedDocs = params.appDocs;
  let missingTopIds = listIncompleteTopDifficultyDocIds({
    orderedAppIds: params.orderedAppIds,
    appDocs: mergedDocs,
  });
  if (missingTopIds.length === 0) {
    return reorderAppDocsForTopDifficultyIds({
      orderedAppIds: params.orderedAppIds,
      appDocs: mergedDocs,
    });
  }

  if (params.cachedTopDocs && params.cachedTopDocs.length > 0) {
    const cachedById = new Map(
      normalizeCountryOnAppDocs(params.country, params.cachedTopDocs).map((doc) => [
        doc.appId,
        doc,
      ] as const)
    );
    const cachedMissingDocs = missingTopIds
      .map((id) => cachedById.get(id))
      .filter((doc): doc is AsoAppDoc => doc != null);
    mergedDocs = mergeAppDocsById(mergedDocs, cachedMissingDocs);
    missingTopIds = listIncompleteTopDifficultyDocIds({
      orderedAppIds: params.orderedAppIds,
      appDocs: mergedDocs,
    });
  }

  if (missingTopIds.length > 0 && params.getAppDocs) {
    const cachedDocs = normalizeCountryOnAppDocs(
      params.country,
      await params.getAppDocs(missingTopIds)
    );
    mergedDocs = mergeAppDocsById(mergedDocs, cachedDocs);
    missingTopIds = listIncompleteTopDifficultyDocIds({
      orderedAppIds: params.orderedAppIds,
      appDocs: mergedDocs,
    });
  }

  if (missingTopIds.length > 0) {
    const nowMs = Date.now();
    const lookupEligibleMissingTopIds = missingTopIds.filter(
      (appId) => !isIncompleteTopDocLookupOnCooldown(appId, nowMs)
    );
    if (lookupEligibleMissingTopIds.length > 0) {
      const lookedUpDocs = normalizeCountryOnAppDocs(
        params.country,
        await buildAppDocsFromLookup({
          appIds: lookupEligibleMissingTopIds,
          country: params.country,
        })
      );
      mergedDocs = mergeAppDocsById(mergedDocs, lookedUpDocs);
      missingTopIds = listIncompleteTopDifficultyDocIds({
        orderedAppIds: params.orderedAppIds,
        appDocs: mergedDocs,
      });
      const unresolvedLookups = lookupEligibleMissingTopIds.filter((appId) =>
        missingTopIds.includes(appId)
      );
      markIncompleteTopDocLookupCooldown(unresolvedLookups, nowMs);
    }
    const resolvedTopIds = params.orderedAppIds
      .slice(0, TOP_DIFFICULTY_DOC_LIMIT)
      .filter((appId) => !missingTopIds.includes(appId));
    clearIncompleteTopDocLookupCooldown(resolvedTopIds);
  }

  return reorderAppDocsForTopDifficultyIds({
    orderedAppIds: params.orderedAppIds,
    appDocs: mergedDocs,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type EnrichKeywordParams = {
  keyword: string;
  country: string;
  popularity: number;
};

type EnrichKeywordOptions = {
  getAppDocs?: (appIds: string[]) => Promise<AsoAppDoc[]>;
  getStoredOrderedAppIds?: StoredOrderLookup;
};

type EnrichKeywordResult = {
  keyword: string;
  normalizedKeyword: string;
  popularity: number;
  difficultyScore: number;
  minDifficultyScore: number;
  isBrandKeyword: boolean;
  appCount: number;
  keywordMatch: KeywordMatchType;
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
  /** Where the rank order came from; set in ratings mode. */
  orderSource?: RankOrderSource;
};

export async function enrichKeyword(
  params: EnrichKeywordParams,
  options?: EnrichKeywordOptions
): Promise<EnrichKeywordResult> {
  if (ASO_ENV.enrichmentMode === "legacy") {
    return enrichKeywordLegacy(params, options);
  }
  return enrichKeywordFromRatings(params, options);
}

/**
 * Two requests per keyword: MZSearch for the full ordered result list (~250
 * apps, so ranks are tracked deep), then one iTunes lookup for the top 10's
 * rating counts, names, publishers and release dates. Difficulty comes from
 * those rating counts (aso-rating-difficulty.ts).
 *
 * The App Store search page stopped carrying `nextPage` ids and now yields
 * only ~11 apps, and the legacy path needed an app page plus one page per
 * extra language for each top app — the requests Apple throttles.
 */
export async function enrichKeywordFromRatings(
  params: EnrichKeywordParams,
  options?: EnrichKeywordOptions
): Promise<EnrichKeywordResult> {
  const order = await resolveRatingsKeywordOrder(params, options);
  const lookupById = await lookupTopDocs(order.country, order.topIds);
  return finishRatingsEnrichment(params, options, order, lookupById);
}

type RatingsKeywordOrder = {
  country: string;
  normalizedKeyword: string;
  orderedAppIds: string[];
  orderSource: RankOrderSource;
  appCount: number;
  topIds: string[];
};

/** Phase 1: the rank order (MZSearch, search-page prefix, empty-order guard). */
async function resolveRatingsKeywordOrder(
  params: EnrichKeywordParams,
  options?: EnrichKeywordOptions
): Promise<RatingsKeywordOrder> {
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);

  const mzSearch = await fetchPopularityOrder({
    keyword: normalizedKeyword,
    country: params.country,
  });
  // Guard MZSearch's own list first: the search-page prefix is only ever
  // laid over a non-empty MZSearch order.
  assertUsableOrder({
    keyword: params.keyword,
    country,
    orderedAppIds: mzSearch.orderedAppIds,
    clearlyEmpty: mzSearch.clearlyEmpty,
    source: "mzsearch",
    getStoredOrderedAppIds: options?.getStoredOrderedAppIds,
  });
  const { orderedAppIds, orderSource } = await resolveRatingsOrder({
    keyword: normalizedKeyword,
    country: params.country,
    mzSearchIds: mzSearch.orderedAppIds,
    getStoredOrderedAppIds: options?.getStoredOrderedAppIds,
  });
  return {
    country,
    normalizedKeyword,
    orderedAppIds,
    orderSource,
    appCount: orderedAppIds.length,
    topIds: orderedAppIds.slice(0, RATING_DIFFICULTY_TOP_N),
  };
}

/**
 * iTunes lookup docs for these ids, served from the current run's cache
 * where possible (see observation-context), the rest fetched in 50-id
 * requests. Returns only ids Apple answered for.
 */
async function lookupTopDocs(
  country: string,
  appIds: string[]
): Promise<Map<string, AsoAppDoc>> {
  const out = new Map<string, AsoAppDoc>();
  if (appIds.length === 0) return out;
  const cache = currentRunLookupCache<AsoAppDoc>(country);
  const missing: string[] = [];
  for (const id of new Set(appIds)) {
    const cached = cache?.get(id);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const fetched = await fetchItunesLookupAppDocs({ country, appIds: missing });
    for (const [id, doc] of fetched) {
      out.set(id, doc);
      cache?.set(id, doc);
    }
  }
  return out;
}

/** Phase 2: difficulty, docs, match and brand from the order and the lookup. */
async function finishRatingsEnrichment(
  params: EnrichKeywordParams,
  options: EnrichKeywordOptions | undefined,
  order: RatingsKeywordOrder,
  allLookups: Map<string, AsoAppDoc>
): Promise<EnrichKeywordResult> {
  const { country, normalizedKeyword, orderedAppIds, orderSource, appCount, topIds } =
    order;
  // Only this keyword's top ids, so a batched lookup behaves exactly like a
  // per-keyword one (including the empty-lookup failure below).
  const lookupById = new Map<string, AsoAppDoc>();
  for (const id of topIds) {
    const doc = allLookups.get(id);
    if (doc) lookupById.set(id, doc);
  }
  if (topIds.length > 0 && lookupById.size === 0) {
    throw new InsufficientDifficultyDocsError({
      keyword: params.keyword,
      country,
      appCount,
      docsForDifficultyCount: 0,
      missingTopIds: topIds,
    });
  }

  // iTunes lookup has no subtitle; keep one we already hold so keyword-match
  // and brand detection still see it.
  const cachedById = new Map(
    (options?.getAppDocs
      ? normalizeCountryOnAppDocs(country, await options.getAppDocs(topIds))
      : []
    ).map((doc) => [doc.appId, doc] as const)
  );
  const expiresAt = computeAppExpiryIsoForApp();
  const appDocs: AsoAppDoc[] = normalizeCountryOnAppDocs(
    country,
    topIds
      .map((id): AsoAppDoc | null => {
        const fresh = lookupById.get(id);
        if (!fresh) return null;
        const cached = cachedById.get(id);
        return {
          ...fresh,
          ...(fresh.subtitle || !cached?.subtitle ? {} : { subtitle: cached.subtitle }),
          ...(cached?.additionalLocalizations
            ? { additionalLocalizations: cached.additionalLocalizations }
            : {}),
          ...(fresh.icon || !cached?.icon ? {} : { icon: cached.icon }),
          expiresAt,
        };
      })
      .filter((doc): doc is AsoAppDoc => doc != null)
  );

  const difficultyScore = calculateRatingDifficulty({
    topRatingCounts: topIds.map((id) => lookupById.get(id)?.userRatingCount ?? 0),
    resultCount: appCount,
  });

  const docsForMatch = orderedAppIds
    .slice(0, TOP_DIFFICULTY_DOC_LIMIT)
    .map((id) => appDocs.find((doc) => doc.appId === id))
    .filter((doc): doc is AsoAppDoc => doc != null);

  logger.debug("[aso-enrichment] enrich result", {
    keyword: params.keyword,
    country,
    mode: "ratings",
    orderSource,
    appCount,
    topLookedUp: lookupById.size,
    difficultyScore,
  });

  return {
    keyword: params.keyword,
    normalizedKeyword,
    popularity: params.popularity,
    difficultyScore,
    minDifficultyScore: difficultyScore,
    isBrandKeyword: detectIsBrandKeyword(params.keyword, docsForMatch),
    appCount,
    keywordMatch: detectTopKeywordMatchType(docsForMatch, params.keyword),
    orderedAppIds,
    appDocs,
    orderSource,
  };
}

export type KeywordOrderBatchOutcome =
  | {
      keyword: string;
      ok: true;
      value: Awaited<ReturnType<typeof refreshKeywordOrder>>;
      /** When this keyword's order was fetched from Apple. */
      observedAt: string;
    }
  | { keyword: string; ok: false; error: unknown };

/**
 * Order refresh for a batch of keywords with one merged iTunes lookup.
 *
 * Ratings mode used to look up each keyword's top 10 separately - 25
 * keywords, 25 lookup requests, with heavy overlap between related
 * keywords. Here every keyword's order is resolved first (MZSearch and the
 * search page, one keyword at a time as before), then the union of their
 * top-10 ids is looked up in 50-id requests (through the run cache), then
 * each keyword is scored from its own top 10. Per-keyword results and
 * failures are identical to calling refreshKeywordOrder one by one; only
 * the number of lookup requests changes. Legacy mode is unchanged.
 */
export async function refreshKeywordOrdersBatch(params: {
  country: string;
  keywords: string[];
  getStoredOrderedAppIds?: StoredOrderLookup;
}): Promise<KeywordOrderBatchOutcome[]> {
  const outcomes: KeywordOrderBatchOutcome[] = [];
  if (ASO_ENV.enrichmentMode === "legacy") {
    for (const keyword of params.keywords) {
      try {
        const value = await refreshKeywordOrder({
          keyword,
          country: params.country,
          getStoredOrderedAppIds: params.getStoredOrderedAppIds,
        });
        outcomes.push({ keyword, ok: true, value, observedAt: new Date().toISOString() });
      } catch (error) {
        outcomes.push({ keyword, ok: false, error });
      }
    }
    return outcomes;
  }

  const options: EnrichKeywordOptions | undefined = params.getStoredOrderedAppIds
    ? { getStoredOrderedAppIds: params.getStoredOrderedAppIds }
    : undefined;
  const ordered: Array<{
    keyword: string;
    order: RatingsKeywordOrder;
    observedAt: string;
  }> = [];
  // ASO_SEARCH_CONCURRENCY workers (default 1). More workers only fill the
  // per-host request schedule faster; the limiter caps the rate.
  let cursor = 0;
  const resolveNext = async (): Promise<void> => {
    while (cursor < params.keywords.length) {
      const keyword = params.keywords[cursor];
      cursor += 1;
      try {
        const order = await resolveRatingsKeywordOrder(
          { keyword, country: params.country, popularity: 0 },
          options
        );
        ordered.push({ keyword, order, observedAt: new Date().toISOString() });
      } catch (error) {
        outcomes.push({ keyword, ok: false, error });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(ASO_ENV.searchConcurrency, params.keywords.length)) },
      () => resolveNext()
    )
  );
  // Score in input order whatever order the workers finished in.
  const inputRank = new Map(params.keywords.map((keyword, index) => [keyword, index]));
  ordered.sort((a, b) => (inputRank.get(a.keyword) ?? 0) - (inputRank.get(b.keyword) ?? 0));

  const country = params.country.toUpperCase();
  const lookups = await lookupTopDocs(
    country,
    ordered.flatMap((entry) => entry.order.topIds)
  );
  for (const { keyword, order, observedAt } of ordered) {
    try {
      const enriched = await finishRatingsEnrichment(
        { keyword, country: params.country, popularity: 0 },
        options,
        order,
        lookups
      );
      outcomes.push({
        keyword,
        ok: true,
        value: {
          keyword: enriched.keyword,
          normalizedKeyword: enriched.normalizedKeyword,
          appCount: enriched.appCount,
          orderedAppIds: enriched.orderedAppIds,
          appDocs: enriched.appDocs,
          difficultyScore: enriched.difficultyScore,
          orderSource: enriched.orderSource,
        },
        observedAt,
      });
    } catch (error) {
      outcomes.push({ keyword, ok: false, error });
    }
  }
  // Callers match by keyword, but keep the input order for predictability.
  const rank = new Map(params.keywords.map((keyword, index) => [keyword, index]));
  return outcomes.sort((a, b) => (rank.get(a.keyword) ?? 0) - (rank.get(b.keyword) ?? 0));
}

async function enrichKeywordLegacy(
  params: EnrichKeywordParams,
  options?: EnrichKeywordOptions
): Promise<EnrichKeywordResult> {
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);
  let orderedAppIds: string[] = [];
  let appDocs: AsoAppDoc[] = [];
  let cachedTopDocs: AsoAppDoc[] = [];
  let usedSearchPage = false;
  let sourceMode: "search-page" | "mzsearch-fallback" = "search-page";

  try {
    const searchPageData = await fetchSearchPageOrderedData({
      keyword: normalizedKeyword,
      country,
    });
    orderedAppIds = searchPageData.orderedAppIds;
    appDocs = searchPageData.appDocs;
    usedSearchPage = true;
    logger.debug("[aso-enrichment] enrich source", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      orderedAppIdsCount: orderedAppIds.length,
      appDocsCount: appDocs.length,
    });
  } catch (htmlErr) {
    sourceMode = "mzsearch-fallback";
    const htmlMessage =
      htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint: getSearchUrl(params.country),
      expectedContract:
        "Search page includes serialized-server-data with ordered app ids and lockups",
      actualSignal: htmlMessage,
      context: {
        keyword: params.keyword,
        country,
      },
      error: htmlErr,
      isTerminal: false,
      dedupeKey: "appstore-search-page-fallback",
    });
    orderedAppIds = await fetchPopularityOrderedIds({
      keyword: normalizedKeyword,
      country: params.country,
    });
    const firstFiveIds = orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
    appDocs = await buildAppDocsFromLookup({
      appIds: firstFiveIds,
      country: params.country,
    });
    logger.debug("[aso-enrichment] enrich source", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      fallbackReason: htmlMessage,
      orderedAppIdsCount: orderedAppIds.length,
      appDocsCount: appDocs.length,
    });
  }

  const appCount = orderedAppIds.length;
  const firstFiveIds = orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);

  if (usedSearchPage && appDocs.length > 0) {
    cachedTopDocs = options?.getAppDocs
      ? normalizeCountryOnAppDocs(country, await options.getAppDocs(firstFiveIds))
      : [];
    const cachedByAppId = new Map(
      cachedTopDocs.map((d) => [d.appId, d] as const)
    );
    const searchDocByAppId = new Map(appDocs.map((doc) => [doc.appId, doc] as const));
    const now = Date.now();
    const idsThatNeedLookup = firstFiveIds.filter((id) => {
      const searchDoc = searchDocByAppId.get(id);
      if (!searchDoc) return false;
      const c = cachedByAppId.get(id);
      const hasStaleOrMissingCache = !c || Date.parse(c.expiresAt ?? "0") <= now;
      const hasIncompleteDifficultyFields =
        c != null && (!c.releaseDate || !c.currentVersionReleaseDate);
      if (!hasStaleOrMissingCache && !hasIncompleteDifficultyFields) {
        return false;
      }
      return !isIncompleteTopDocLookupOnCooldown(id, now);
    });
    const lookupDetailsByAppId =
      idsThatNeedLookup.length > 0
        ? await lookupDetailsForAppIds({
            appIds: idsThatNeedLookup,
            country: params.country,
          })
        : new Map<
            string,
            {
              releaseDate: string | null;
              currentVersionReleaseDate: string | null;
              userRatingCount: number;
            }
          >();
    const mergedFirstFive: AsoAppDoc[] = firstFiveIds
      .map((id) => {
        const searchDoc = appDocs.find((d) => d.appId === id);
        if (!searchDoc) return null;
        const cached = cachedByAppId.get(id);
        const needLookup =
          !cached ||
          Date.parse(cached.expiresAt ?? "0") <= now ||
          !cached.releaseDate ||
          !cached.currentVersionReleaseDate;
        if (cached && !needLookup) {
          const merged = mergeSearchFieldsIntoAppDoc(cached, searchDoc);
          return { ...merged, expiresAt: cached.expiresAt };
        }
        const merged: AsoAppDoc = { ...searchDoc };
        const details = lookupDetailsByAppId.get(id);
        if (details) {
          merged.releaseDate = details.releaseDate ?? undefined;
          merged.currentVersionReleaseDate =
            details.currentVersionReleaseDate ?? undefined;
          merged.userRatingCount = parseLocalizedRatingCount(
            details.userRatingCount,
            country
          );
          if (!details.releaseDate || !details.currentVersionReleaseDate) {
            logger.debug("[aso-enrichment] merged lookup details missing dates", {
              appId: id,
              country,
              hasReleaseDate: Boolean(details.releaseDate),
              hasCurrentVersionReleaseDate: Boolean(details.currentVersionReleaseDate),
            });
          }
        } else {
          logger.debug("[aso-enrichment] no lookup details for app", {
            appId: id,
            country,
          });
        }
        merged.expiresAt = computeAppExpiryIsoForApp();
        return merged;
      })
      .filter((d): d is AsoAppDoc => d != null);
    appDocs = mergedFirstFive.concat(
      appDocs.filter((d) => !firstFiveIds.includes(d.appId))
    );
  }

  for (const doc of appDocs) {
    if (!doc.expiresAt && firstFiveIds.includes(doc.appId)) {
      doc.expiresAt = computeAppExpiryIsoForApp();
    }
  }
  appDocs = normalizeCountryOnAppDocs(country, appDocs);
  appDocs = await hydrateMissingAdditionalLocalizations({
    appDocs,
    appIds: firstFiveIds,
    country,
  });

  let missingTopIds = listIncompleteTopDifficultyDocIds({
    orderedAppIds,
    appDocs,
  });
  let docsForDifficultyCount = getDocsForDifficultyCount(orderedAppIds, appDocs);

  if (requiresTopDifficultyDocs(appCount) && missingTopIds.length > 0) {
    appDocs = await backfillMissingTopDifficultyDocs({
      orderedAppIds,
      appDocs,
      country,
      cachedTopDocs,
      getAppDocs: options?.getAppDocs,
    });
    missingTopIds = listIncompleteTopDifficultyDocIds({
      orderedAppIds,
      appDocs,
    });
    docsForDifficultyCount = getDocsForDifficultyCount(orderedAppIds, appDocs);

    for (
      let attempt = 0;
      attempt < INSUFFICIENT_DOCS_RETRY_COUNT &&
      requiresTopDifficultyDocs(appCount) &&
      missingTopIds.length > 0;
      attempt += 1
    ) {
      await sleep(INSUFFICIENT_DOCS_RETRY_BACKOFF_MS);
      appDocs = await backfillMissingTopDifficultyDocs({
        orderedAppIds,
        appDocs,
        country,
        getAppDocs: options?.getAppDocs,
      });
      missingTopIds = listIncompleteTopDifficultyDocIds({
        orderedAppIds,
        appDocs,
      });
      docsForDifficultyCount = getDocsForDifficultyCount(orderedAppIds, appDocs);
    }
  }

  for (const doc of appDocs) {
    if (!doc.expiresAt && firstFiveIds.includes(doc.appId)) {
      doc.expiresAt = computeAppExpiryIsoForApp();
    }
  }

  const docsForDifficulty = firstFiveIds
    .map((id) => appDocs.find((d) => d.appId === id))
    .filter((d): d is AsoAppDoc => d != null);
  const keywordMatch = detectTopKeywordMatchType(docsForDifficulty, params.keyword);
  const isBrandKeyword = detectIsBrandKeyword(params.keyword, docsForDifficulty);

  if (appCount < TOP_DIFFICULTY_DOC_LIMIT) {
    logger.debug("[aso-enrichment] returning fallback difficulty due to insufficient docs", {
      keyword: params.keyword,
      country,
      appCount,
      docsForDifficultyCount,
      requiredDocsCount: TOP_DIFFICULTY_DOC_LIMIT,
    });
    logger.debug("[aso-enrichment] enrich result", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      fallbackDifficulty: true,
      appCount,
      orderedAppIdsCount: orderedAppIds.length,
      appDocsCount: appDocs.length,
      docsForDifficultyCount,
    });
    return {
      keyword: params.keyword,
      normalizedKeyword,
      popularity: params.popularity,
      difficultyScore: 1,
      minDifficultyScore: 1,
      isBrandKeyword,
      appCount,
      keywordMatch,
      orderedAppIds,
      appDocs,
    };
  }

  if (
    !hasRequiredTopDifficultyDocs({
      appCount,
      docsForDifficultyCount,
    })
  ) {
    logger.debug("[aso-enrichment] insufficient top docs for difficulty scoring", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      appCount,
      docsForDifficultyCount,
      expectedDocsForDifficultyCount: TOP_DIFFICULTY_DOC_LIMIT,
      missingTopIds,
    });
    throw new InsufficientDifficultyDocsError({
      keyword: params.keyword,
      country,
      appCount,
      docsForDifficultyCount,
      missingTopIds,
    });
  }

  const competitiveScores = docsForDifficulty.map((app) =>
    appCompetitiveScore(app, params.keyword)
  );
  const difficulty = calculateKeywordDifficultyBreakdown({
    competitiveScores,
    appCount,
  });

  logger.debug("[aso-enrichment] enrich result", {
    keyword: params.keyword,
    country,
    mode: sourceMode,
    fallbackDifficulty: false,
    appCount,
    orderedAppIdsCount: orderedAppIds.length,
    appDocsCount: appDocs.length,
    docsForDifficultyCount,
  });
  return {
    keyword: params.keyword,
    normalizedKeyword,
    popularity: params.popularity,
    difficultyScore: difficulty.difficultyScore,
    minDifficultyScore: difficulty.minDifficultyScore,
    isBrandKeyword,
    appCount,
    keywordMatch,
    orderedAppIds,
    appDocs,
  };
}
