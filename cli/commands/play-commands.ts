import * as fs from "fs";
import { ASO_ENV } from "../shared/aso-env";
import { logger } from "../utils/logger";
import {
  getPlayCountry,
  isEnabledPlayCountry,
  listEnabledPlayCountries,
} from "../shared/play-countries";
import {
  addPlayAppKeywords,
  removePlayAppKeywords,
  savePlayKeywordObservation,
  upsertPlayKeywordAutocomplete,
} from "../db/play-keywords";
import {
  evaluatePlayKeyword,
  measurePlayAutocomplete,
  reasonCodeForPlayError,
} from "../services/play/play-keyword-service";
import { createPacedHintFetcher } from "../services/keywords/autocomplete-demand-service";
import { fetchPlaySuggestions } from "../services/play/play-client";
import { saveKeywordsToResearchApp, resolveKeywordAssociationAppId } from "../services/keywords/aso-research-keyword-service";
import { deleteAppKeywords } from "../db/app-keywords";
import { assertSupportedCountry, normalizeCountry, sanitizeKeywords } from "../domain/keywords/policy";

/**
 * Google Play on the CLI:
 * - `aso keywords "a,b" --platform android [--country US] [--app-id pkg]`
 *   crawls the terms live (search page + autocomplete), stores the result and
 *   associates them with the app, printing the same `{ items, failedKeywords,
 *   filteredOut }` envelope as the App Store path.
 * - `aso track|untrack "a,b" [--file terms.txt] --platform ios|android
 *   --country US,GB [--app-id id]` only adds or removes associations; the
 *   next background refresh crawls them. This is the seeding command.
 */

function resolvePlayAppId(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : ASO_ENV.playAppId;
}

function assertEnabledPlayCountry(country: string): string {
  const code = getPlayCountry(country).country;
  if (!isEnabledPlayCountry(code)) {
    throw new Error(
      `Google Play country ${code} is not enabled. Set ASO_PLAY_COUNTRIES to include it (currently: ${
        listEnabledPlayCountries()
          .map((entry) => entry.country)
          .join(", ") || "none"
      }).`
    );
  }
  return code;
}

export async function runPlayKeywordsCommand(params: {
  keywords: string[];
  country: string;
  appId?: string;
  associate: boolean;
  stdout: boolean;
}): Promise<void> {
  if (params.stdout) logger.setLevel("warn");
  const country = assertEnabledPlayCountry(params.country);
  const appId = resolvePlayAppId(params.appId);
  const hints = createPacedHintFetcher({ delayMs: 0, fetch: fetchPlaySuggestions });
  const items: unknown[] = [];
  const failedKeywords: Array<{ keyword: string; reasonCode: string; message: string }> = [];
  for (const keyword of params.keywords) {
    try {
      const observation = await evaluatePlayKeyword(keyword, country);
      savePlayKeywordObservation(observation, { rosterAppIds: ASO_ENV.playRosterAppIds });
      let autocomplete: { lettersNeeded: number | null; hintRank: number | null } = {
        lettersNeeded: null,
        hintRank: null,
      };
      try {
        autocomplete = await measurePlayAutocomplete(keyword, country, hints.hints);
        upsertPlayKeywordAutocomplete({ country, keyword, ...autocomplete, checkedAt: new Date().toISOString() });
      } catch (error) {
        logger.warn(`[play] autocomplete for "${keyword}" failed: ${reasonCodeForPlayError(error)}`);
      }
      const rank = appId ? observation.orderedAppIds.indexOf(appId) + 1 || null : null;
      items.push({
        platform: "android",
        keyword,
        country,
        popularity: null,
        autocompleteLetters: autocomplete.lettersNeeded,
        autocompleteRank: autocomplete.hintRank,
        difficultyScore: observation.difficultyScore,
        difficultyModelVersion: observation.difficultyModelVersion,
        appCount: observation.resultCount,
        rankDepth: observation.rankDepth,
        layout: observation.layout,
        ...(appId ? { appId, rank } : {}),
        orderedAppIds: observation.orderedAppIds,
        topApps: observation.topApps.slice(0, 10),
      });
    } catch (error) {
      failedKeywords.push({
        keyword,
        reasonCode: reasonCodeForPlayError(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (items.length === 0 && failedKeywords.length > 0) {
    throw new Error(
      `All keywords failed (${failedKeywords.length}) on Google Play ${country}: ${failedKeywords[0].reasonCode}`
    );
  }
  if (params.associate && appId) {
    addPlayAppKeywords(
      appId,
      (items as Array<{ keyword: string }>).map((item) => item.keyword),
      country
    );
  }
  console.log(JSON.stringify({ items, failedKeywords, filteredOut: [] }, null, 2));
}

/** Keywords from the comma-separated argument and/or a file (one per line, # comments). */
export function collectKeywords(terms: string | undefined, file: string | undefined): string[] {
  const raw: string[] = [];
  if (terms) raw.push(...terms.split(","));
  if (file) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) raw.push(trimmed);
    }
  }
  return sanitizeKeywords(raw);
}

export function runTrackCommand(params: {
  action: "track" | "untrack";
  platform: "ios" | "android";
  keywords: string[];
  countries: string;
  appId?: string;
}): void {
  if (params.keywords.length === 0) {
    throw new Error(`\`aso ${params.action}\` needs keywords: a comma-separated argument or --file.`);
  }
  const countries = Array.from(
    new Set(
      params.countries
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
    )
  );
  const results: Array<{ country: string; added?: number; saved?: number; removed?: number }> = [];
  if (params.platform === "android") {
    const appId = resolvePlayAppId(params.appId);
    if (!appId) {
      throw new Error("Google Play tracking needs --app-id <package> or ASO_PLAY_APP_ID.");
    }
    const codes = countries.map(assertEnabledPlayCountry);
    for (const country of codes) {
      results.push(
        params.action === "track"
          ? { country, added: addPlayAppKeywords(appId, params.keywords, country) }
          : { country, removed: removePlayAppKeywords(appId, params.keywords, country) }
      );
    }
    console.log(
      JSON.stringify({ platform: "android", appId, keywordCount: params.keywords.length, results }, null, 2)
    );
    return;
  }
  const codes = countries.map((entry) => {
    const country = normalizeCountry(entry);
    assertSupportedCountry(country);
    return country;
  });
  const appId = resolveKeywordAssociationAppId(params.appId);
  for (const country of codes) {
    results.push(
      params.action === "track"
        ? { country, saved: saveKeywordsToResearchApp(params.keywords, country, appId) }
        : { country, removed: deleteAppKeywords(appId, params.keywords, country) }
    );
  }
  console.log(
    JSON.stringify({ platform: "ios", appId, keywordCount: params.keywords.length, results }, null, 2)
  );
}
