import { asoAppleGet } from "../cache-api/services/aso-apple-client";
import { ASO_APPLE_WEB_USER_AGENT } from "../../shared/aso-apple-http";
import { getStoreFrontHeader } from "../../shared/aso-storefronts";
import { logger } from "../../utils/logger";
import {
  countTrackedKeywords,
  listKeywordsDueForAutocomplete,
  upsertKeywordAutocomplete,
  type KeywordAutocomplete,
} from "../../db/aso-keyword-autocomplete";

/**
 * App Store autocomplete as a demand signal.
 *
 * Apple only suggests a term while you type if people search it, and the
 * fewer letters needed before it appears, the more it is searched. Measured
 * 2026-09-27 against Astro: terms Astro scores as having demand (history,
 * stoicism, mythology, fun facts) appear within 3–5 letters even where
 * Apple's popularity endpoint says 5; terms with no demand ("viking history",
 * "stoic philosophy") are never suggested.
 */

const HINTS_URL = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints";
const MAX_LETTERS = 20;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Suggestion terms, in Apple's order, parsed from the plist response. */
export function parseHintTerms(body: string): string[] {
  const terms: string[] = [];
  const re = /<key>term<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) terms.push(decodeXml(m[1]).trim().toLowerCase());
  return terms;
}

export async function fetchHints(prefix: string, country: string): Promise<string[]> {
  const response = await asoAppleGet<string>(HINTS_URL, {
    operation: "mzsearch.hints",
    params: { clientApplication: "Software", term: prefix },
    headers: {
      "User-Agent": ASO_APPLE_WEB_USER_AGENT,
      "X-Apple-Store-Front": getStoreFrontHeader(country),
    },
    responseType: "text",
    timeout: 15000,
  });
  return parseHintTerms(String(response.data ?? ""));
}

/**
 * Fewest letters (from 2) of `keyword` before Apple suggests it, and its
 * position in that list. Stops at the first prefix with no suggestions at
 * all, since typing more rarely brings them back.
 */
export async function measureAutocomplete(
  keyword: string,
  country: string,
  hints: (prefix: string, country: string) => Promise<string[]> = fetchHints
): Promise<{ lettersNeeded: number | null; hintRank: number | null }> {
  const term = keyword.trim().toLowerCase();
  const last = Math.min(term.length, MAX_LETTERS);
  for (let n = 2; n <= last; n += 1) {
    const prefix = term.slice(0, n);
    if (prefix.endsWith(" ")) continue;
    const list = await hints(prefix, country);
    const index = list.indexOf(term);
    if (index >= 0) return { lettersNeeded: n, hintRank: index + 1 };
    if (list.length === 0) break;
  }
  return { lettersNeeded: null, hintRank: null };
}

let running = false;

/** Pause before every hint request; the old per-keyword pause, now per request. */
const DEFAULT_PREFIX_DELAY_MS = 250;
const WEEK_DAYS = 7;

/**
 * Hint lookups for one refresh: each prefix is asked at most once (related
 * keywords share most of their prefixes), and every real request is
 * preceded by a pause. Before this, a keyword's 2..20 prefixes went out
 * back to back and only keywords were paced.
 */
export function createPacedHintFetcher(options: {
  delayMs?: number;
  fetch?: (prefix: string, country: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
} = {}): {
  hints: (prefix: string, country: string) => Promise<string[]>;
  stats: () => { requests: number; cacheHits: number };
} {
  const delayMs = options.delayMs ?? DEFAULT_PREFIX_DELAY_MS;
  const fetch = options.fetch ?? fetchHints;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<string, string[]>();
  let requests = 0;
  let cacheHits = 0;
  return {
    hints: async (prefix, country) => {
      const key = `${country.toUpperCase()}\u0000${prefix}`;
      const cached = cache.get(key);
      if (cached) {
        cacheHits += 1;
        return cached;
      }
      if (requests > 0) await sleep(delayMs);
      requests += 1;
      const list = await fetch(prefix, country);
      cache.set(key, list);
      return list;
    },
    stats: () => ({ requests, cacheHits }),
  };
}

/**
 * Re-measure tracked keywords not checked within `maxAgeDays`. Single-flight;
 * a second call while one runs returns immediately.
 *
 * Spread over the week: unless `limit` is given, a call checks about a
 * seventh of the storefront's tracked keywords (oldest first), so a daily
 * trigger covers everything once a week instead of all of it in one burst.
 */
export async function refreshAutocomplete(
  country: string,
  options: {
    maxAgeDays?: number;
    limit?: number;
    delayMs?: number;
    fetch?: (prefix: string, country: string) => Promise<string[]>;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ started: boolean; checked: number; suggested: number; requests?: number }> {
  if (running) return { started: false, checked: 0, suggested: 0 };
  running = true;
  try {
    const maxAgeDays = options.maxAgeDays ?? WEEK_DAYS;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const limit =
      options.limit ?? Math.max(1, Math.ceil(countTrackedKeywords(country) / WEEK_DAYS));
    const due = listKeywordsDueForAutocomplete(country, cutoff, limit);
    const fetcher = createPacedHintFetcher({
      delayMs: options.delayMs,
      fetch: options.fetch,
      sleep: options.sleep,
    });
    let suggested = 0;
    for (const keyword of due) {
      try {
        const result = await measureAutocomplete(keyword, country, fetcher.hints);
        const row: KeywordAutocomplete = {
          country,
          keyword,
          ...result,
          checkedAt: new Date().toISOString(),
        };
        upsertKeywordAutocomplete([row]);
        if (result.lettersNeeded !== null) suggested += 1;
      } catch (error) {
        logger.debug(`[autocomplete] ${keyword} skipped: ${String(error)}`);
      }
    }
    const { requests, cacheHits } = fetcher.stats();
    logger.info(
      `[autocomplete] ${country}: checked=${due.length} limit=${limit} requests=${requests} prefixCacheHits=${cacheHits}`
    );
    return { started: true, checked: due.length, suggested, requests };
  } finally {
    running = false;
  }
}

export function isAutocompleteRefreshRunning(): boolean {
  return running;
}
