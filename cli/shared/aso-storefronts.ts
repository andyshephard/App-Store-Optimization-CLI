/**
 * Single source of truth for App Store storefronts.
 *
 * Replaces two duplicate one-entry tables that previously lived in
 * `services/cache-api/services/aso-enrichment-service.ts` (STORE_FRONT_ID_BY_COUNTRY)
 * and `services/cache-api/services/aso-app-doc-service.ts` (APP_STORE_FRONT_ID_BY_COUNTRY),
 * both of which built the same `${id}-1,29` header.
 *
 * This module deliberately imports nothing: `domain/keywords/policy` and
 * `shared/aso-storefront-localizations` both depend on it.
 *
 * IMPORTANT — the header is `<storefrontId>-<languageIndex>,<platformId>`, and the
 * language index is PER STOREFRONT, not a constant. Upstream hardcoded `-1,` which
 * only works for US; every other storefront 400s with it. Verified empirically:
 *
 *   US 143441 → 1  (English)      GB 143444 → 2  (English)
 *   FR 143442 → 3  (French)       DE 143443 → 4  (German)
 *   IT 143450 → 7  (Italian)      ES 143454 → 8  (Spanish)
 *   PT 143453 → 24 (Portuguese)   AU 143460 → 2  (English)
 *   IE 143476 → 2  (English)      NZ 143461 → 2  (English)
 *   CA 143455 → 6  (English; 5 is French, and Canada really serves both)
 *
 * On every non-US storefront index 2 also returns 200, but with ENGLISH
 * metadata — so a 200 is not proof the index is right. The indexes above were
 * each confirmed against two different apps (Wikipedia 324715238 and
 * Chunks 6692632196) by checking `genreNames` came back in the local language.
 * Indexes are storefront-level, not per app.
 *
 * Picking the wrong index does not error — it silently returns another language's
 * title/subtitle, which corrupts keyword-match detection and therefore difficulty
 * scores. Always use the storefront's native language.
 *
 * To add a storefront, find its index empirically rather than trusting a list:
 *
 *   for i in 1 2 3 4 5; do
 *     curl -s -o /tmp/sf.json -w "$i %{http_code}\n" \
 *       -H "X-Apple-Store-Front: <id>-$i,29" -H 'Accept: application/json' \
 *       https://apps.apple.com/app/id324715238
 *   done
 *
 * then check which 200 returns that country's language (compare `genreNames`).
 *
 * Ranking does NOT depend on any of this — the App Store search page takes the
 * storefront as a URL path segment (`/gb/iphone/search`). The header only affects
 * the MZSearch fallback and the app-detail document fetch.
 */

export type AsoStorefront = {
  country: string;
  /** Human-readable storefront name, shown in the dashboard's storefront picker. */
  name: string;
  storefrontId: number;
  /**
   * Language index inside the storefront, used in the `X-Apple-Store-Front`
   * header. Per-storefront — see the module comment. Must be the storefront's
   * NATIVE language or localized metadata comes back in the wrong language.
   */
  languageIndex: number;
  defaultLanguage: string;
  /**
   * Extra localizations to fetch when detecting keyword matches in localized
   * titles/subtitles. Each entry costs one extra request per app, so English
   * storefronts intentionally list none.
   */
  additionalLanguages: string[];
};

