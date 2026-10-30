import { logger } from "../../utils/logger";
import { reportBugsnagError } from "../telemetry/error-reporter";
import { getPlayCountry } from "../../shared/play-countries";
import { PLAY_WEB_USER_AGENT, playRequest } from "./play-http";
import {
  parsePlaySearchPage,
  PlayContractError,
  type PlaySearchParseResult,
} from "./play-search-parser";
import {
  buildPlaySuggestBody,
  parsePlaySuggestResponse,
  PLAY_SUGGEST_RPC_ID,
} from "./play-suggest-parser";

export const PLAY_SEARCH_URL = "https://play.google.com/store/search";
export const PLAY_SUGGEST_URL = "https://play.google.com/_/PlayStoreUi/data/batchexecute";

const CONTRACT_REPORT_DEDUPE_MS = 60 * 60 * 1000;
const contractLastReportedAt = new Map<string, number>();

/**
 * Google Play's counterpart of reportAppleContractChange: the page or RPC no
 * longer has the shape the parser expects. Logged every time, reported to
 * Bugsnag at most once an hour per operation and signal. The keyword is
 * recorded as a failure; no ranks are written from a page we could not read.
 */
export function reportPlayContractChange(params: {
  operation: "play.search" | "play.suggest";
  error: PlayContractError;
  keyword: string;
  country: string;
}): void {
  logger.error(
    `[play] contract change ${params.operation} signal=${params.error.signal} country=${params.country} keyword=${JSON.stringify(params.keyword)}: ${params.error.message}`
  );
  const key = `${params.operation}:${params.error.signal}`;
  const now = Date.now();
  if (now - (contractLastReportedAt.get(key) ?? 0) < CONTRACT_REPORT_DEDUPE_MS) return;
  contractLastReportedAt.set(key, now);
  reportBugsnagError(params.error, {
    surface: "aso-google-play",
    source: `play.contract.${params.operation}`,
    operation: params.operation,
    playContractChange: {
      operation: params.operation,
      actualSignal: params.error.signal,
      country: params.country,
    },
    telemetryHint: {
      // The store-contract-drift bucket; the provider says which store.
      classification: "apple_contract_change",
      upstreamProvider: "google-play",
      source: `play.contract.${params.operation}`,
      operation: params.operation,
      stage: "contract-change",
      isTerminal: false,
    },
  });
}

export function resetPlayContractReportsForTests(): void {
  contractLastReportedAt.clear();
}

function acceptLanguage(language: string, country: string): string {
  return `${language}-${country},${language};q=0.9`;
}

/** One search page, parsed. Throws PlayContractError (after reporting it) on an unreadable page. */
export async function fetchPlaySearch(
  keyword: string,
  country: string
): Promise<PlaySearchParseResult> {
  const { country: gl, language } = getPlayCountry(country);
  const response = await playRequest({
    method: "GET",
    url: PLAY_SEARCH_URL,
    operation: "play.search",
    params: { q: keyword, c: "apps", hl: language, gl },
    headers: {
      "User-Agent": PLAY_WEB_USER_AGENT,
      "Accept-Language": acceptLanguage(language, gl),
    },
  });
  try {
    return parsePlaySearchPage(String(response.data ?? ""), keyword);
  } catch (error) {
    if (error instanceof PlayContractError) {
      reportPlayContractChange({ operation: "play.search", error, keyword, country: gl });
    }
    throw error;
  }
}

/** Play's search suggestions for a prefix, in order (up to 5). */
export async function fetchPlaySuggestions(prefix: string, country: string): Promise<string[]> {
  const { country: gl, language } = getPlayCountry(country);
  const response = await playRequest({
    method: "POST",
    url: `${PLAY_SUGGEST_URL}?rpcids=${PLAY_SUGGEST_RPC_ID}&hl=${language}&gl=${gl}`,
    operation: "play.suggest",
    data: buildPlaySuggestBody(prefix),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": PLAY_WEB_USER_AGENT,
      "Accept-Language": acceptLanguage(language, gl),
    },
    timeoutMs: 15_000,
  });
  try {
    return parsePlaySuggestResponse(String(response.data ?? ""), prefix);
  } catch (error) {
    if (error instanceof PlayContractError) {
      reportPlayContractChange({ operation: "play.suggest", error, keyword: prefix, country: gl });
    }
    throw error;
  }
}
