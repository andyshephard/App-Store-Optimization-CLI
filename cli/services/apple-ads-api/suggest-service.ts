import { normalizeKeyword } from "../../shared/aso-keyword-utils";
import { listKeywords } from "../../db/aso-keywords";
import { isAppleAdsApiConfigured } from "./apple-ads-api-config";
import { fetchKeywordSuggestions } from "./keyword-suggestions-service";
import { fetchGenreTopSearchTerms } from "./search-term-popularity-service";
import { ContextualError } from "../../utils/error-handling-helpers";

export interface AdsTargetSuggestion {
  keyword: string;
  /** Global 1-100 relative popularity from the suggestions endpoint. */
  popularity: number;
  alreadyTracked: boolean;
}

export interface MetadataCandidateSuggestion {
  keyword: string;
  /** Country-wide 1-100 popularity for the requested storefront. */
  popularity: number;
  genre: string;
  rankInGenre: number;
  alreadyTracked: boolean;
}

export interface KeywordSuggestionsResult {
  country: string;
  /**
   * Apple's bid recommendations for the app — competitor-brand-heavy, so
   * suited to Search Ads targeting rather than App Store metadata.
   */
  adsTargets: AdsTargetSuggestion[];
  /**
   * Generic demand from the genre's weekly top chart in this storefront,
   * with true per-country popularity — candidates for metadata once scored
   * for difficulty via `aso keywords`.
   */
  metadataCandidates: MetadataCandidateSuggestion[];
}

export async function buildKeywordSuggestions(options: {
  appId: string;
  country: string;
  genre?: string;
  seeds?: string[];
  limit?: number;
}): Promise<KeywordSuggestionsResult> {
  if (!isAppleAdsApiConfigured()) {
    throw new ContextualError(
      "`aso suggest` needs Apple Ads Platform API credentials. Write ~/.aso/apple-ads-api/credentials.json (clientId, teamId, keyId) with private-key.pem alongside, or set the ASO_ADS_API_* environment variables. See the README's Data Sources & APIs section."
    );
  }
  const country = options.country.toUpperCase();
  const limit = options.limit ?? 25;

  const tracked = new Set(
    listKeywords(country).map((keyword) => keyword.normalizedKeyword)
  );

  const [suggestions, chartRows] = await Promise.all([
    fetchKeywordSuggestions(options.appId, country, options.seeds ?? []),
    options.genre
      ? fetchGenreTopSearchTerms(country, options.genre, { limit: limit * 3 })
      : Promise.resolve([]),
  ]);

  const adsTargets = suggestions
    .map((suggestion) => ({
      keyword: suggestion.text,
      popularity: suggestion.popularity,
      alreadyTracked: tracked.has(normalizeKeyword(suggestion.text)),
    }))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit);

  const suggestionTerms = new Set(
    suggestions.map((suggestion) => normalizeKeyword(suggestion.text))
  );
  const metadataCandidates = chartRows
    .map((row) => ({
      keyword: row.searchTerm,
      popularity: row.searchPopularity1to100,
      genre: row.genre,
      rankInGenre: row.rankInGenre,
      alreadyTracked: tracked.has(normalizeKeyword(row.searchTerm)),
    }))
    // Terms Apple also suggests as bid targets are overwhelmingly brand
    // names; keeping them out of the metadata list leaves the generic demand.
    .filter(
      (candidate) => !suggestionTerms.has(normalizeKeyword(candidate.keyword))
    )
    .slice(0, limit);

  return { country, adsTargets, metadataCandidates };
}
