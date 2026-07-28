import { DEFAULT_ASO_COUNTRY } from "../domain/keywords/policy";
import { ASO_STOREFRONTS } from "./aso-storefronts";

export type StorefrontLanguageConfig = {
  defaultLanguage: string;
  additionalLanguages?: string[];
};

type NormalizedStorefrontLanguageConfig = {
  defaultLanguage: string;
  additionalLanguages: string[];
};

/**
 * Derived from ASO_STOREFRONTS so there is one place to add a storefront.
 * Kept as a named export because it is part of the module's existing surface.
 */
export const ASO_STOREFRONT_LANGUAGES_BY_COUNTRY: Record<
  string,
  StorefrontLanguageConfig
> = Object.fromEntries(
  Object.values(ASO_STOREFRONTS).map((storefront) => [
    storefront.country,
    {
      defaultLanguage: storefront.defaultLanguage,
      additionalLanguages: storefront.additionalLanguages,
    },
  ])
);

/**
 * Deliberately lenient: falls back to the US config for unknown countries.
 * The dashboard builds App Store URLs for arbitrary storefronts an app is sold
 * in (see `buildAppStoreUrl` in cli/dashboard-ui/app-helpers.ts), and throwing
 * there would break URL construction for any country not in the table.
 *
 * The crawl path does NOT rely on this leniency — it goes through
 * `getStorefront()` in ./aso-storefronts, which throws for unknown storefronts
 * so a misconfigured country fails loudly instead of silently scraping en-US
 * pages and mis-detecting keyword matches.
 *
 * Reads the exported map rather than ASO_STOREFRONTS directly so callers (and
 * tests) can register storefronts at runtime.
 */
export function getStorefrontLanguageConfig(
  country: string
): NormalizedStorefrontLanguageConfig {
  const normalizedCountry = country.toUpperCase();
  const config =
    ASO_STOREFRONT_LANGUAGES_BY_COUNTRY[normalizedCountry] ??
    ASO_STOREFRONT_LANGUAGES_BY_COUNTRY[DEFAULT_ASO_COUNTRY];
  return {
    defaultLanguage: config.defaultLanguage,
    additionalLanguages: Array.isArray(config.additionalLanguages)
      ? [...config.additionalLanguages]
      : [],
  };
}

export function getStorefrontDefaultLanguage(country: string): string {
  return getStorefrontLanguageConfig(country).defaultLanguage;
}

export function getStorefrontAdditionalLanguages(country: string): string[] {
  return [...getStorefrontLanguageConfig(country).additionalLanguages];
}

export function getStorefrontLanguages(country: string): string[] {
  const config = getStorefrontLanguageConfig(country);
  return [config.defaultLanguage, ...config.additionalLanguages];
}
