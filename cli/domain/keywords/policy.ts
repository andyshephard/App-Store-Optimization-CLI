import { ASO_STOREFRONTS } from "../../shared/aso-storefronts";

export const DEFAULT_ASO_COUNTRY = "US" as const;

export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export function sanitizeKeywords(input: string[]): string[] {
  const unique = new Set<string>();
  for (const keyword of input) {
    const normalized = normalizeKeyword(keyword);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

export function normalizeCountry(input: string | undefined | null): string {
  return (input ?? DEFAULT_ASO_COUNTRY).toUpperCase();
}

/**
 * Storefronts the CLI is allowed to query, read from `ASO_SUPPORTED_COUNTRIES`
 * (comma-separated, e.g. "US,GB"). Defaults to US alone, so with the variable
 * unset behaviour is identical to upstream.
 */
export function getSupportedCountries(): Set<string> {
  const raw = process.env.ASO_SUPPORTED_COUNTRIES;
  const countries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  return countries.length ? new Set(countries) : new Set([DEFAULT_ASO_COUNTRY]);
}

export type EnabledStorefront = {
  country: string;
  name: string;
  isDefault: boolean;
};

/**
 * Storefronts that are both enabled (ASO_SUPPORTED_COUNTRIES) and known
 * (present in ASO_STOREFRONTS). Enabled-but-unknown countries are dropped:
 * they have no storefront id or language index, so every crawl would throw.
 * The default country is always first; the rest sort alphabetically.
 */
export function listEnabledStorefronts(): EnabledStorefront[] {
  const supported = getSupportedCountries();
  return Object.values(ASO_STOREFRONTS)
    .filter((storefront) => supported.has(storefront.country))
    .map((storefront) => ({
      country: storefront.country,
      name: storefront.name,
      isDefault: storefront.country === DEFAULT_ASO_COUNTRY,
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.country.localeCompare(b.country);
    });
}

/** True when `country` is both enabled and a known storefront. */
export function isEnabledStorefront(country: string): boolean {
  const normalized = normalizeCountry(country);
  return listEnabledStorefronts().some((entry) => entry.country === normalized);
}

export function assertSupportedCountry(country: string): void {
  const normalized = normalizeCountry(country);
  const supported = getSupportedCountries();
  if (!supported.has(normalized)) {
    throw new Error(
      `Country ${normalized} is not enabled. Set ASO_SUPPORTED_COUNTRIES to include it ` +
        `(currently: ${Array.from(supported).join(", ")}).`
    );
  }
}
