import { normalizeKeyword } from "../domain/keywords/policy";

/**
 * Store views of the dashboard: the App Store view (the original dashboard),
 * the Google Play view, and both side by side. Pure helpers only; the views
 * live in components/play-keywords-view.tsx and components/both-stores-view.tsx.
 */

export type StoreMode = "ios" | "android" | "both";

export const STORE_MODES: ReadonlyArray<{ mode: StoreMode; label: string }> = [
  { mode: "ios", label: "App Store" },
  { mode: "android", label: "Google Play" },
  { mode: "both", label: "Both" },
];

const STORE_MODE_STORAGE_KEY = "aso-dashboard:store-mode";
const PLAY_COUNTRY_STORAGE_KEY = "aso-dashboard:play-country";

function isStoreMode(value: unknown): value is StoreMode {
  return value === "ios" || value === "android" || value === "both";
}

export function readStoredStoreMode(): StoreMode {
  try {
    const stored = localStorage.getItem(STORE_MODE_STORAGE_KEY);
    return isStoreMode(stored) ? stored : "ios";
  } catch {
    return "ios";
  }
}

export function writeStoredStoreMode(mode: StoreMode): void {
  try {
    localStorage.setItem(STORE_MODE_STORAGE_KEY, mode);
  } catch {
    // no-op: the choice just is not remembered
  }
}

export function readStoredPlayCountry(): string | null {
  try {
    return localStorage.getItem(PLAY_COUNTRY_STORAGE_KEY)?.trim().toUpperCase() || null;
  } catch {
    return null;
  }
}

export function writeStoredPlayCountry(country: string): void {
  try {
    localStorage.setItem(PLAY_COUNTRY_STORAGE_KEY, country);
  } catch {
    // no-op
  }
}

/** A `GET /api/aso/keywords?platform=android` item (docs/google-play.md). */
export type PlayKeywordItem = {
  keyword: string;
  normalizedKeyword: string;
  country: string;
  appId: string;
  autocompleteLetters: number | null;
  autocompleteRank: number | null;
  autocompleteCheckedAt: string | null;
  difficultyScore: number | null;
  resultCount: number | null;
  rankDepth: number | null;
  layout: string | null;
  rank: number | null;
  previousRank: number | null;
  rankChange: number | null;
  addedAt: string | null;
  updatedAt: string | null;
  keywordStatus: "ok" | "pending" | "failed";
  failure: {
    reasonCode: string;
    message?: string | null;
    attempts?: number | null;
    updatedAt?: string | null;
  } | null;
};

/** The App Store fields the Both view needs, from `GET /api/aso/keywords`. */
export type IosKeywordItem = {
  keyword: string;
  popularity: number | null;
  previousPopularity?: number | null;
  keywordStatus?: "ok" | "pending" | "failed";
  positions?: Array<{
    appId: string;
    previousPosition: number | null;
    currentPosition: number | null;
  }>;
};

export type StoreSide = {
  /** The keyword as that store tracks it. */
  keyword: string;
  /**
   * App Store: Apple's popularity score (higher = more searched).
   * Google Play: autocomplete letters (fewer = more searched).
   */
  popularity: number | null;
  /** Change in `popularity` since the previous measurement, if known. */
  popularityChange: number | null;
  /** Autocomplete position (Play only). */
  suggestionRank: number | null;
  /** Play only: autocomplete has not been measured yet (null popularity means "not yet", not "never suggested"). */
  popularityPending: boolean;
  rank: number | null;
  /** current - previous: negative is an improvement, as in the iOS table. */
  rankChange: number | null;
  status: "ok" | "pending" | "failed";
};

export type MergedKeywordRow = {
  /** Normalized keyword: the key the two stores are joined on. */
  key: string;
  keyword: string;
  ios: StoreSide | null;
  play: StoreSide | null;
};

