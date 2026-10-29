import { z } from "zod";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import { normalizeAppleUpstreamError } from "../../shared/apple-upstream-error";
import type { FailedKeyword } from "../../shared/aso-keyword-types";
import { localAsoCacheRepository } from "./services/aso-cache-local";
import {
  enrichKeyword,
  enrichKeywordsFromRatingsBatch,
} from "./services/aso-enrichment-service";
import { ASO_ENV } from "../../shared/aso-env";
import { normalizeKeyword, sanitizeKeywords } from "./services/aso-keyword-utils";
import { getAsoAppDocs as getAsoAppDocsFromService } from "./services/aso-app-doc-service";
import { ASO_MAX_KEYWORDS } from "../../shared/aso-keyword-limits";
import type {
  AsoAppDoc,
  AsoCacheRepository,
  AsoKeywordRecord,
} from "./services/aso-types";
import {
  DEFAULT_ASO_COUNTRY,
  assertSupportedCountry,
  normalizeCountry,
} from "../../domain/keywords/policy";

const CacheLookupRequestSchema = z.object({
  country: z.string().default(DEFAULT_ASO_COUNTRY),
  keywords: z.array(z.string()).min(1).max(ASO_MAX_KEYWORDS),
});

const EnrichItemSchema = z.object({
  keyword: z.string().min(1),
  popularity: z.number().min(0).max(100),
});
const EnrichRequestSchema = z.object({
  country: z.string().default(DEFAULT_ASO_COUNTRY),
  items: z.array(EnrichItemSchema).min(1).max(ASO_MAX_KEYWORDS),
});

function toEnrichmentFailure(keyword: string, error: unknown): FailedKeyword {
  const normalized = normalizeAppleUpstreamError({
    error,
    operation: "keyword-enrichment",
    defaultReasonCode: "ENRICHMENT_FAILED",
  });
  return {
    keyword: normalizeKeyword(keyword),
    stage: "enrichment",
    reasonCode: normalized.reasonCode,
    message: normalized.message,
    statusCode: normalized.statusCode,
    retryable: normalized.retryable,
    attempts: normalized.attempts,
    requestId: normalized.requestId,
  };
}
const AppDocsRequestSchema = z.object({
  country: z.string().default(DEFAULT_ASO_COUNTRY),
  appIds: z.array(z.string()).min(1).max(50),
  forceLookup: z.boolean().optional().default(false),
});

interface AsoDependencies {
  repository: AsoCacheRepository;
}

