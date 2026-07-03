import type { CommandModule } from "yargs";
import { keywordPipelineService } from "../services/keywords/keyword-pipeline-service";
import { startDashboard } from "../dashboard-server";
import { asoKeychainService } from "../services/auth/aso-keychain-service";
import { asoCookieStoreService } from "../services/auth/aso-cookie-store-service";
import { resolveAsoAdamId } from "../services/keywords/aso-adam-id-service";
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
    "Open ASO dashboard (default), fetch ASO keyword metrics (`aso keywords`), reauthenticate (`aso auth`), or reset saved ASO auth state (`aso reset-credentials`). `aso keywords` supports optional popularity/difficulty filters and keyword association controls (default target app: research).",
  builder: (yargs) =>
    yargs
      .positional("subcommand", {
        type: "string",
        choices: ["keywords", "auth", "reset-credentials"],
        describe: "ASO subcommand",
      })
      .positional("terms", {
        type: "string",
        describe:
          'Comma-separated keywords for `keywords`, e.g. aso keywords "x,y,z"',
      })
      .option("country", {
        type: "string",
        default: DEFAULT_ASO_COUNTRY,
        describe: "Storefront country code (currently US only)",
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

    const country = normalizeCountry(argv.country as string);
    assertSupportedCountry(country);

    if (!subcommand) {
      if (
        stdout ||
        argv.terms != null ||
        argv["min-popularity"] != null ||
        argv["max-difficulty"] != null ||
        argv["app-id"] != null ||
        isExcludeExistingEnabled(argv as Record<string, unknown>) ||
        argv.associate != null
      ) {
        throw new Error(
          "Keyword options are only supported in `aso keywords`."
        );
      }
      if (primaryAppId != null) {
        await resolveAsoAdamId({ adamId: primaryAppId, allowPrompt: false });
      }
      await startDashboard(true);
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
