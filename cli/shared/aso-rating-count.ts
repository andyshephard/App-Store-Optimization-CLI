import { getStorefront, isKnownStorefront } from "./aso-storefronts";

/**
 * Rating counts on the App Store search page are pre-formatted strings in the
 * storefront's locale, not numbers. Parsing them with a single en-US rule is
 * wrong in two directions:
 *
 *   DE "428.932"  → 428,932 ratings, but `parseFloat` reads 428.932 → 428
 *   ES "6,8 mil"  → 6,800 ratings,   but a `K`/`M`-only suffix table gives 68
 *
 * Both feed `appCompetitiveScore` and therefore `difficulty_score`, so getting
 * them wrong silently skews every score in that storefront.
 *
 * Observed on apps.apple.com/{cc}/iphone/search (2026-07):
 *
 *   US "6.2K"  "64K"   "417"
 *   GB "9.3k"  "17k"   "774"
 *   DE "1404"  "428.932"                (grouped by ".", no suffix)
 *   FR "8,4 k" "73 k"  "849"            (NBSP before the suffix)
 *   ES "6,8 mil" "2,5 mil" "354"
 *   IT "5,9K"  "532"
 *   PT "1,3 mil" "11 mil" "47"
 */

type NumberSeparators = {
  decimal: string;
  group: string;
};

/** Multiplier suffixes, lowercased and stripped of "." and spaces. */
const SUFFIX_MULTIPLIERS_BY_LANGUAGE: Record<string, Record<string, number>> = {
  en: { k: 1e3, m: 1e6, b: 1e9 },
  de: { k: 1e3, tsd: 1e3, m: 1e6, mio: 1e6, mrd: 1e9 },
  fr: { k: 1e3, m: 1e6, mn: 1e6, mrd: 1e9 },
  es: { k: 1e3, mil: 1e3, m: 1e6, mill: 1e6, mn: 1e6 },
  it: { k: 1e3, mila: 1e3, m: 1e6, mln: 1e6, mld: 1e9 },
  pt: { k: 1e3, mil: 1e3, m: 1e6, mi: 1e6, mm: 1e9 },
};

const separatorCache = new Map<string, NumberSeparators>();

/**
 * Reads the locale's separators from Intl rather than hardcoding them, so a new
 * storefront only needs its `defaultLanguage` set. Falls back to en-US rules if
 * the runtime has no data for the locale.
 */
function getNumberSeparators(locale: string): NumberSeparators {
  const cached = separatorCache.get(locale);
  if (cached) return cached;

  let separators: NumberSeparators = { decimal: ".", group: "," };
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    const decimal = parts.find((part) => part.type === "decimal")?.value;
    const group = parts.find((part) => part.type === "group")?.value;
    separators = {
      decimal: decimal || separators.decimal,
      group: group || separators.group,
    };
  } catch {
    // keep the en-US defaults
  }

  separatorCache.set(locale, separators);
  return separators;
}

function getLanguageBase(country: string): string {
  if (!isKnownStorefront(country)) return "en";
  return getStorefront(country).defaultLanguage.split("-")[0].toLowerCase();
}

function getLocale(country: string): string {
  if (!isKnownStorefront(country)) return "en-US";
  return getStorefront(country).defaultLanguage;
}

/** Strips characters Apple mixes into the suffix: NBSP, narrow NBSP, ".". */
function normalizeSuffix(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s  .]/g, "")
    .replace(/[^a-z]/g, "");
}

export function parseLocalizedRatingCount(
  value: string | number | undefined | null,
  country: string
): number {
  if (value == null) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  const raw = String(value).replace(/[  ]/g, " ").trim();
  if (!raw) return 0;

  // Split "6,8 mil" / "9.3k" / "428.932" into digits-and-separators + suffix.
  const match = raw.match(/^([0-9][0-9.,\s]*)\s*([^\d]*)$/);
  if (!match) return 0;

  const [, numericPart, suffixPart] = match;
  const separators = getNumberSeparators(getLocale(country));
  const suffix = normalizeSuffix(suffixPart);
  const multipliers = SUFFIX_MULTIPLIERS_BY_LANGUAGE[getLanguageBase(country)] ??
    SUFFIX_MULTIPLIERS_BY_LANGUAGE.en;
  const multiplier = suffix ? multipliers[suffix] : 1;

  // An unrecognized suffix means the format changed; 0 is safer than a number
  // that is wrong by three orders of magnitude.
  if (multiplier == null) return 0;

  const groupPattern = new RegExp(
    `[${separators.group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s]`,
    "g"
  );
  const normalizedNumber = numericPart
    .replace(groupPattern, "")
    .replace(separators.decimal, ".");
  const parsed = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(parsed)) return 0;

  return Math.max(0, Math.round(parsed * multiplier));
}
