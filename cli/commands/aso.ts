import type { CommandModule } from "yargs";
import { keywordPipelineService } from "../services/keywords/keyword-pipeline-service";
import { startDashboard } from "../dashboard-server";
import { ASO_ENV } from "../shared/aso-env";
import { asoKeychainService } from "../services/auth/aso-keychain-service";
import { asoCookieStoreService } from "../services/auth/aso-cookie-store-service";
import { resolveAsoAdamId } from "../services/keywords/aso-adam-id-service";
import { buildKeywordSuggestions } from "../services/apple-ads-api/suggest-service";
import { asoAuthService } from "../services/auth/aso-auth-service";
import {
  resolveKeywordAssociationAppId,
  saveKeywordsToResearchApp,
} from "../services/keywords/aso-research-keyword-service";
import { logger } from "../utils/logger";
import { listByApp } from "../db/app-keywords";
import type {
  FilteredKeyword,
  KeywordFetchResult,
} from "../services/keywords/aso-types";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_CALL_ERROR,
} from "../shared/aso-keyword-limits";
import {
  DEFAULT_ASO_COUNTRY,
  assertSupportedCountry,
  normalizeKeyword,
  normalizeCountry,
} from "../domain/keywords/policy";
import {
  collectKeywords,
  runPlayKeywordsCommand,
  runTrackCommand,
} from "./play-commands";

const AUTH_REAUTH_REQUIRED_ERROR_CODE = "ASO_AUTH_REAUTH_REQUIRED";
const STDOUT_INTERACTIVE_AUTH_REQUIRED_MESSAGE =
  "This run needs interactive Apple Search Ads reauthentication. Run 'aso auth' in a terminal, then retry this command with --stdout.";

function isAuthReauthRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === AUTH_REAUTH_REQUIRED_ERROR_CODE
  );
}