export const ASO_STOREFRONTS: Record<string, AsoStorefront> = {
  US: {
    country: "US",
    name: "United States",
    storefrontId: 143441,
    languageIndex: 1,
    defaultLanguage: "en-US",
    additionalLanguages: [
      "ar",
      "zh-Hans",
      "zh-Hant",
      "fr-FR",
      "ko-KR",
      "pt-BR",
      "ru-RU",
      "es-MX",
      "vi",
    ],
  },
  GB: {
    country: "GB",
    name: "United Kingdom",
    storefrontId: 143444,
    languageIndex: 2,
    defaultLanguage: "en-GB",
    additionalLanguages: [],
  },
  DE: {
    country: "DE",
    name: "Germany",
    storefrontId: 143443,
    languageIndex: 4,
    defaultLanguage: "de-DE",
    additionalLanguages: ["en-GB"],
  },
  FR: {
    country: "FR",
    name: "France",
    storefrontId: 143442,
    languageIndex: 3,
    defaultLanguage: "fr-FR",
    additionalLanguages: ["en-GB"],
  },
  IT: {
    country: "IT",
    name: "Italy",
    storefrontId: 143450,
    languageIndex: 7,
    defaultLanguage: "it-IT",
    additionalLanguages: ["en-GB"],
  },
  ES: {
    country: "ES",
    name: "Spain",
    storefrontId: 143454,
    languageIndex: 8,
    defaultLanguage: "es-ES",
    additionalLanguages: ["en-GB"],
  },
  PT: {
    country: "PT",
    name: "Portugal",
    storefrontId: 143453,
    languageIndex: 24,
    defaultLanguage: "pt-PT",
    additionalLanguages: ["en-GB"],
  },
  // English storefronts below. They keep `additionalLanguages` empty because
  // the default language already matches the store, and each extra language
  // costs one more request per app. Note the locales are NOT interchangeable:
  // Apple serves a different localization for ?l=en-AU than for ?l=en-GB, so
  // titles and subtitles differ per storefront.
  CA: {
    country: "CA",
    name: "Canada",
    storefrontId: 143455,
    languageIndex: 6,
    defaultLanguage: "en-CA",
    // Canada is genuinely bilingual and Apple serves fr-CA metadata, so French
    // titles are fetched too — otherwise a French keyword would look unmatched
    // against an app that does carry a French title.
    additionalLanguages: ["fr-CA"],
  },
  AU: {
    country: "AU",
    name: "Australia",
    storefrontId: 143460,
    languageIndex: 2,
    defaultLanguage: "en-AU",
    additionalLanguages: [],
  },
  IE: {
    country: "IE",
    name: "Ireland",
    storefrontId: 143476,
    languageIndex: 2,
    defaultLanguage: "en-IE",
    additionalLanguages: [],
  },
  NZ: {
    country: "NZ",
    name: "New Zealand",
    storefrontId: 143461,
    languageIndex: 2,
    defaultLanguage: "en-NZ",
    additionalLanguages: [],
  },
};

export const MZSEARCH_PLATFORM_ID_JSON = 29;

export function isKnownStorefront(country: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    ASO_STOREFRONTS,
    country.toUpperCase()
  );
}

export function getStorefront(country: string): AsoStorefront {
  const normalized = country.toUpperCase();
  const storefront = ASO_STOREFRONTS[normalized];
  if (!storefront) {
    throw new Error(
      `Unknown storefront ${normalized}. Add it to cli/shared/aso-storefronts.ts (known: ${Object.keys(
        ASO_STOREFRONTS
      ).join(", ")}).`
    );
  }
  return storefront;
}

export function getStorefrontId(country: string): number {
  return getStorefront(country).storefrontId;
}

/** The `x-apple-store-front` / `X-Apple-Store-Front` header value. */
export function getStoreFrontHeader(country: string): string {
  const storefront = getStorefront(country);
  return `${storefront.storefrontId}-${storefront.languageIndex},${MZSEARCH_PLATFORM_ID_JSON}`;
}

/** App Store web search URL — the storefront is the path segment, not a header. */
export function getSearchUrl(country: string): string {
  return `https://apps.apple.com/${getStorefront(
    country
  ).country.toLowerCase()}/iphone/search`;
}

/** `Accept-Language` for web requests against a storefront. */
export function getAcceptLanguage(country: string): string {
  const language = getStorefront(country).defaultLanguage;
  const base = language.split("-")[0];
  return `${language},${base};q=0.9`;
}

/** The `dslang` cookie MZSearch expects, e.g. `US-EN` / `GB-EN`. */
export function getDsLangCookieValue(country: string): string {
  const storefront = getStorefront(country);
  const base = storefront.defaultLanguage.split("-")[0].toUpperCase();
  return `${storefront.country.toUpperCase()}-${base}`;
}
