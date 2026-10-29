import { logger } from "../../utils/logger";
import {
  isAsoAuthReauthRequiredError,
  summarizeFailedPopularityKeywords,
} from "./aso-popularity-service";
import { fetchKeywordPopularitiesPreferringAdsApi } from "./aso-popularity-source";
import type {
  AsoCacheLookupResponse,
  AsoKeywordItem,
  FailedKeyword,
  FilteredKeyword,
  KeywordFetchResult,
} from "./aso-types";
import type { StoredAsoKeyword } from "../../db/types";
import {
  enrichAsoKeywordsLocal,
  lookupAsoCacheLocal,
  refreshAsoKeywordOrderLocal,
} from "./aso-local-cache-service";
import { normalizeKeyword } from "../../shared/aso-keyword-utils";
import { getKeywords } from "../../db/aso-keywords";
import { listKeywordFailuresForApp } from "../../db/aso-keyword-failures";
import {
  isCompleteStoredAsoKeyword,
  isStoredKeywordOrderFresh,
  isStoredKeywordPopularityFresh,
  type CompleteStoredAsoKeyword,
} from "../../shared/aso-keyword-validity";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_CALL_ERROR,
} from "../../shared/aso-keyword-limits";
import { normalizeAppleUpstreamError } from "../../shared/apple-upstream-error";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import { keywordWriteRepository } from "./keyword-write-repository";

export type PendingKeywordPopularityItem = {
  keyword: string;
  popularity: number;
};

export type KeywordPopularityStageResult = {
  hits: AsoKeywordItem[];
  pendingItems: PendingKeywordPopularityItem[];
  orderRefreshKeywords: string[];
  failedKeywords: FailedKeyword[];
  filteredOut: FilteredKeyword[];
};

type KeywordPopularityStageOptions = {
  allowInteractiveAuthRecovery?: boolean;
  filters?: KeywordFilterOptions;
};

export type KeywordFetchOptions = KeywordPopularityStageOptions & {
  /**
   * Return the envelope even when every keyword failed, instead of throwing
   * "All keywords failed". The background refresh wants the per-keyword
   * reasons to count them, not one opaque error for the whole batch.
   */
  resolveWhenAllFail?: boolean;
};

/**
 * Outcome of one background-refresh batch for one storefront.
 *
 * `failedKeywords` are keywords whose ranking was not refreshed this pass;
 * their stored row is left exactly as it was. `popularityFailures` are
 * recorded separately because a popularity failure no longer stops the
 * ranking crawl: a keyword can appear there and in `items` at once.
 */
export type StartupRefreshBatchResult = {
  items: AsoKeywordItem[];
  failedKeywords: FailedKeyword[];
  popularityFailures: FailedKeyword[];
  /** Not attempted: never enriched and the Apple session is unavailable. */
  skippedKeywords: string[];
  /** Set when the popularity stage found the Apple session dead. */
  reauthError: unknown | null;
};

export type ForceRefreshOptions = {
  allowInteractiveAuthRecovery?: boolean;
};

export type KeywordFilterOptions = {
  minPopularity?: number;
  maxDifficulty?: number;
};

type RefreshOrderOptions = {
  preserveUpdatedAt?: boolean;
};

type EnrichmentOutcome = {
  item: AsoKeywordItem | null;
  failedKeyword: FailedKeyword | null;
};

function validateKeywordCount(keywords: string[]): void {
  if (keywords.length > ASO_MAX_KEYWORDS) {
    throw new Error(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
  }
}

function chunkKeywords(keywords: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < keywords.length; index += ASO_MAX_KEYWORDS) {
    chunks.push(keywords.slice(index, index + ASO_MAX_KEYWORDS));
  }
  return chunks;
}

function stripTimestamps(item: AsoKeywordItem): AsoKeywordItem {
  const { createdAt, updatedAt, ...rest } = item;
  return rest;
}

function summarizeFailedKeywords(failures: FailedKeyword[]): string {
  if (failures.length === 0) return "none";
  const preview = failures
    .slice(0, 5)
    .map((failure) => {
      const statusSuffix =
        failure.statusCode != null ? `(${failure.statusCode})` : "";
      return `${failure.keyword}:${failure.reasonCode}${statusSuffix}`;
    })
    .join(", ");
  return failures.length > 5
    ? `${preview} (+${failures.length - 5} more)`
    : preview;
}

function isBelowMinPopularity(
  popularity: number,
  filters?: KeywordFilterOptions
): boolean {
  return (
    filters?.minPopularity != null &&
    Number.isFinite(popularity) &&
    popularity < filters.minPopularity
  );
}

function isAboveMaxDifficulty(
  difficultyScore: number,
  filters?: KeywordFilterOptions
): boolean {
  return (
    filters?.maxDifficulty != null &&
    Number.isFinite(difficultyScore) &&
    difficultyScore > filters.maxDifficulty
  );
}

