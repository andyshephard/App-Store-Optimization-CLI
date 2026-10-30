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
const PLAY_APP_STORAGE_KEY = "aso-dashboard:play-app-id";
const PLAY_COMPETITORS_COLUMN_STORAGE_KEY = "aso-dashboard:play-competitors-column";

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

export function readStoredPlayAppId(): string | null {
  try {
    return localStorage.getItem(PLAY_APP_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function writeStoredPlayAppId(appId: string): void {
  try {
    localStorage.setItem(PLAY_APP_STORAGE_KEY, appId);
  } catch {
    // no-op
  }
}

/** The Competitors column is on unless it was switched off. */
export function readStoredShowPlayCompetitors(): boolean {
  try {
    return localStorage.getItem(PLAY_COMPETITORS_COLUMN_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeStoredShowPlayCompetitors(show: boolean): void {
  try {
    localStorage.setItem(PLAY_COMPETITORS_COLUMN_STORAGE_KEY, show ? "1" : "0");
  } catch {
    // no-op
  }
}

/** A `GET /api/apps?platform=android` item: our app or a competitor. */
export type PlayApp = {
  id: string;
  /** Title from stored search results; null until it shows up in a top 30. */
  name: string | null;
  developer: string | null;
  iconUrl: string | null;
  kind: "owned" | "competitor";
  source: "ASO_PLAY_APP_ID" | "ASO_PLAY_ROSTER_APP_IDS" | "dashboard";
  removable: boolean;
  addedAt: string | null;
};

/**
 * A short label for tight cells: the title up to its first ":" or " - "
 * ("Paladin: Learn Anything" -> "Paladin"), else the package's last part.
 */
export function shortPlayAppName(app: Pick<PlayApp, "id" | "name">): string {
  const short = (app.name ?? "").split(/\s*[:|]\s*|\s+[-–—]\s+/)[0]?.trim();
  if (short) return short.length > 24 ? `${short.slice(0, 23)}…` : short;
  const parts = app.id.split(".");
  return parts[parts.length - 1] || app.id;
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
  /** Rank of each competitor package in the same top 30 (null = not in it). */
  competitorRanks?: Record<string, number | null>;
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
  /** Play only: other tracked apps ranking for the keyword (Competitors column). */
  placements?: PlayPlacement[];
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

/**
 * Play rank of `appId` for a keyword: our app's own rank, or a competitor's
 * from `competitorRanks`. Null when it is outside the top 30 (or not crawled).
 */
export function playRankFor(item: PlayKeywordItem, appId: string): number | null {
  if (appId === item.appId) return item.rank;
  return item.competitorRanks?.[appId] ?? null;
}

export type PlayPlacement = { appId: string; label: string; rank: number };

/**
 * The tracked apps (other than `selectedAppId`) that rank for a keyword,
 * best first - what the Competitors column shows. Our app counts as one when
 * a competitor is selected.
 */
export function playPlacements(
  item: PlayKeywordItem,
  apps: PlayApp[],
  selectedAppId: string
): PlayPlacement[] {
  const placements: PlayPlacement[] = [];
  for (const app of apps) {
    if (app.id === selectedAppId) continue;
    const rank = playRankFor(item, app.id);
    if (rank != null) placements.push({ appId: app.id, label: shortPlayAppName(app), rank });
  }
  return placements.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/** "Paladin 3 · Nibble 7", or "" when none ranks. */
export function formatPlayPlacements(placements: PlayPlacement[]): string {
  return placements.map((placement) => `${placement.label} ${placement.rank}`).join(" · ");
}

/**
 * The Play side of a keyword for `appId` (default: the item's own app). The
 * API keeps a previous position for our app only, so a competitor has no
 * change.
 */
export function toPlaySide(item: PlayKeywordItem, appId: string = item.appId): StoreSide {
  const own = appId === item.appId;
  return {
    keyword: item.keyword,
    popularity: item.autocompleteLetters,
    popularityChange: null,
    suggestionRank: item.autocompleteRank,
    popularityPending: item.autocompleteCheckedAt == null,
    rank: playRankFor(item, appId),
    rankChange: own ? item.rankChange : null,
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
