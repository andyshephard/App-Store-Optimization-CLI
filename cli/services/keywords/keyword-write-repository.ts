import { upsertCompetitorAppDocs } from "../../db/aso-apps";
import {
  deleteKeywordFailures,
  upsertKeywordFailures,
} from "../../db/aso-keyword-failures";
import { getKeywords, upsertKeywords } from "../../db/aso-keywords";
import {
  getAssociationsForKeyword,
  setPreviousPosition,
} from "../../db/app-keywords";
import {
  insertAppKeywordPositionHistoryPoints,
  pruneAppKeywordPositionHistoryBefore,
} from "../../db/app-keyword-position-history";
import { getMetadataValue, setMetadataValue } from "../../db/metadata";
import {
  computeOrderExpiryIso,
  computePopularityExpiryIso,
  normalizeKeyword,
} from "../../shared/aso-keyword-utils";
import type { KeywordMatchType } from "../../shared/aso-keyword-match";
import type { FailedKeyword } from "../../shared/aso-keyword-types";

const POSITION_HISTORY_RETENTION_DAYS = 90;
const POSITION_HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const POSITION_HISTORY_LAST_PRUNED_METADATA_KEY =
  "app-keyword-position-history-pruned-at";

type KeywordWriteItem = {
  keyword: string;
  normalizedKeyword?: string;
  popularity: number;
  difficultyScore: number | null;
  minDifficultyScore: number | null;
  isBrandKeyword?: boolean | null;
  appCount: number | null;
  keywordMatch: KeywordMatchType | null;
  orderedAppIds: string[];
  createdAt?: string;
  updatedAt?: string;
  positionCapturedAt?: string;
  orderExpiresAt?: string;
  popularityExpiresAt?: string;
};

type CompetitorAppDoc = {
  appId: string;
  name: string;
  subtitle?: string;
  publisherName?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  additionalLocalizations?: Record<string, { name: string; subtitle?: string }>;
  expiresAt?: string;
};

function maybePrunePositionHistory(now: Date): void {
  const nowMs = now.getTime();
  const lastPrunedAt = getMetadataValue(POSITION_HISTORY_LAST_PRUNED_METADATA_KEY);
  if (lastPrunedAt) {
    const lastPrunedMs = Date.parse(lastPrunedAt);
    if (
      Number.isFinite(lastPrunedMs) &&
      nowMs - lastPrunedMs < POSITION_HISTORY_PRUNE_INTERVAL_MS
    ) {
      return;
    }
  }

  const cutoff = new Date(
    nowMs - POSITION_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  pruneAppKeywordPositionHistoryBefore(cutoff);
  setMetadataValue(POSITION_HISTORY_LAST_PRUNED_METADATA_KEY, now.toISOString());
}

export class KeywordWriteRepository {
  upsertKeywordItems(country: string, items: KeywordWriteItem[]): void {
    if (items.length === 0) return;

    const now = new Date();
    const nowIso = now.toISOString();
    const normalizedItems = items.map((item) => ({
      ...item,
      normalizedKeyword: item.normalizedKeyword ?? normalizeKeyword(item.keyword),
      updatedAt: item.updatedAt ?? nowIso,
      positionCapturedAt: item.positionCapturedAt ?? item.updatedAt ?? nowIso,
    }));
    const positionHistoryPoints: Array<{
      appId: string;
      keyword: string;
      country: string;
      position: number;
      capturedAt: string;
    }> = [];
    const existingByNormalized = new Map(
      getKeywords(
        country,
        normalizedItems.map((item) => item.normalizedKeyword)
      ).map((keyword) => [keyword.normalizedKeyword, keyword] as const)
    );

    for (const item of normalizedItems) {
      const existing = existingByNormalized.get(item.normalizedKeyword);
      const orderedIds = existing?.orderedAppIds ?? [];
      const associations = getAssociationsForKeyword(item.keyword, country);
      for (const assoc of associations) {
        if (orderedIds.length > 0) {
          const idx = orderedIds.indexOf(assoc.appId);
          const previousPosition = idx >= 0 ? idx + 1 : 0;
          if (previousPosition > 0) {
            setPreviousPosition(item.keyword, country, assoc.appId, previousPosition);
          }
        }

        const currentIdx = item.orderedAppIds.indexOf(assoc.appId);
        if (currentIdx >= 0) {
          positionHistoryPoints.push({
            appId: assoc.appId,
            keyword: item.keyword,
            country,
            position: currentIdx + 1,
            capturedAt: item.positionCapturedAt,
          });
        }
      }
    }

    upsertKeywords(
      country,
      normalizedItems.map((item) => ({
        keyword: item.keyword,
        normalizedKeyword: item.normalizedKeyword,
        popularity: item.popularity,
        difficultyScore: item.difficultyScore,
        minDifficultyScore: item.minDifficultyScore,
        isBrandKeyword: item.isBrandKeyword ?? null,
        appCount: item.appCount,
        keywordMatch: item.keywordMatch,
        orderedAppIds: item.orderedAppIds,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        orderExpiresAt: item.orderExpiresAt ?? computeOrderExpiryIso(),
        popularityExpiresAt:
          item.popularityExpiresAt ??
          existingByNormalized.get(item.normalizedKeyword)?.popularityExpiresAt ??
          computePopularityExpiryIso(),
      }))
    );

    if (positionHistoryPoints.length > 0) {
      insertAppKeywordPositionHistoryPoints(positionHistoryPoints);
      maybePrunePositionHistory(now);
    }
  }

  upsertPopularityOnly(
    country: string,
    items: Array<{ keyword: string; popularity: number }>
  ): void {
    if (items.length === 0) return;
    this.upsertKeywordItems(
      country,
      items.map((item) => ({
        keyword: item.keyword,
        normalizedKeyword: normalizeKeyword(item.keyword),
        popularity: item.popularity,
        difficultyScore: null,
        minDifficultyScore: null,
        isBrandKeyword: null,
        appCount: null,
        keywordMatch: null,
        orderedAppIds: [],
        orderExpiresAt: computeOrderExpiryIso(),
        popularityExpiresAt: computePopularityExpiryIso(),
      }))
    );
  }

  persistFailures(country: string, failures: FailedKeyword[]): void {
    if (failures.length === 0) return;
    upsertKeywordFailures(
      country,
      failures.map((failure) => ({
        keyword: failure.keyword,
        stage: failure.stage,
        reasonCode: failure.reasonCode,
        message: failure.message,
        statusCode: failure.statusCode,
        retryable: failure.retryable,
        attempts: failure.attempts,
        requestId: failure.requestId,
      }))
    );
  }

  clearFailures(country: string, keywords: string[]): void {
    if (keywords.length === 0) return;
    deleteKeywordFailures(country, keywords);
  }

  upsertCompetitorDocs(country: string, docs: CompetitorAppDoc[]): void {
    if (docs.length === 0) return;

    upsertCompetitorAppDocs(
      country,
      docs.map((doc) => ({
        appId: doc.appId,
        name: doc.name,
        subtitle: doc.subtitle,
        publisherName: doc.publisherName,
        averageUserRating: doc.averageUserRating,
        userRatingCount: doc.userRatingCount,
        releaseDate: doc.releaseDate,
        currentVersionReleaseDate: doc.currentVersionReleaseDate,
        icon: doc.icon as Record<string, unknown> | undefined,
        iconArtwork: doc.iconArtwork,
        additionalLocalizations: doc.additionalLocalizations,
        expiresAt: doc.expiresAt,
      }))
    );
  }
}

export const keywordWriteRepository = new KeywordWriteRepository();