function dedupeFilteredOut(items: FilteredKeyword[]): FilteredKeyword[] {
  if (items.length <= 1) return items;
  const seen = new Set<string>();
  const deduped: FilteredKeyword[] = [];
  for (const item of items) {
    const normalizedKeyword = normalizeKeyword(item.keyword);
    const dedupeKey = `${normalizedKeyword}:${item.reason}`;
    if (!normalizedKeyword || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push({
      ...item,
      keyword: normalizedKeyword,
    });
  }
  return deduped;
}

function toPopularityFailureFromError(
  keyword: string,
  error: unknown
): FailedKeyword {
  const normalized = normalizeAppleUpstreamError({
    error,
    operation: "keyword-popularity",
    defaultReasonCode: "POPULARITY_FAILED",
  });
  return {
    keyword,
    stage: "popularity",
    reasonCode: normalized.reasonCode,
    message: normalized.message,
    statusCode: normalized.statusCode,
    retryable: normalized.retryable,
    attempts: normalized.attempts,
    requestId: normalized.requestId,
  };
}

function toEnrichmentFailureFromError(
  keyword: string,
  error: unknown
): FailedKeyword {
  const normalized = normalizeAppleUpstreamError({
    error,
    operation: "keyword-enrichment",
    defaultReasonCode: "ENRICHMENT_FAILED",
  });
  return {
    keyword,
    stage: "enrichment",
    reasonCode: normalized.reasonCode,
    message: normalized.message,
    statusCode: normalized.statusCode,
    retryable: normalized.retryable,
    attempts: normalized.attempts,
    requestId: normalized.requestId,
  };
}

const THROTTLE_REASON_PATTERN = /RATE_?LIMIT|THROTTL|TOO_MANY_REQUESTS/i;

function isThrottleFailure(failure: FailedKeyword): boolean {
  return (
    failure.statusCode === 429 || THROTTLE_REASON_PATTERN.test(failure.reasonCode)
  );
}

type MissClassification = {
  pendingItems: PendingKeywordPopularityItem[];
  popularityFetchKeywords: string[];
  orderRefreshKeywords: string[];
};

function classifyMisses(country: string, misses: string[]): MissClassification {
  const pendingItems: PendingKeywordPopularityItem[] = [];
  const popularityFetchKeywords: string[] = [];
  const orderRefreshKeywords: string[] = [];
  const nowMs = Date.now();
  const existingByNormalized = new Map(
    getKeywords(country, misses).map((keyword) => [
      keyword.normalizedKeyword,
      keyword,
    ])
  );

  for (const keyword of misses) {
    const existing = existingByNormalized.get(keyword);
    if (!existing || !Number.isFinite(existing.popularity)) {
      popularityFetchKeywords.push(keyword);
      continue;
    }
    const popularityFresh = isStoredKeywordPopularityFresh(existing, nowMs);
    if (!popularityFresh) {
      popularityFetchKeywords.push(keyword);
      continue;
    }
    if (!isCompleteStoredAsoKeyword(existing)) {
      pendingItems.push({ keyword, popularity: existing.popularity });
      continue;
    }
    if (!isStoredKeywordOrderFresh(existing, nowMs)) {
      orderRefreshKeywords.push(keyword);
      continue;
    }
    pendingItems.push({ keyword, popularity: existing.popularity });
  }

  return { pendingItems, popularityFetchKeywords, orderRefreshKeywords };
}

function toAsoKeywordItem(
  item: CompleteStoredAsoKeyword<StoredAsoKeyword>
): AsoKeywordItem {
  return {
    keyword: item.keyword,
    normalizedKeyword: item.normalizedKeyword,
    country: item.country,
    popularity: item.popularity,
    difficultyScore: item.difficultyScore,
    minDifficultyScore: item.minDifficultyScore,
    isBrandKeyword: item.isBrandKeyword,
    appCount: item.appCount,
    keywordMatch: item.keywordMatch,
    orderedAppIds: item.orderedAppIds,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    orderExpiresAt: item.orderExpiresAt,
    popularityExpiresAt: item.popularityExpiresAt,
  };
}

export class KeywordPipelineService {
  normalizeKeywords(input: string[]): string[] {
    const unique = new Set<string>();
    for (const keyword of input) {
      const normalized = normalizeKeyword(keyword);
      if (normalized) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  parseKeywords(raw: string | undefined): string[] {
    if (raw == null || String(raw).trim() === "") return [];
    return this.normalizeKeywords(String(raw).split(","));
  }

  private createEmptyEnrichmentResult(): {
    items: AsoKeywordItem[];
    failedKeywords: FailedKeyword[];
  } {
    return {
      items: [],
      failedKeywords: [],
    };
  }

  private getEnrichmentWorkerCount(itemCount: number): number {
    if (itemCount <= 0) return 0;
    const configuredConcurrency = Math.max(
      1,
      Math.floor(getAsoResilienceConfig().keywordEnrichmentConcurrency)
    );
    return Math.min(configuredConcurrency, itemCount);
  }

  private findMatchedEnrichedItem(
    keyword: string,
    items: AsoKeywordItem[]
  ): AsoKeywordItem | null {
    if (items.length === 0) return null;
    const normalizedKeyword = normalizeKeyword(keyword);
    return (
      items.find(
        (item) => normalizeKeyword(item.keyword) === normalizedKeyword
      ) ??
      items[0] ??
      null
    );
  }

  private findMatchedFailedKeyword(
    keyword: string,
    failures: FailedKeyword[]
  ): FailedKeyword | null {
    if (failures.length === 0) return null;
    const normalizedKeyword = normalizeKeyword(keyword);
    return (
      failures.find(
        (failure) => normalizeKeyword(failure.keyword) === normalizedKeyword
      ) ??
      failures[0] ??
      null
    );
  }

  private createMissingEnrichmentOutcome(keyword: string): EnrichmentOutcome {
    return {
      item: null,
      failedKeyword: toEnrichmentFailureFromError(
        keyword,
        new Error(
          `Keyword enrichment returned no item/failure for keyword "${keyword}".`
        )
      ),
    };
  }

  private persistEnrichmentOutcome(
    country: string,
    outcome: EnrichmentOutcome
  ): void {
    if (outcome.item) {
      keywordWriteRepository.clearFailures(country, [outcome.item.keyword]);
      return;
    }
    if (outcome.failedKeyword) {
      keywordWriteRepository.persistFailures(country, [outcome.failedKeyword]);
    }
  }

  private async enrichSinglePendingKeyword(
    country: string,
    pendingItem: PendingKeywordPopularityItem
  ): Promise<EnrichmentOutcome> {
    try {
      const singleResult = await enrichAsoKeywordsLocal(country, [pendingItem]);
      const matchedItem = this.findMatchedEnrichedItem(
        pendingItem.keyword,
        singleResult.items
      );
      if (matchedItem) {
        return {
          item: matchedItem,
          failedKeyword: null,
        };
      }

      const matchedFailure = this.findMatchedFailedKeyword(
        pendingItem.keyword,
        singleResult.failedKeywords
      );
      if (matchedFailure) {
        return {
          item: null,
          failedKeyword: matchedFailure,
        };
      }

      return this.createMissingEnrichmentOutcome(pendingItem.keyword);
    } catch (error) {
      return {
        item: null,
        failedKeyword: toEnrichmentFailureFromError(pendingItem.keyword, error),
      };
    }
  }

  private async populateEnrichmentOutcomes(
    country: string,
    items: PendingKeywordPopularityItem[],
    outcomes: EnrichmentOutcome[]
  ): Promise<void> {
    const workerCount = this.getEnrichmentWorkerCount(items.length);
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (cursor < items.length) {
        const currentIndex = cursor;
        cursor += 1;
        const outcome = await this.enrichSinglePendingKeyword(
          country,
          items[currentIndex]
        );
        this.persistEnrichmentOutcome(country, outcome);
        outcomes[currentIndex] = outcome;
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  }

  private buildEnrichmentResult(outcomes: EnrichmentOutcome[]): {
    items: AsoKeywordItem[];
    failedKeywords: FailedKeyword[];
  } {
    return {
      items: outcomes.flatMap((outcome) =>
        outcome?.item ? [outcome.item] : []
      ),
      failedKeywords: outcomes.flatMap((outcome) =>
        outcome?.failedKeyword ? [outcome.failedKeyword] : []
      ),
    };
  }

  async runPopularityStage(
    country: string,
    keywords: string[],
    options?: KeywordPopularityStageOptions
  ): Promise<KeywordPopularityStageResult> {
    validateKeywordCount(keywords);
    const filters = options?.filters;
    const filteredOut: FilteredKeyword[] = [];

    logger.debug(`Checking backend cache for ${keywords.length} keywords...`);
    const lookupData = (await lookupAsoCacheLocal(
      country,
      keywords
    )) as AsoCacheLookupResponse;
    const hits = lookupData.hits.filter((item) => {
      if (!isBelowMinPopularity(item.popularity, filters)) {
        return true;
      }
      filteredOut.push({
        keyword: item.keyword,
        reason: "low_popularity",
        popularity: item.popularity,
        difficulty: item.difficultyScore,
        minDifficultyScore: item.minDifficultyScore,
        isBrandKeyword: item.isBrandKeyword,
      });
      return false;
    });

    if (lookupData.misses.length === 0) {
      return {
        hits,
        pendingItems: [],
        orderRefreshKeywords: [],
        failedKeywords: [],
        filteredOut: dedupeFilteredOut(filteredOut),
      };
    }

    const classified = classifyMisses(country, lookupData.misses);
    const failedKeywords: FailedKeyword[] = [];
    let fetchedPendingItems: PendingKeywordPopularityItem[] = [];
    if (classified.popularityFetchKeywords.length > 0) {
      logger.debug(
        `Cache misses requiring popularity fetch: ${classified.popularityFetchKeywords.length}. Fetching popularities locally...`
      );
      const popularityResult = await fetchKeywordPopularitiesPreferringAdsApi(
        country,
        classified.popularityFetchKeywords,
        options?.allowInteractiveAuthRecovery === false
          ? { allowInteractiveAuthRecovery: false }
          : undefined
      );
      const fetchedPopularityItems = classified.popularityFetchKeywords
        .filter((keyword) => popularityResult.popularities[keyword] != null)
        .map((keyword) => ({
          keyword,
          popularity: popularityResult.popularities[keyword] ?? 1,
        }));
      fetchedPendingItems = fetchedPopularityItems.filter((item) => {
        if (!isBelowMinPopularity(item.popularity, filters)) {
          return true;
        }
        filteredOut.push({
          keyword: item.keyword,
          reason: "low_popularity",
          popularity: item.popularity,
          isBrandKeyword: null,
        });
        return false;
      });
      failedKeywords.push(...popularityResult.failedKeywords);
      if (fetchedPopularityItems.length > 0) {
        keywordWriteRepository.upsertPopularityOnly(
          country,
          fetchedPopularityItems
        );
      }
      const popularityFailureSummary = summarizeFailedPopularityKeywords(
        popularityResult.failedKeywords
      );
      if (popularityFailureSummary) {
        logger.debug(
          `[keyword-pipeline] popularity failures=${popularityResult.failedKeywords.length} details=${popularityFailureSummary}`
        );
      }
    }

    const reusedByKeyword = new Map<string, PendingKeywordPopularityItem>();
    for (const item of classified.pendingItems) {
      if (isBelowMinPopularity(item.popularity, filters)) {
        filteredOut.push({
          keyword: item.keyword,
          reason: "low_popularity",
          popularity: item.popularity,
          isBrandKeyword: null,
        });
        continue;
      }
      reusedByKeyword.set(item.keyword, item);
    }
    const fetchedByKeyword = new Map(
      fetchedPendingItems.map((item) => [item.keyword, item] as const)
    );
    const pendingItems = lookupData.misses
      .map(
        (keyword) =>
          reusedByKeyword.get(keyword) ?? fetchedByKeyword.get(keyword)
      )
      .filter((item): item is PendingKeywordPopularityItem => item != null);
    const existingByKeyword = new Map(
      getKeywords(country, classified.orderRefreshKeywords).map((keyword) => [
        keyword.normalizedKeyword,
        keyword,
      ])
    );
    const orderRefreshKeywords = classified.orderRefreshKeywords.filter(
      (keyword) => {
        const existing = existingByKeyword.get(keyword);
        if (
          existing &&
          Number.isFinite(existing.popularity) &&
          isBelowMinPopularity(existing.popularity, filters)
        ) {
          filteredOut.push({
            keyword: existing.keyword,
            reason: "low_popularity",
            popularity: existing.popularity,
            difficulty: existing.difficultyScore ?? undefined,
            minDifficultyScore: existing.minDifficultyScore,
            isBrandKeyword: existing.isBrandKeyword,
          });
          return false;
        }
        return true;
      }
    );

    keywordWriteRepository.persistFailures(country, failedKeywords);

    return {
      hits,
      pendingItems,
      orderRefreshKeywords,
      failedKeywords,
      filteredOut: dedupeFilteredOut(filteredOut),
    };
  }

  async enrichAndPersist(
    country: string,
    items: PendingKeywordPopularityItem[]
  ): Promise<{ items: AsoKeywordItem[]; failedKeywords: FailedKeyword[] }> {
    if (items.length === 0) {
      return this.createEmptyEnrichmentResult();
    }
    logger.debug("Sending popularity data to backend for enrichment...");
    const outcomes: EnrichmentOutcome[] = new Array(items.length);
    await this.populateEnrichmentOutcomes(country, items, outcomes);
    return this.buildEnrichmentResult(outcomes);
  }

  persistBackgroundEnrichmentCrashFailures(
    country: string,
    items: PendingKeywordPopularityItem[],
    error: unknown
  ): void {
    if (items.length === 0) return;

    const normalizedError = normalizeAppleUpstreamError({
      error,
      operation: "keyword-enrichment",
      defaultReasonCode: "ENRICHMENT_FAILED",
    });
    const normalizedPendingKeywords = this.normalizeKeywords(
      items.map((item) => item.keyword)
    );
    if (normalizedPendingKeywords.length === 0) return;

    const existingByKeyword = new Map(
      getKeywords(country, normalizedPendingKeywords).map((keyword) => [
        keyword.normalizedKeyword,
        keyword,
      ])
    );
    const unresolvedPendingKeywords = normalizedPendingKeywords.filter(
      (keyword) => !isCompleteStoredAsoKeyword(existingByKeyword.get(keyword))
    );
    if (unresolvedPendingKeywords.length === 0) return;

    keywordWriteRepository.persistFailures(
      country,
      unresolvedPendingKeywords.map((keyword) => ({
        keyword,
        stage: "enrichment",
        reasonCode: normalizedError.reasonCode,
        message: normalizedError.message,
        statusCode: normalizedError.statusCode,
        retryable: normalizedError.retryable,
        attempts: normalizedError.attempts,
        requestId: normalizedError.requestId,
      }))
    );
  }

  async refreshOrder(
    country: string,
    keywords: string[],
    options: RefreshOrderOptions = {}
  ): Promise<AsoKeywordItem[]> {
    const result = await this.refreshOrderWithFailures(
      country,
      keywords,
      options
    );
    return result.items;
  }

  /**
   * Re-crawls the ranking for keywords that already have a complete row.
   *
   * A keyword whose crawl fails keeps its previous row untouched (updatedAt
   * does not move) and is returned in `failedKeywords`. Those failures are not
   * written to aso_keyword_failures: the stored data is still valid, only
   * stale, and a failure row would flip the keyword to "failed" in the API.
   */
  async refreshOrderWithFailures(
    country: string,
    keywords: string[],
    options: RefreshOrderOptions = {}
  ): Promise<{ items: AsoKeywordItem[]; failedKeywords: FailedKeyword[] }> {
    if (keywords.length === 0) return { items: [], failedKeywords: [] };
    const normalized = this.normalizeKeywords(keywords);
    const existingByNormalized = new Map(
      getKeywords(country, normalized).map((keyword) => [
        keyword.normalizedKeyword,
        keyword,
      ])
    );
    const refreshed: AsoKeywordItem[] = [];
    const failedKeywords: FailedKeyword[] = [];
    const positionCapturedAtByKeyword = new Map<string, string>();

    for (const keyword of normalized) {
      const existing = existingByNormalized.get(keyword);
      if (!isCompleteStoredAsoKeyword(existing)) continue;

      let updatedOrder: {
        keyword: string;
        normalizedKeyword: string;
        appCount: number;
        orderedAppIds: string[];
        difficultyScore?: number;
      } | null = null;
      try {
        updatedOrder = await refreshAsoKeywordOrderLocal(country, keyword);
      } catch (error) {
        const failure = toEnrichmentFailureFromError(keyword, error);
        failedKeywords.push(failure);
        logger.warn(
          `[keyword-pipeline] order refresh failed country=${country} keyword=${keyword} reason=${failure.reasonCode} message=${failure.message}`
        );
        continue;
      }
      if (!updatedOrder) {
        failedKeywords.push(
          toEnrichmentFailureFromError(
            keyword,
            new Error(`Order refresh returned nothing for keyword "${keyword}".`)
          )
        );
        continue;
      }
      const positionCapturedAt = new Date().toISOString();
      const refreshedItem: AsoKeywordItem = {
        keyword: existing.keyword,
        normalizedKeyword: existing.normalizedKeyword,
        country: existing.country,
        popularity: existing.popularity,
        difficultyScore: updatedOrder.difficultyScore ?? existing.difficultyScore,
        minDifficultyScore: updatedOrder.difficultyScore ?? existing.minDifficultyScore,
        isBrandKeyword: existing.isBrandKeyword,
        appCount: updatedOrder.appCount,
        keywordMatch: existing.keywordMatch,
        orderedAppIds: updatedOrder.orderedAppIds,
        createdAt: existing.createdAt,
        updatedAt: options.preserveUpdatedAt
          ? existing.updatedAt
          : positionCapturedAt,
        orderExpiresAt: existing.orderExpiresAt,
        popularityExpiresAt: existing.popularityExpiresAt,
      };
      refreshed.push(refreshedItem);
      positionCapturedAtByKeyword.set(
        existing.normalizedKeyword,
        positionCapturedAt
      );
    }

    if (refreshed.length > 0) {
      keywordWriteRepository.upsertKeywordItems(
        country,
        refreshed.map((item) => ({
          keyword: item.keyword,
          normalizedKeyword: item.normalizedKeyword,
          popularity: item.popularity,
          difficultyScore: item.difficultyScore,
          minDifficultyScore: item.minDifficultyScore,
          isBrandKeyword: item.isBrandKeyword,
          appCount: item.appCount,
          keywordMatch: item.keywordMatch,
          orderedAppIds: item.orderedAppIds,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          positionCapturedAt: positionCapturedAtByKeyword.get(
            item.normalizedKeyword ?? normalizeKeyword(item.keyword)
          ),
          popularityExpiresAt: item.popularityExpiresAt,
        }))
      );
    }

    return { items: refreshed, failedKeywords };
  }

  /**
   * One background-refresh batch for one storefront.
   *
   * The ranking crawl and the popularity refresh are independent: ranking
   * comes from the public search page and needs no Apple session, popularity
   * comes from Search Ads. A keyword whose popularity fetch fails, is missing
   * or is stale still gets its ranking re-crawled with the stored score, and
   * the popularity failure is reported separately. Previously a failed
   * popularity fetch dropped the keyword from the batch entirely, so its rank
   * never refreshed and updatedAt never moved, silently.
   *
   * @param options.skipPopularity Do only the work that needs no Apple account
   * session. Set once a run has established that reauthentication is required.
   * @param options.force Re-crawl every known keyword's ranking, even one whose
   * order is still inside its TTL.
   */
  async refreshStartup(
    country: string,
    items: PendingKeywordPopularityItem[],
    options: { force?: boolean; skipPopularity?: boolean } = {}
  ): Promise<StartupRefreshBatchResult> {
    const result: StartupRefreshBatchResult = {
      items: [],
      failedKeywords: [],
      popularityFailures: [],
      skippedKeywords: [],
      reauthError: null,
    };
    if (items.length === 0) return result;
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const item of items) {
      const normalizedKeyword = normalizeKeyword(item.keyword);
      if (!normalizedKeyword || seen.has(normalizedKeyword)) continue;
      seen.add(normalizedKeyword);
      keywords.push(normalizedKeyword);
    }

    // Keywords that have never been enriched have no stored row, so
    // refreshOrder would skip them - they need the full pipeline to get a
    // popularity score first. This is the path a deferred add lands on.
    const existing = new Map(
      getKeywords(country, keywords).map((row) => [row.normalizedKeyword, row])
    );
    const neverEnriched = keywords.filter(
      (keyword) => !isCompleteStoredAsoKeyword(existing.get(keyword))
    );
    const known = keywords.filter(
      (keyword) => !neverEnriched.includes(keyword)
    );
    let skipPopularity = options.skipPopularity === true;
    const nowMs = Date.now();

    if (known.length > 0) {
      // Popularity is account-level with a 30-day TTL; re-fetching a fresh
      // score would hammer the Search Ads API for an unchanged value.
      const popularityStale = skipPopularity
        ? []
        : known.filter((keyword) => {
            const row = existing.get(keyword);
            return !row || !isStoredKeywordPopularityFresh(row, nowMs);
          });
      const popularityRefreshed: PendingKeywordPopularityItem[] = [];
      if (popularityStale.length > 0) {
        try {
          const popularityResult =
            await fetchKeywordPopularitiesPreferringAdsApi(
              country,
              popularityStale,
              { allowInteractiveAuthRecovery: false }
            );
          const reported = new Set(
            popularityResult.failedKeywords.map((failure) =>
              normalizeKeyword(failure.keyword)
            )
          );
          for (const keyword of popularityStale) {
            const popularity = popularityResult.popularities[keyword];
            if (popularity != null) {
              popularityRefreshed.push({ keyword, popularity });
            } else if (!reported.has(keyword)) {
              result.popularityFailures.push({
                keyword,
                stage: "popularity",
                reasonCode: "POPULARITY_MISSING",
                message:
                  "Apple Search Ads did not return popularity for this keyword.",
                retryable: true,
                attempts: 1,
              });
            }
          }
          result.popularityFailures.push(...popularityResult.failedKeywords);
        } catch (error) {
          if (isAsoAuthReauthRequiredError(error)) {
            result.reauthError = error;
            skipPopularity = true;
          }
          result.popularityFailures.push(
            ...popularityStale.map((keyword) =>
              toPopularityFailureFromError(keyword, error)
            )
          );
        }
        if (popularityRefreshed.length > 0) {
          // The ranking has not been crawled yet, so this must not move
          // updatedAt or record a position point from yesterday's order.
          keywordWriteRepository.upsertPopularityOnly(
            country,
            popularityRefreshed,
            { preserveUpdatedAt: true }
          );
        }
      }

      // A fresh popularity score gets the full enrichment, as before, which
      // also refreshes keyword match and brand detection. If that fails the
      // keyword still gets the cheaper ranking-only crawl below.
      const fullyEnriched = new Set<string>();
      const throttled = new Set<string>();
      if (popularityRefreshed.length > 0) {
        const enriched = await this.enrichAndPersist(
          country,
          popularityRefreshed
        );
        for (const item of enriched.items) {
          fullyEnriched.add(normalizeKeyword(item.keyword));
          result.items.push(item);
        }
        // A throttled storefront would throttle the fallback crawl too; it
        // only adds requests against the wall. Report it as failed instead.
        for (const failure of enriched.failedKeywords) {
          if (!isThrottleFailure(failure)) continue;
          throttled.add(normalizeKeyword(failure.keyword));
          result.failedKeywords.push(failure);
        }
      }

      const orderTargets = known.filter((keyword) => {
        if (fullyEnriched.has(keyword) || throttled.has(keyword)) return false;
        if (options.force) return true;
        const row = existing.get(keyword);
        // Not forced: a keyword whose order is still fresh is a cache hit,
        // unless its popularity was due (the old path re-crawled those too).
        return (
          !row ||
          !isStoredKeywordOrderFresh(row, nowMs) ||
          popularityStale.includes(keyword)
        );
      });
      const cacheHits = known.filter(
        (keyword) =>
          !fullyEnriched.has(keyword) &&
          !throttled.has(keyword) &&
          !orderTargets.includes(keyword)
      );
      for (const keyword of cacheHits) {
        const row = existing.get(keyword);
        if (isCompleteStoredAsoKeyword(row)) {
          result.items.push(toAsoKeywordItem(row));
        }
      }
      if (orderTargets.length > 0) {
        const ordered = await this.refreshOrderWithFailures(
          country,
          orderTargets
        );
        result.items.push(...ordered.items);
        result.failedKeywords.push(...ordered.failedKeywords);
        // A full enrichment that failed above wrote a failure row; the
        // fallback crawl succeeding means the stored data is current again,
        // so it must not be shown as failed. (Also covered by the clear
        // below; done here so the fallback owns its own cleanup.)
        if (ordered.items.length > 0) {
          keywordWriteRepository.clearFailures(
            country,
            ordered.items.map((item) => item.keyword)
          );
        }
      }
    }

    // A never-enriched keyword cannot proceed without a popularity score, so
    // there is nothing to attempt for it while the session is down.
    if (neverEnriched.length > 0) {
      if (skipPopularity) {
        result.skippedKeywords.push(...neverEnriched);
      } else {
        try {
          const fetched = await this.run(country, neverEnriched, {
            allowInteractiveAuthRecovery: false,
            resolveWhenAllFail: true,
          });
          result.items.push(...fetched.items);
          result.failedKeywords.push(...fetched.failedKeywords);
        } catch (error) {
          if (isAsoAuthReauthRequiredError(error)) {
            result.reauthError = result.reauthError ?? error;
            result.skippedKeywords.push(...neverEnriched);
          } else {
            result.failedKeywords.push(
              ...neverEnriched.map((keyword) =>
                toEnrichmentFailureFromError(keyword, error)
              )
            );
          }
        }
      }
    }

    if (result.items.length > 0) {
      keywordWriteRepository.clearFailures(
        country,
        result.items.map((item) => item.keyword)
      );
    }
    if (result.failedKeywords.length > 0 || result.popularityFailures.length > 0) {
      logger.warn(
        `[keyword-pipeline] background refresh country=${country} refreshed=${result.items.length} failed=${result.failedKeywords.length} popularityFailed=${result.popularityFailures.length} skipped=${result.skippedKeywords.length} details=${summarizeFailedKeywords(
          [...result.failedKeywords, ...result.popularityFailures]
        )}`
      );
    }
    return result;
  }

  async forceRefresh(
    country: string,
    keywords: string[],
    options?: ForceRefreshOptions
  ): Promise<KeywordFetchResult> {
    const normalizedKeywords = this.normalizeKeywords(keywords);
    validateKeywordCount(normalizedKeywords);
    if (normalizedKeywords.length === 0) {
      return {
        items: [],
        failedKeywords: [],
        filteredOut: [],
      };
    }

    const popularityResult = await fetchKeywordPopularitiesPreferringAdsApi(
      country,
      normalizedKeywords,
      options?.allowInteractiveAuthRecovery === false
        ? { allowInteractiveAuthRecovery: false }
        : undefined
    );
    const popularityFailureKeywords = new Set(
      popularityResult.failedKeywords.map((failure: FailedKeyword) =>
        normalizeKeyword(failure.keyword)
      )
    );
    const pendingItems = normalizedKeywords
      .filter((keyword) => popularityResult.popularities[keyword] != null)
      .map((keyword) => ({
        keyword,
        popularity: popularityResult.popularities[keyword],
      }));
    const missingPopularityFailures: FailedKeyword[] = normalizedKeywords
      .filter(
        (keyword) =>
          popularityResult.popularities[keyword] == null &&
          !popularityFailureKeywords.has(keyword)
      )
      .map((keyword) => ({
        keyword,
        stage: "popularity",
        reasonCode: "POPULARITY_MISSING",
        message: "Apple Search Ads did not return popularity for this keyword.",
        retryable: true,
        attempts: 1,
      }));
    const popularityFailures = [
      ...popularityResult.failedKeywords,
      ...missingPopularityFailures,
    ];

    keywordWriteRepository.persistFailures(country, popularityFailures);

    const enrichedResult = await this.enrichAndPersist(country, pendingItems);
    const items = enrichedResult.items.map(stripTimestamps);
    const failedKeywords = [
      ...popularityFailures,
      ...enrichedResult.failedKeywords,
    ];
    keywordWriteRepository.persistFailures(country, failedKeywords);
    keywordWriteRepository.clearFailures(
      country,
      items.map((item) => item.keyword)
    );

    return {
      items,
      failedKeywords,
      filteredOut: [],
    };
  }

  async run(
    country: string,
    keywords: string[],
    options?: KeywordFetchOptions
  ): Promise<KeywordFetchResult> {
    const {
      hits,
      pendingItems,
      orderRefreshKeywords,
      failedKeywords: popularityFailures,
      filteredOut: stageFilteredOut,
    } = await this.runPopularityStage(country, keywords, options);
    const [enrichedResult, orderRefreshedItems] = await Promise.all([
      this.enrichAndPersist(country, pendingItems),
      this.refreshOrder(country, orderRefreshKeywords),
    ]);
    const highDifficultyFilteredOut: FilteredKeyword[] = [];
    const items = [...hits, ...orderRefreshedItems, ...enrichedResult.items]
      .map(stripTimestamps)
      .filter((item) => {
        if (!isAboveMaxDifficulty(item.difficultyScore, options?.filters)) {
          return true;
        }
        highDifficultyFilteredOut.push({
          keyword: item.keyword,
          reason: "high_difficulty",
          popularity: item.popularity,
          difficulty: item.difficultyScore,
          minDifficultyScore: item.minDifficultyScore,
          isBrandKeyword: item.isBrandKeyword,
        });
        return false;
      });
    const filteredOut = dedupeFilteredOut([
      ...stageFilteredOut,
      ...highDifficultyFilteredOut,
    ]);
    const failedKeywords = [
      ...popularityFailures,
      ...enrichedResult.failedKeywords,
    ];
    keywordWriteRepository.persistFailures(country, failedKeywords);
    keywordWriteRepository.clearFailures(
      country,
      items.map((item) => item.keyword)
    );
    if (failedKeywords.length > 0) {
      logger.debug(
        `[keyword-pipeline] failed keywords count=${failedKeywords.length} details=${summarizeFailedKeywords(
          failedKeywords
        )}`
      );
    }
    if (
      options?.resolveWhenAllFail !== true &&
      items.length === 0 &&
      failedKeywords.length > 0 &&
      filteredOut.length === 0
    ) {
      throw new Error(
        `All keywords failed (${failedKeywords.length}): ${summarizeFailedKeywords(
          failedKeywords
        )}`
      );
    }
    return {
      items,
      failedKeywords,
      filteredOut,
    };
  }

  async retryFailed(
    appId: string,
    country: string
  ): Promise<{
    retriedCount: number;
    succeededCount: number;
    failedCount: number;
  }> {
    const failures = listKeywordFailuresForApp(appId, country);
    const keywordsToRetry = Array.from(
      new Set(failures.map((failure) => failure.keyword))
    );
    if (keywordsToRetry.length === 0) {
      return {
        retriedCount: 0,
        succeededCount: 0,
        failedCount: 0,
      };
    }

    for (const keywordBatch of chunkKeywords(keywordsToRetry)) {
      const stageResult = await this.runPopularityStage(country, keywordBatch, {
        allowInteractiveAuthRecovery: false,
      });
      const [enrichedResult, orderRefreshedItems] = await Promise.all([
        this.enrichAndPersist(country, stageResult.pendingItems),
        this.refreshOrder(country, stageResult.orderRefreshKeywords),
      ]);
      const succeededKeywords = Array.from(
        new Set([
          ...stageResult.hits.map((item) => item.keyword),
          ...orderRefreshedItems.map((item) => item.keyword),
          ...enrichedResult.items.map((item) => item.keyword),
        ])
      );
      if (succeededKeywords.length > 0) {
        keywordWriteRepository.clearFailures(country, succeededKeywords);
      }
    }

    const retriedKeywords = new Set(keywordsToRetry.map(normalizeKeyword));
    const failedCount = new Set(
      listKeywordFailuresForApp(appId, country)
        .map((failure) => normalizeKeyword(failure.keyword))
        .filter((keyword) => retriedKeywords.has(keyword))
    ).size;

    return {
      retriedCount: keywordsToRetry.length,
      succeededCount: keywordsToRetry.length - failedCount,
      failedCount,
    };
  }
}

export const keywordPipelineService = new KeywordPipelineService();
