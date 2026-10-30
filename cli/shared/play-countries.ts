import { ASO_ENV } from "./aso-env";

/**
 * Google Play countries asocli can crawl, and the interface language each is
 * crawled in. Play takes both as query parameters (`gl`, `hl`); there is no
 * storefront header or per-country language index as on the App Store.
 *
 * Only English-language countries for now: rank parsing does not depend on
 * the language, but the install-band parser and the title-match part of
 * difficulty assume English text. Validate a new language before adding it.
 */
export type PlayCountry = {
  country: string;
  name: string;
  /** `hl` - Play's interface language for this country. */
  language: string;
};

export const PLAY_COUNTRIES: Record<string, PlayCountry> = {
  US: { country: "US", name: "United States", language: "en" },
  GB: { country: "GB", name: "United Kingdom", language: "en" },
  AU: { country: "AU", name: "Australia", language: "en" },
  CA: { country: "CA", name: "Canada", language: "en" },
  NZ: { country: "NZ", name: "New Zealand", language: "en" },
  IE: { country: "IE", name: "Ireland", language: "en" },
};

/**
 * Countries enabled by ASO_PLAY_COUNTRIES (default US,GB) that are also in
 * PLAY_COUNTRIES, in configured order. Unknown codes are dropped.
 */
export function listEnabledPlayCountries(): PlayCountry[] {
  const seen = new Set<string>();
  const enabled: PlayCountry[] = [];
  for (const raw of ASO_ENV.playCountries) {
    const code = raw.trim().toUpperCase();
    const entry = PLAY_COUNTRIES[code];
    if (!entry || seen.has(code)) continue;
    seen.add(code);
    enabled.push(entry);
  }
  return enabled;
}

export function isEnabledPlayCountry(country: string): boolean {
  const code = (country ?? "").trim().toUpperCase();
  return listEnabledPlayCountries().some((entry) => entry.country === code);
}

export function getPlayCountry(country: string): PlayCountry {
  const code = (country ?? "").trim().toUpperCase();
  const entry = PLAY_COUNTRIES[code];
  if (!entry) {
    throw new Error(
      `Google Play country ${code || "(empty)"} is not supported. Supported: ${Object.keys(PLAY_COUNTRIES).join(", ")}.`
    );
  }
  return entry;
}
