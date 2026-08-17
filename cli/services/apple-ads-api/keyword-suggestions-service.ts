import { appleAdsApiPost } from "./apple-ads-api-client";

const SUGGESTIONS_PATH = "/v1/suggestions/keywords/query";
const SUGGESTIONS_PAGE_SIZE = 100;

export interface KeywordSuggestion {
  text: string;
  /** Relative popularity, 1-100. Global across storefronts, not per-country. */
  popularity: number;
}

interface SuggestionsResponse {
  result: KeywordSuggestion[] | null;
  pagination: { offset: number; pageSize: number; totalCount?: number } | null;
}

/**
 * Apple's own keyword suggestions for an app — the terms it recommends
 * bidding on in Search Ads. Heavily weighted toward competitor brand names,
 * which makes it a bid-target list rather than a metadata source: brand terms
 * cannot go in App Store metadata but bidding on them is standard practice.
 *
 * Unseeded queries return generic chart-toppers (facebook, youtube), so
 * always pass seed terms describing the app's niche.
 */
export async function fetchKeywordSuggestions(
  appId: string,
  country: string,
  seeds: string[]
): Promise<KeywordSuggestion[]> {
  const filters: Array<Record<string, unknown>> = [
    { field: "promotedObjectId", operator: "EQUALS", value: [appId] },
    { field: "promotedObjectType", operator: "EQUALS", value: ["APPSTORE_APP"] },
    {
      field: "countriesOrRegions",
      operator: "IN",
      value: [country.toUpperCase()],
    },
  ];
  if (seeds.length > 0) {
    filters.push({ field: "terms", operator: "IN", value: seeds });
  }
  const response = await appleAdsApiPost<SuggestionsResponse>(
    SUGGESTIONS_PATH,
    {
      filters,
      pagination: { offset: 0, pageSize: SUGGESTIONS_PAGE_SIZE },
    }
  );
  return (response.result ?? []).filter(
    (item) => typeof item.text === "string" && item.text.trim().length > 0
  );
}