function getDefaultDependencies(): AsoDependencies {
  return { repository: localAsoCacheRepository };
}

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let index = 0;

  const runWorker = async (): Promise<void> => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      try {
        const value = await mapper(items[currentIndex]);
        results[currentIndex] = {
          status: "fulfilled",
          value,
        };
      } catch (reason) {
        results[currentIndex] = {
          status: "rejected",
          reason,
        };
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function lookupAsoCache(
  params: { country: string; keywords: string[] },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<{ hits: AsoKeywordRecord[]; misses: string[] }> {
  const validated = CacheLookupRequestSchema.parse(params);
  const country = normalizeCountry(validated.country);
  assertSupportedCountry(country);

  return dependencies.repository.getByKeywords({
    country,
    keywords: sanitizeKeywords(validated.keywords),
  });
}

export async function enrichAsoKeywords(
  params: {
    country: string;
    items: Array<{ keyword: string; popularity: number }>;
    /** Stored order per keyword, so an empty crawl cannot overwrite a real one. */
    getStoredOrderedAppIds?: (normalizedKeyword: string) => string[] | null;
  },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<{
  items: Array<AsoKeywordRecord & { appDocs?: AsoAppDoc[] }>;
  failedKeywords: FailedKeyword[];
}> {
  // A batch carries many keywords, so one malformed item (a missing or
  // out-of-range popularity) fails only itself, as it did when keywords were
  // enriched one per call. The request as a whole is still validated.
  const invalidFailures: FailedKeyword[] = [];
  const validItems = Array.isArray(params.items)
    ? params.items.filter((item) => {
        if (EnrichItemSchema.safeParse(item).success) return true;
        invalidFailures.push({
          keyword: normalizeKeyword(String(item?.keyword ?? "")),
          stage: "enrichment",
          reasonCode: "INVALID_REQUEST",
          message: `Invalid enrichment item: popularity must be a number from 0 to 100 (got ${String(item?.popularity)}).`,
          retryable: false,
          attempts: 1,
        });
        return false;
      })
    : params.items;
  if (invalidFailures.length > 0 && validItems.length === 0) {
    assertSupportedCountry(normalizeCountry(params.country || DEFAULT_ASO_COUNTRY));
    return { items: [], failedKeywords: invalidFailures };
  }
  const validated = EnrichRequestSchema.parse({ ...params, items: validItems });
  const country = normalizeCountry(validated.country);
  assertSupportedCountry(country);

  const getAppDocs = dependencies.repository.getAppDocs
    ? (appIds: string[]) =>
        dependencies.repository.getAppDocs!({ country, appIds })
    : undefined;
  const enrichOptions =
    getAppDocs || params.getStoredOrderedAppIds
      ? {
          ...(getAppDocs ? { getAppDocs } : {}),
          ...(params.getStoredOrderedAppIds
            ? { getStoredOrderedAppIds: params.getStoredOrderedAppIds }
            : {}),
        }
      : undefined;
  const concurrency = getAsoResilienceConfig().keywordEnrichmentConcurrency;
  // Ratings mode merges the items' top-10 iTunes lookups into 50-id
  // requests; results and failures per keyword are the same as enriching
  // each keyword on its own.
  const settled =
    ASO_ENV.enrichmentMode === "legacy"
      ? await mapSettledWithConcurrency(validated.items, concurrency, (item) =>
          enrichKeyword(
            { keyword: item.keyword, popularity: item.popularity, country },
            enrichOptions
          )
        )
      : await enrichKeywordsFromRatingsBatch(
          validated.items.map((item) => ({
            keyword: item.keyword,
            popularity: item.popularity,
            country,
          })),
          enrichOptions,
          concurrency
        );

  const enriched = settled.flatMap((entry) =>
    entry.status === "fulfilled" ? [entry.value] : []
  );
  const failedKeywords: FailedKeyword[] = [
    ...invalidFailures,
    ...settled.flatMap((entry, index) =>
      entry.status === "rejected"
        ? [toEnrichmentFailure(validated.items[index]?.keyword ?? "", entry.reason)]
        : []
    ),
  ];

  const allAppDocs = enriched.flatMap((e) => e.appDocs);
  const normalizedAppDocs = allAppDocs.map((doc) => ({
    ...doc,
    country,
  }));
  const appDocsByKeyword = new Map(
    enriched.map((item) => [
      normalizeKeyword(item.keyword),
      (item.appDocs ?? []).map((doc) => ({ ...doc, country })),
    ])
  );
  type UpsertItem = Parameters<AsoCacheRepository["upsertMany"]>[0]["items"][number];
  const toUpsertItem = (e: (typeof enriched)[number]): UpsertItem => ({
    keyword: e.keyword,
    popularity: e.popularity,
    difficultyScore: e.difficultyScore,
    minDifficultyScore: e.minDifficultyScore,
    isBrandKeyword: e.isBrandKeyword ?? null,
    appCount: e.appCount,
    keywordMatch: e.keywordMatch,
    orderedAppIds: e.orderedAppIds,
    ...(e.orderSource ? { orderSource: e.orderSource } : {}),
    // A batch scores keywords after every order is in, so stamp each with
    // when its own order was fetched, as the rank-only refresh does.
    ...(e.observedAt
      ? { updatedAt: e.observedAt, positionCapturedAt: e.observedAt }
      : {}),
  });
  let persisted: AsoKeywordRecord[] = [];
  if (enriched.length > 0) {
    try {
      persisted = await dependencies.repository.upsertMany({
        country,
        items: enriched.map(toUpsertItem),
        appDocs: normalizedAppDocs,
      });
    } catch {
      // One bad row must not lose the whole batch: write keyword by keyword
      // and fail only the ones that still throw.
      for (const e of enriched) {
        try {
          persisted.push(
            ...(await dependencies.repository.upsertMany({
              country,
              items: [toUpsertItem(e)],
              appDocs: appDocsByKeyword.get(normalizeKeyword(e.keyword)) ?? [],
            }))
          );
        } catch (itemError) {
          failedKeywords.push(toEnrichmentFailure(e.keyword, itemError));
        }
      }
    }
  }
  return {
    items: persisted.map((item) => ({
      ...item,
      appDocs: appDocsByKeyword.get(item.normalizedKeyword) ?? [],
    })),
    failedKeywords,
  };
}

export async function getAsoAppDocs(
  params: { country: string; appIds: string[]; forceLookup?: boolean },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<AsoAppDoc[]> {
  const validated = AppDocsRequestSchema.parse(params);
  const country = normalizeCountry(validated.country);
  assertSupportedCountry(country);
  return getAsoAppDocsFromService({
    country,
    appIds: validated.appIds,
    forceLookup: validated.forceLookup,
    repository: dependencies.repository,
  });
}