/** Joins on lowercased, trimmed text with runs of whitespace collapsed. */
export function storeKeywordKey(keyword: string): string {
  return normalizeKeyword(keyword).replace(/\s+/g, " ");
}

export function toIosSide(item: IosKeywordItem, appId: string): StoreSide {
  const position = (item.positions ?? []).find((entry) => entry.appId === appId);
  // The API reports "no popularity data" as 0 or null; the iOS table shows "-".
  const popularity = item.popularity != null && item.popularity > 0 ? item.popularity : null;
  const current = position?.currentPosition ?? null;
  const previous = position?.previousPosition ?? null;
  return {
    keyword: item.keyword,
    popularity,
    popularityChange:
      popularity != null && item.previousPopularity != null
        ? popularity - item.previousPopularity
        : null,
    suggestionRank: null,
    popularityPending: false,
    rank: current,
    rankChange: current != null && previous != null ? current - previous : null,
    status: item.keywordStatus ?? "ok",
  };
}

export function toPlaySide(item: PlayKeywordItem): StoreSide {
  return {
    keyword: item.keyword,
    popularity: item.autocompleteLetters,
    popularityChange: null,
    suggestionRank: item.autocompleteRank,
    popularityPending: item.autocompleteCheckedAt == null,
    rank: item.rank,
    rankChange: item.rankChange,
    status: item.keywordStatus,
  };
}

/**
 * One row per keyword across both stores. A keyword tracked on only one store
 * has `null` for the other side. The first spelling seen wins for display.
 */
export function mergeStoreKeywords(
  ios: StoreSide[],
  play: StoreSide[]
): MergedKeywordRow[] {
  const rows = new Map<string, MergedKeywordRow>();
  const upsert = (side: StoreSide, store: "ios" | "play") => {
    const key = storeKeywordKey(side.keyword);
    if (!key) return;
    const row = rows.get(key) ?? { key, keyword: side.keyword, ios: null, play: null };
    if (row[store] == null) row[store] = side;
    rows.set(key, row);
  };
  for (const side of ios) upsert(side, "ios");
  for (const side of play) upsert(side, "play");
  return Array.from(rows.values());
}

export type MergedSortKey =
  | "keyword"
  | "iosPopularity"
  | "iosRank"
  | "playPopularity"
  | "playRank";
export type MergedSortDir = "asc" | "desc";

/** First click on a column sorts best-first. */
export const MERGED_DEFAULT_SORT_DIR: Record<MergedSortKey, MergedSortDir> = {
  keyword: "asc",
  iosPopularity: "desc",
  iosRank: "asc",
  // Fewer letters = more popular, so best-first is ascending.
  playPopularity: "asc",
  playRank: "asc",
};

function sortValue(row: MergedKeywordRow, key: MergedSortKey): number | null {
  switch (key) {
    case "iosPopularity":
      return row.ios?.popularity ?? null;
    case "iosRank":
      return row.ios?.rank ?? null;
    case "playPopularity":
      return row.play?.popularity ?? null;
    case "playRank":
      return row.play?.rank ?? null;
    default:
      return null;
  }
}

/** Sorts a copy. Missing values (not tracked, not ranked) always go last. */
export function sortMergedRows(
  rows: MergedKeywordRow[],
  key: MergedSortKey,
  dir: MergedSortDir
): MergedKeywordRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byKeyword = (a: MergedKeywordRow, b: MergedKeywordRow) =>
    a.key.localeCompare(b.key);
  return [...rows].sort((a, b) => {
    if (key === "keyword") return sign * byKeyword(a, b);
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va == null && vb == null) return byKeyword(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return sign * (va - vb) || byKeyword(a, b);
  });
}

/** Countries a Both view can show: enabled on both stores, App Store order. */
export function sharedCountries(
  iosCountries: string[],
  playCountries: string[]
): string[] {
  const play = new Set(playCountries);
  return iosCountries.filter((country) => play.has(country));
}
