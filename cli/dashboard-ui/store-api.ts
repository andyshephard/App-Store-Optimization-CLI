import { apiGet, apiWrite } from "./app-helpers";
import type { IosKeywordItem, PlayApp, PlayKeywordItem } from "./store-merge";

/** The store views read every row at once and sort/filter in the browser. */
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const HISTORY_PAGE_SIZE = 5000;
const HISTORY_DAYS = 90;

type PagedPayload<T> = { items?: T[]; hasNextPage?: boolean };

async function fetchAllKeywordPages<T>(params: URLSearchParams): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    params.set("page", String(page));
    const data = await apiGet<PagedPayload<T>>(`/api/aso/keywords?${params.toString()}`);
    items.push(...(data.items ?? []));
    if (!data.hasNextPage) break;
  }
  return items;
}

export function fetchPlayKeywords(country: string): Promise<PlayKeywordItem[]> {
  // No appId: the server uses ASO_PLAY_APP_ID.
  return fetchAllKeywordPages<PlayKeywordItem>(
    new URLSearchParams({
      platform: "android",
      country,
      pageSize: String(PAGE_SIZE),
      sortBy: "keyword",
      sortDir: "asc",
    })
  );
}

/** Our Play app (ASO_PLAY_APP_ID) first, then the competitors. */
export async function fetchPlayApps(): Promise<PlayApp[]> {
  const data = await apiGet<{ items?: PlayApp[] }>("/api/apps?platform=android");
  return data.items ?? [];
}

export function addPlayCompetitor(appId: string) {
  return apiWrite<{ id: string; name: string | null; added: boolean }>("POST", "/api/apps", {
    platform: "android",
    appId,
  });
}

export function removePlayCompetitor(appId: string) {
  return apiWrite<{ id: string }>("DELETE", "/api/apps", { platform: "android", appId });
}

export function fetchIosKeywords(country: string, appId: string): Promise<IosKeywordItem[]> {
  return fetchAllKeywordPages<IosKeywordItem>(
    new URLSearchParams({
      country,
      appId,
      pageSize: String(PAGE_SIZE),
      sortBy: "keyword",
      sortDir: "asc",
    })
  );
}

export function addPlayKeywords(country: string, keywords: string[]) {
  return apiWrite<{ addedCount: number; refreshStarted: boolean }>(
    "POST",
    "/api/aso/keywords",
    { platform: "android", country, keywords }
  );
}

export function removePlayKeywords(country: string, keywords: string[]) {
  return apiWrite<{ removedCount: number }>("DELETE", "/api/aso/keywords", {
    platform: "android",
    country,
    keywords,
  });
}

/**
 * Tracks keywords on the App Store without starting an Apple crawl, so no
 * Apple session is needed: popularity and rank arrive with the next refresh.
 */
export function addIosKeywordsDeferred(country: string, appId: string, keywords: string[]) {
  return apiWrite<unknown>("POST", "/api/aso/keywords", {
    appId,
    country,
    keywords,
    defer: true,
  });
}

export type PlayHistoryPoint = { date: string; position: number | null };

type PlayHistoryPayload = {
  items?: Array<{
    appId: string;
    keyword: string;
    country: string;
    date: string;
    position: number | null;
  }>;
  hasNextPage?: boolean;
};

/**
 * Daily Play rank for one keyword over the last 90 days. The endpoint filters
 * by app and date only, so keyword and country are picked out here.
 *
 * A competitor only gets a history point on days it ranks. With
 * `crawledByAppId` (our app, which gets a point on every crawl), a day the
 * keyword was crawled without a point for the competitor becomes a null
 * ("outside the top 30") from `trackedSince` on, rather than the line
 * joining across it. Before `trackedSince` such days are left out.
 */
export async function fetchPlayPositionHistory(params: {
  appId: string;
  keyword: string;
  country: string;
  crawledByAppId?: string;
  trackedSince?: string | null;
  now?: Date;
}): Promise<PlayHistoryPoint[]> {
  const since = new Date(
    (params.now ?? new Date()).getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  const reference =
    params.crawledByAppId && params.crawledByAppId !== params.appId
      ? params.crawledByAppId
      : null;
  const points: PlayHistoryPoint[] = [];
  const crawledDays = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      platform: "android",
      appIds: reference ? `${params.appId},${reference}` : params.appId,
      since,
      limit: String(HISTORY_PAGE_SIZE),
      offset: String(page * HISTORY_PAGE_SIZE),
    });
    const data = await apiGet<PlayHistoryPayload>(
      `/api/aso/position-history?${query.toString()}`
    );
    for (const item of data.items ?? []) {
      if (item.keyword !== params.keyword || item.country !== params.country) continue;
      if (item.appId === params.appId) {
        points.push({ date: item.date, position: item.position });
      } else {
        crawledDays.add(item.date);
      }
    }
    if (!data.hasNextPage) break;
  }
  if (reference) {
    const fromDay = (params.trackedSince ?? "").slice(0, 10);
    const seen = new Set(points.map((point) => point.date));
    for (const date of crawledDays) {
      if (!seen.has(date) && date >= fromDay) points.push({ date, position: null });
    }
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}
