import { logger } from "../../utils/logger";
import { normalizeKeyword } from "../../shared/aso-keyword-utils";
import { appleAdsApiPost } from "./apple-ads-api-client";

const INSIGHTS_PATH = "/v1/insights/apps/search-term-popularity/query";
/**
 * Unverified upstream limit on filter list size; 200 keeps requests well
 * under the 5000-row page cap even with 65 weekly rows per term.
 */
const SEARCH_TERM_BATCH_SIZE = 200;
const PAGE_SIZE = 5000;
/** Weekly reports publish Mondays 07:00 UTC with a 65-week retention. */
export const POPULARITY_HISTORY_WEEKS = 65;

export interface SearchTermPopularityRow {
  week: string;
  countryOrRegion: string;
  genre: string;
  searchTerm: string;
  rankInGenre: number;
  searchPopularityInGenre: number;
  searchPopularity1to100: number;
  searchPopularity1to5: number;
}

interface InsightsResponse {
  result: { rows: SearchTermPopularityRow[] } | null;
  pagination: { offset: number; pageSize: number; totalCount?: number } | null;
}

export interface KeywordPopularitySnapshot {
  /** Country-wide 1-100 score from the latest available week. */
  popularity: number;
  week: string;
  genre: string;
  rankInGenre: number;
  /** All weekly rows fetched for this keyword, newest week last. */
  history: SearchTermPopularityRow[];
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The date window to query. Weekly rows cover fixed Sunday-Saturday weeks and
 * the latest one appears the following Monday, so the window always reaches
 * back far enough to contain at least one complete published week.
 */
function buildTimeRange(weeksBack: number, nowMs: number) {
  const end = new Date(nowMs);
  const start = new Date(nowMs - weeksBack * 7 * 24 * 60 * 60 * 1000);
  return {
    start: isoDate(start),
    end: isoDate(end),
    granularity: "WEEKLY_SUN_SAT",
  };
}

async function fetchRowsForBatch(
  country: string,
  terms: string[],
  weeksBack: number,
  nowMs: number
): Promise<SearchTermPopularityRow[]> {
  const rows: SearchTermPopularityRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await appleAdsApiPost<InsightsResponse>(INSIGHTS_PATH, {
      filters: [
        { field: "countryOrRegion", operator: "EQUALS", value: country },
        { field: "searchTerm", operator: "IN", value: terms },
      ],
      timeRange: buildTimeRange(weeksBack, nowMs),
      pagination: { offset, pageSize: PAGE_SIZE },
    });
    const pageRows = response.result?.rows ?? [];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) return rows;
  }
}

/**
 * The latest complete week of a genre's top search terms in a storefront —
 * the actual demand map for that market. Rows come back for every week in the
 * window, so keep only each term's newest row.
 */
export async function fetchGenreTopSearchTerms(
  country: string,
  genre: string,
  options: { limit?: number; nowMs?: number } = {}
): Promise<SearchTermPopularityRow[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 100;
  const response = await appleAdsApiPost<{
    result: { rows: SearchTermPopularityRow[] } | null;
  }>(INSIGHTS_PATH, {
    filters: [
      {
        field: "countryOrRegion",
        operator: "EQUALS",
        value: country.toUpperCase(),
      },
      { field: "genre", operator: "EQUALS", value: genre },
    ],
    // Weeks only count when fully inside the range and the newest week can
    // lag until Monday 07:00 UTC, so a three-week window is the shortest one
    // guaranteed to contain a complete published Sunday-Saturday week.
    timeRange: buildTimeRange(3, nowMs),
    sorting: [{ field: "rankInGenre", sortOrder: "ASC" }],
    pagination: { offset: 0, pageSize: PAGE_SIZE },
  });
  const latestByTerm = new Map<string, SearchTermPopularityRow>();
  for (const row of response.result?.rows ?? []) {
    const existing = latestByTerm.get(row.searchTerm);
    if (!existing || row.week > existing.week) {
      latestByTerm.set(row.searchTerm, row);
    }
  }
  return [...latestByTerm.values()]
    .sort((a, b) => a.rankInGenre - b.rankInGenre)
    .slice(0, limit);
}

/**
 * Fetch per-country popularity snapshots for the given keywords from the
 * Apple Ads Platform API insights endpoint.
 *
 * Only terms appearing in some genre's weekly top-500 chart (>= 500 searches)
 * exist in this dataset; absent keywords are simply missing from the returned
 * map and the caller is expected to fall back to the legacy popularity source.
 */
export async function fetchSearchTermPopularitySnapshots(
  country: string,
  keywords: string[],
  options: { historyWeeks?: number; nowMs?: number } = {}
): Promise<Map<string, KeywordPopularitySnapshot>> {
  const nowMs = options.nowMs ?? Date.now();
  const historyWeeks = options.historyWeeks ?? POPULARITY_HISTORY_WEEKS;
  const storefront = country.toUpperCase();

  const normalizedToOriginal = new Map<string, string>();
  for (const keyword of keywords) {
    normalizedToOriginal.set(normalizeKeyword(keyword), keyword);
  }
  const terms = [...normalizedToOriginal.keys()];

  const allRows: SearchTermPopularityRow[] = [];
  for (let i = 0; i < terms.length; i += SEARCH_TERM_BATCH_SIZE) {
    const batch = terms.slice(i, i + SEARCH_TERM_BATCH_SIZE);
    allRows.push(
      ...(await fetchRowsForBatch(storefront, batch, historyWeeks, nowMs))
    );
  }

  const byKeyword = new Map<string, SearchTermPopularityRow[]>();
  for (const row of allRows) {
    const original = normalizedToOriginal.get(normalizeKeyword(row.searchTerm));
    if (!original) continue;
    const list = byKeyword.get(original);
    if (list) list.push(row);
    else byKeyword.set(original, [row]);
  }

  const snapshots = new Map<string, KeywordPopularitySnapshot>();
  for (const [keyword, rows] of byKeyword) {
    // A term can chart in more than one genre in the same week; keep the row
    // with the best (lowest) genre rank per week so history has one point per
    // week and the headline score comes from the term's strongest genre.
    const bestByWeek = new Map<string, SearchTermPopularityRow>();
    for (const row of rows) {
      const existing = bestByWeek.get(row.week);
      if (!existing || row.rankInGenre < existing.rankInGenre) {
        bestByWeek.set(row.week, row);
      }
    }
    const history = [...bestByWeek.values()].sort((a, b) =>
      a.week < b.week ? -1 : 1
    );
    const latest = history[history.length - 1];
    if (!latest) continue;
    snapshots.set(keyword, {
      popularity: latest.searchPopularity1to100,
      week: latest.week,
      genre: latest.genre,
      rankInGenre: latest.rankInGenre,
      history,
    });
  }
  logger.debug(
    `[apple-ads-api] popularity snapshots for ${storefront}: ${snapshots.size}/${keywords.length} keywords covered`
  );
  return snapshots;
}