function parseOptionalThreshold(
  value: unknown,
  optionName: string
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${optionName} must be a finite number.`);
  }
  return value;
}

function hasActiveFilters(filters: {
  minPopularity?: number;
  maxDifficulty?: number;
}): boolean {
  return filters.minPopularity != null || filters.maxDifficulty != null;
}

function persistKeywordsToApp(
  keywords: string[],
  country: string,
  appId: string | undefined,
  options?: { log?: boolean }
): void {
  const savedCount = saveKeywordsToResearchApp(keywords, country, appId);
  if (options?.log === false) {
    return;
  }
  logger.debug(
    `[aso-keywords] persisted keywords to app`,
    {
      savedCount,
      country,
      appId: appId?.trim() || "research",
    }
  );
}

async function fetchKeywordsForStdout(
  country: string,
  keywords: string[],
  filters: { minPopularity?: number; maxDifficulty?: number }
): Promise<KeywordFetchResult> {
  try {
    return await keywordPipelineService.run(country, keywords, {
      allowInteractiveAuthRecovery: false,
      filters,
    });
  } catch (error) {
    if (!isAuthReauthRequiredError(error)) {
      throw error;
    }
  }

  await asoAuthService.reAuthenticate({
    onUserActionRequired: () => {
      throw new Error(STDOUT_INTERACTIVE_AUTH_REQUIRED_MESSAGE);
    },
  });

  return keywordPipelineService.run(country, keywords, {
    allowInteractiveAuthRecovery: false,
    filters,
  });
}

function isExcludeExistingEnabled(argv: Record<string, unknown>): boolean {
  return Boolean(
    argv["exclude-existing"] ||
      argv.excludeExisting ||
      argv["exclude-associated"] ||
      argv.excludeAssociated
  );
}

function buildExistingKeywordFilter(
  country: string,
  keywords: string[],
  appId: string | undefined,
  excludeExisting: boolean
): {
  targetAppId: string | undefined;
  keywordsToEvaluate: string[];
  filteredOut: FilteredKeyword[];
} {
  if (!excludeExisting) {
    return {
      targetAppId: appId,
      keywordsToEvaluate: keywords,
      filteredOut: [],
    };
  }

  const targetAppId = resolveKeywordAssociationAppId(appId);
  const associatedKeywords = new Set(
    listByApp(targetAppId, country)
      .map((row) => normalizeKeyword(row.keyword))
      .filter(Boolean)
  );
  const keywordsToEvaluate: string[] = [];
  const filteredOut: FilteredKeyword[] = [];

  for (const keyword of keywords) {
    const normalized = normalizeKeyword(keyword);
    if (associatedKeywords.has(normalized)) {
      filteredOut.push({
        keyword: normalized,
        reason: "already_associated",
      });
      continue;
    }
    keywordsToEvaluate.push(keyword);
  }

  return {
    targetAppId,
    keywordsToEvaluate,
    filteredOut,
  };
}

async function runKeywordFetch(
  stdout: boolean,
  country: string,
  keywords: string[],
  filters: { minPopularity?: number; maxDifficulty?: number }
): Promise<KeywordFetchResult> {
  if (keywords.length === 0) {
    return {
      items: [],
      failedKeywords: [],
      filteredOut: [],
    };
  }

  return stdout
    ? fetchKeywordsForStdout(country, keywords, filters)
    : keywordPipelineService.run(country, keywords, { filters });
}

const asoCommand: CommandModule = {
  command: "$0 [subcommand] [terms]",
  describe:
    "Open ASO dashboard (default), fetch ASO keyword metrics (`aso keywords`), discover keyword opportunities (`aso suggest`), track or untrack keywords without fetching (`aso track`, `aso untrack`), reauthenticate (`aso auth`), or reset saved ASO auth state (`aso reset-credentials`). `aso keywords` supports optional popularity/difficulty filters and keyword association controls (default target app: research). `--platform android` uses Google Play.",
  builder: (yargs) =>
    yargs
      .positional("subcommand", {
        type: "string",
        choices: ["keywords", "suggest", "track", "untrack", "auth", "reset-credentials"],
        describe: "ASO subcommand",
      })
      .positional("terms", {
        type: "string",
        describe:
          'Comma-separated keywords for `keywords`, or seed terms describing the app niche for `suggest`, e.g. aso suggest "microlearning, daily learning"',
      })
      .option("platform", {
        type: "string",
        choices: ["ios", "android"],
        default: "ios",
        describe:
          "Store for `keywords`, `track` and `untrack`: ios (App Store) or android (Google Play; countries from ASO_PLAY_COUNTRIES, app from --app-id or ASO_PLAY_APP_ID).",
      })
      .option("file", {
        type: "string",
        demandOption: false,
        describe:
          "For `track`/`untrack`: a file of keywords, one per line (# starts a comment).",
      })
      .option("genre", {
        type: "string",
        demandOption: false,
        describe:
          "For `suggest`: App Store genre chart to mine for metadata candidates, e.g. EDUCATION. Omit to fetch only Search Ads bid targets.",
      })
      .option("limit", {
        type: "number",
        default: 25,
        describe: "For `suggest`: maximum results per list.",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "For `suggest`: emit JSON instead of formatted text.",
      })
      .option("country", {
        type: "string",
        default: DEFAULT_ASO_COUNTRY,
        describe:
          "Storefront country code. Must be enabled via ASO_SUPPORTED_COUNTRIES (defaults to US alone); with --platform android, via ASO_PLAY_COUNTRIES. `track`/`untrack` take a comma-separated list.",
      })
      .option("stdout", {
        type: "boolean",
        default: false,
        describe:
          "Machine-friendly mode for `aso keywords`: emit JSON-only stdout and disable interactive prompts.",
      })
      .option("primary-app-id", {
        type: "string",
        demandOption: false,
        describe:
          "Primary App ID for popularity requests; saved locally and reused for future ASO runs",
      })
      .option("min-popularity", {
        type: "number",
        demandOption: false,
        describe:
          "Optional minimum popularity threshold. Keywords below this threshold are filtered out before enrichment.",
      })
      .option("max-difficulty", {
        type: "number",
        demandOption: false,
        describe:
          "Optional maximum difficulty threshold. Keywords above this threshold are filtered out after difficulty is available.",
      })
      .option("app-id", {
        type: "string",
        demandOption: false,
        describe:
          "Optional local app id for keyword association. Defaults to the research app when omitted.",
      })
      .option("exclude-existing", {
        alias: "exclude-associated",
        type: "boolean",
        default: false,
        demandOption: false,
        describe:
          "Skip keywords already associated with the target app/country and report them in filteredOut.",
      })
      .option("associate", {
        type: "boolean",
        demandOption: false,
        describe:
          "Associate fetched keywords with the target app. Use --no-associate to skip association writes.",
      }),
  handler: async (argv) => {
    const subcommand = argv.subcommand as string | undefined;
    const stdout = (argv.stdout as boolean) ?? false;
    const primaryAppId = argv["primary-app-id"] as string | undefined;

    if (subcommand === "reset-credentials") {
      asoKeychainService.clearCredentials();
      asoCookieStoreService.clearCookies();
      logger.info("Reset ASO credentials/cookies.");
      return;
    }

    if (subcommand === "auth") {
      await asoAuthService.reAuthenticate();
      return;
    }

    const platform = (argv.platform as "ios" | "android" | undefined) ?? "ios";
    if (subcommand === "track" || subcommand === "untrack") {
      runTrackCommand({
        action: subcommand,
        platform,
        keywords: collectKeywords(
          argv.terms as string | undefined,
          argv.file as string | undefined
        ),
        countries: (argv.country as string | undefined) ?? DEFAULT_ASO_COUNTRY,
        appId: argv["app-id"] as string | undefined,
      });
      return;
    }
    if (platform === "android") {
      if (subcommand !== "keywords") {
        throw new Error(
          "--platform android is supported by `aso keywords`, `aso track` and `aso untrack`."
        );
      }
      const playKeywords = keywordPipelineService.parseKeywords(
        argv.terms as string | undefined
      );
      if (playKeywords.length === 0) {
        throw new Error(
          "`aso keywords` requires a comma-separated keyword argument."
        );
      }
      if (playKeywords.length > ASO_MAX_KEYWORDS) {
        throw new Error(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
      }
      await runPlayKeywordsCommand({
        keywords: playKeywords,
        country: (argv.country as string | undefined) ?? DEFAULT_ASO_COUNTRY,
        appId: argv["app-id"] as string | undefined,
        associate: (argv.associate as boolean | undefined) !== false,
        stdout,
      });
      return;
    }

    const country = normalizeCountry(argv.country as string);
    assertSupportedCountry(country);

    if (!subcommand) {
      if (
        stdout ||
        argv.terms != null ||
        argv["min-popularity"] != null ||
        argv["max-difficulty"] != null ||
        argv["app-id"] != null ||
        argv.genre != null ||
        (argv.json as boolean) ||
        isExcludeExistingEnabled(argv as Record<string, unknown>) ||
        argv.associate != null
      ) {
        throw new Error(
          "Keyword options are only supported in `aso keywords` or `aso suggest`."
        );
      }
      if (primaryAppId != null) {
        await resolveAsoAdamId({ adamId: primaryAppId, allowPrompt: false });
      }
      await startDashboard(ASO_ENV.openBrowser);
      return;
    }

    if (subcommand === "suggest") {
      const adamId = await resolveAsoAdamId({
        adamId: (argv["app-id"] as string | undefined) ?? primaryAppId,
        allowPrompt: false,
      });
      const seeds = ((argv.terms as string | undefined) ?? "")
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean);
      const result = await buildKeywordSuggestions({
        appId: adamId,
        country,
        genre: argv.genre as string | undefined,
        seeds,
        limit: argv.limit as number,
      });
      if (argv.json as boolean) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const trackedMark = (alreadyTracked: boolean) =>
        alreadyTracked ? "  (tracked)" : "";
      console.log(
        `\nSearch Ads bid targets for ${result.country} (Apple's suggestions; mostly competitor brands — bid on these, don't put them in metadata):`
      );
      for (const target of result.adsTargets) {
        console.log(
          `  ${String(target.popularity).padStart(3)}  ${target.keyword}${trackedMark(target.alreadyTracked)}`
        );
      }
      if (argv.genre != null) {
        console.log(
          `\nMetadata candidates from the ${argv.genre} chart in ${result.country} (generic demand; score difficulty with \`aso keywords\` before committing):`
        );
        for (const candidate of result.metadataCandidates) {
          console.log(
            `  ${String(candidate.popularity).padStart(3)}  #${candidate.rankInGenre}  ${candidate.keyword}${trackedMark(candidate.alreadyTracked)}`
          );
        }
      } else {
        console.log(
          "\nPass --genre (e.g. --genre EDUCATION) to also mine the genre chart for metadata candidates."
        );
      }
      return;
    }

    if (subcommand !== "keywords") {
      throw new Error(`Unsupported ASO subcommand: ${subcommand}`);
    }

    const targetAppId = argv["app-id"] as string | undefined;
    const excludeExisting = isExcludeExistingEnabled(
      argv as Record<string, unknown>
    );
    const filters = {
      minPopularity: parseOptionalThreshold(
        argv["min-popularity"],
        "--min-popularity"
      ),
      maxDifficulty: parseOptionalThreshold(
        argv["max-difficulty"],
        "--max-difficulty"
      ),
    };
    const filtersActive = hasActiveFilters(filters);
    const shouldAssociate = (argv.associate as boolean | undefined) !== false;

    const keywords = keywordPipelineService.parseKeywords(
      argv.terms as string | undefined
    );
    if (keywords.length === 0) {
      throw new Error(
        "`aso keywords` requires a comma-separated keyword argument."
      );
    }
    if (keywords.length > ASO_MAX_KEYWORDS) {
      throw new Error(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
    }

    const existingKeywordFilter = buildExistingKeywordFilter(
      country,
      keywords,
      targetAppId,
      excludeExisting
    );
    if (
      existingKeywordFilter.keywordsToEvaluate.length > 0 ||
      primaryAppId != null
    ) {
      await resolveAsoAdamId({ adamId: primaryAppId, allowPrompt: !stdout });
    }

    const fetchedResult = await runKeywordFetch(
      stdout,
      country,
      existingKeywordFilter.keywordsToEvaluate,
      filters
    );
    const result = {
      ...fetchedResult,
      filteredOut: [
        ...existingKeywordFilter.filteredOut,
        ...fetchedResult.filteredOut,
      ],
    };
    if (shouldAssociate) {
      const keywordsToPersist = filtersActive || excludeExisting
        ? result.items.map((item) => item.keyword)
        : keywords;
      if (keywordsToPersist.length > 0) {
        persistKeywordsToApp(
          keywordsToPersist,
          country,
          existingKeywordFilter.targetAppId,
          {
            log: !stdout,
          }
        );
      }
    }
    console.log(JSON.stringify(result, null, 2));
  },
};

export default asoCommand;
