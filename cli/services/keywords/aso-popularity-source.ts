import { logger } from "../../utils/logger";
import { asoPopularityService } from "./aso-popularity-service";
import type { FailedKeyword } from "./aso-types";
import { isAppleAdsApiConfigured } from "../apple-ads-api/apple-ads-api-config";
import {
  fetchMonthlyPopularity,
  fetchSearchTermPopularitySnapshots,
} from "../apple-ads-api/search-term-popularity-service";
import { keywordWriteRepository } from "./keyword-write-repository";
import { ASO_ENV } from "../../shared/aso-env";

type PopularityFetchResult = {
  popularities: Record<string, number>;
  failedKeywords: FailedKeyword[];
};

type PopularityFetchOptions = {
  allowInteractiveAuthRecovery?: boolean;
};

async function fetchLegacy(
  country: string,
  keywords: string[],
  options?: PopularityFetchOptions
): Promise<PopularityFetchResult> {
  return asoPopularityService.fetchKeywordPopularitiesWithFailures(keywords, {
    country,
    ...(options?.allowInteractiveAuthRecovery === false
      ? { allowInteractiveAuthRecovery: false }
      : {}),
  });
}

/**
 * Popularity source selection for the keyword pipeline.
 *
 * With Apple Ads Platform API credentials configured, keywords are first
 * looked up in the insights search-term popularity dataset, which is genuinely
 * per-storefront (the legacy endpoint returns one account-level score for
 * every country). Keywords absent from that dataset — anything under ~500
 * weekly searches — fall back to the legacy cookie-authenticated endpoint, so
 * long-tail keywords keep working exactly as before. Weekly history rows for
 * covered keywords are persisted as a side effect to drive popularity trends.
 *
 * Without credentials this is a pass-through to the legacy service —
 * behaviour must stay byte-identical to upstream in that case.
 */
export async function fetchKeywordPopularitiesPreferringAdsApi(
  country: string,
  keywords: string[],
  options?: PopularityFetchOptions
): Promise<PopularityFetchResult> {
  if (!isAppleAdsApiConfigured()) {
    return fetchLegacy(country, keywords, options);
  }
  if (ASO_ENV.popularitySource === "legacy") {
    return fetchLegacyWithAdsApiHistory(country, keywords, options);
  }

  let snapshots;
  try {
    snapshots = await fetchSearchTermPopularitySnapshots(country, keywords);
  } catch (error) {
    logger.debug(
      `[aso-popularity-source] Apple Ads API popularity failed for ${country}, falling back to legacy endpoint: ${String(
        error
      )}`
    );
    return fetchLegacy(country, keywords, options);
  }

  const popularities: Record<string, number> = {};
  const historyPoints: Array<{
    keyword: string;
    week: string;
    popularity: number;
    genre: string | null;
    rankInGenre: number | null;
  }> = [];
  const uncovered: string[] = [];
  for (const keyword of keywords) {
    const snapshot = snapshots.get(keyword);
    if (!snapshot) {
      uncovered.push(keyword);
      continue;
    }
    popularities[keyword] = snapshot.popularity;
    for (const row of snapshot.history) {
      historyPoints.push({
        keyword,
        week: row.week,
        popularity: row.searchPopularity1to100,
        genre: row.genre,
        rankInGenre: row.rankInGenre,
      });
    }
  }
  keywordWriteRepository.persistPopularityHistory(country, historyPoints);

  if (uncovered.length === 0) {
    return { popularities, failedKeywords: [] };
  }
  logger.debug(
    `[aso-popularity-source] ${uncovered.length}/${keywords.length} keywords not in Ads API dataset for ${country}; using legacy endpoint for the remainder`
  );
  let legacy: PopularityFetchResult;
  try {
    legacy = await fetchLegacy(country, uncovered, options);
  } catch (error) {
    // With no Ads API coverage at all, the legacy error must propagate
    // unchanged — it carries the auth-recovery signals (e.g. reauth required)
    // the surfaces react to. With partial coverage, failing the whole batch
    // would throw away scores already in hand, so the covered keywords
    // proceed and only the uncovered ones are reported failed.
    if (Object.keys(popularities).length === 0) throw error;
    logger.debug(
      `[aso-popularity-source] legacy fallback failed for ${uncovered.length} uncovered keywords: ${String(
        error
      )}`
    );
    return {
      popularities,
      failedKeywords: uncovered.map((keyword) => ({
        keyword,
        stage: "popularity" as const,
        reasonCode: "LEGACY_POPULARITY_UNAVAILABLE",
        message: `Keyword is below the Apple Ads insights threshold and the legacy popularity endpoint failed: ${String(
          error
        )}`,
        retryable: true,
        attempts: 1,
      })),
    };
  }
  return {
    popularities: { ...legacy.popularities, ...popularities },
    failedKeywords: legacy.failedKeywords,
  };
}

/**
 * Legacy endpoint as the score of record. Measured against Astro on
 * 2026-09-25: legacy scores matched Astro on 680 of 687 keywords where both
 * had a value, while the Ads Platform API's per-storefront scores differed on
 * 149 of 157. The Ads API is still queried, best effort, for its weekly
 * history (the dashboard trend arrow) and to fill keywords the legacy call
 * failed.
 */
async function fetchLegacyWithAdsApiHistory(
  country: string,
  keywords: string[],
  options?: PopularityFetchOptions
): Promise<PopularityFetchResult> {
  // Errors propagate unchanged: they carry the reauth signals surfaces act on.
  const legacy = await fetchLegacy(country, keywords, options);

  let snapshots: Awaited<ReturnType<typeof fetchSearchTermPopularitySnapshots>>;
  try {
    snapshots = await fetchSearchTermPopularitySnapshots(country, keywords);
  } catch (error) {
    logger.debug(
      `[aso-popularity-source] Ads API history skipped for ${country}: ${String(error)}`
    );
    return legacy;
  }

  const historyPoints: Array<{
    keyword: string;
    week: string;
    popularity: number;
    genre: string | null;
    rankInGenre: number | null;
  }> = [];
  for (const [keyword, snapshot] of snapshots) {
    for (const row of snapshot.history) {
      historyPoints.push({
        keyword,
        week: row.week,
        popularity: row.searchPopularity1to100,
        genre: row.genre,
        rankInGenre: row.rankInGenre,
      });
    }
  }
  keywordWriteRepository.persistPopularityHistory(country, historyPoints);

  const popularities = { ...legacy.popularities };
  const failedKeywords = legacy.failedKeywords.filter((failed) => {
    const snapshot = snapshots.get(failed.keyword);
    if (!snapshot) return true;
    popularities[failed.keyword] = snapshot.popularity;
    return false;
  });

  // The legacy endpoint answers 5 (its floor) for many terms that do have
  // demand. Where Apple's monthly insights have a figure, use it instead
  // (decided 2026-09-27; docs/aso-difficulty-model.md).
  const atFloor = Object.entries(popularities)
    .filter(([, value]) => value <= LEGACY_POPULARITY_FLOOR)
    .map(([keyword]) => keyword);
  if (atFloor.length > 0) {
    try {
      const monthly = await fetchMonthlyPopularity(country, atFloor);
      for (const [keyword, { popularity }] of monthly) {
        if (popularity > LEGACY_POPULARITY_FLOOR) popularities[keyword] = popularity;
      }
    } catch (error) {
      logger.debug(
        `[aso-popularity-source] monthly popularity skipped for ${country}: ${String(error)}`
      );
    }
  }
  return { popularities, failedKeywords };
}

const LEGACY_POPULARITY_FLOOR = 5;
