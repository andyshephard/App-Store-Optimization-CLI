import { ContextualError } from "../../utils/error-handling-helpers";
import { logger } from "../../utils/logger";
import { asoAuthService } from "../auth/aso-auth-service";
import { hasEnvAppleCredentials } from "../auth/aso-keychain-service";
import { getConfiguredAsoAdamId } from "./aso-adam-id-service";
import {
  requestPopularitiesWithKwsRetry,
  type PopularityResponse,
} from "./aso-apple-popularity-client";
import {
  reportAppleContractChange,
  withAppleHttpTraceContext,
} from "./apple-http-trace";
import {
  normalizeAppleUpstreamError,
  type NormalizedAppleUpstreamError,
} from "./apple-upstream-error";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import type { FailedKeyword } from "./aso-types";
import { ASO_ENV } from "../../shared/aso-env";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_CALL_ERROR,
} from "../../shared/aso-keyword-limits";

const AUTH_REAUTH_REQUIRED_ERROR_CODE = "ASO_AUTH_REAUTH_REQUIRED";
const NO_USER_OWNED_APPS_FOUND_CODE = "NO_USER_OWNED_APPS_FOUND_CODE";
const KWS_NO_ORG_CONTENT_PROVIDERS = "KWS_NO_ORG_CONTENT_PROVIDERS";
const APPLE_POPULARITY_URL =
  "https://app-ads.apple.com/cm/api/v2/keywords/popularities";

/**
 * Re-authenticate without a human, using Apple credentials from the environment.
 *
 * Apple's two-factor trust cookie lasts about 30 days, while the Search Ads
 * session cookies expire far sooner. Inside that window a re-login needs only
 * the Apple ID and password, no verification code — so an unattended retry is
 * worth attempting even on paths that must never block on a prompt. With no
 * prompt handler and no TTY the auth service throws rather than waiting, so the
 * worst case is the same error the caller would have seen anyway.
 *
 * Each attempt is a full Apple sign-in, and a refresh can hit an expired
 * session once per batch. Repeated sign-ins get the server's IP throttled by
 * idmsa (503 on every login, including the dashboard's), so concurrent callers
 * share one attempt and a failure blocks further unattended attempts for a
 * cooldown. A dashboard login clears it.
 */
const UNATTENDED_REAUTH_COOLDOWN_MS = 60 * 60 * 1000;
let unattendedReauthInFlight: Promise<string | null> | null = null;
let unattendedReauthFailedAt: number | null = null;

export function resetUnattendedReauthCooldown(): void {
  unattendedReauthFailedAt = null;
}

async function tryUnattendedReauth(): Promise<string | null> {
  if (!hasEnvAppleCredentials()) return null;
  if (unattendedReauthInFlight) return unattendedReauthInFlight;
  if (
    unattendedReauthFailedAt != null &&
    Date.now() - unattendedReauthFailedAt < UNATTENDED_REAUTH_COOLDOWN_MS
  ) {
    logger.debug(
      "[aso-popularity] skipping unattended reauthentication during cooldown"
    );
    return null;
  }
  unattendedReauthInFlight = (async () => {
    try {
      logger.debug("[aso-popularity] attempting unattended reauthentication");
      const cookieHeader = await asoAuthService.reAuthenticate();
      unattendedReauthFailedAt = null;
      return cookieHeader;
    } catch (error) {
      unattendedReauthFailedAt = Date.now();
      logger.debug(
        `[aso-popularity] unattended reauthentication failed: ${String(error)}`
      );
      return null;
    } finally {
      unattendedReauthInFlight = null;
    }
  })();
  return unattendedReauthInFlight;
}

type FetchKeywordPopularitiesOptions = {
  allowInteractiveAuthRecovery?: boolean;
  /**
   * Storefront to ask for. With ASO_POPULARITY_PER_STOREFRONT on (default),
   * the request names this storefront and falls back to the account-level
   * score for anything it cannot answer. Omitted: account-level only.
   */
  country?: string;
};

export type PopularitySourceMode = "storefront" | "account";

type KeywordPopularityResult = {
  popularities: Record<string, number>;
  failedKeywords: FailedKeyword[];
  /** Which request answered each keyword in `popularities`. */
  sourceByKeyword?: Record<string, PopularitySourceMode>;
};

function sourceMap(
  popularities: Record<string, number>,
  mode: PopularitySourceMode
): Record<string, PopularitySourceMode> {
  return Object.fromEntries(Object.keys(popularities).map((k) => [k, mode]));
}

/**
 * A storefront whose per-storefront request Apple rejected outright (non-auth
 * error status) is asked account-level only for a day, so every batch does
 * not pay for a doomed extra request. Logged once when it trips.
 */
const STOREFRONT_REJECTION_TTL_MS = 24 * 60 * 60 * 1000;
const storefrontPopularityRejectedAt = new Map<string, number>();

function isStorefrontPopularityRejected(country: string): boolean {
  const at = storefrontPopularityRejectedAt.get(country);
  if (at == null) return false;
  if (Date.now() - at > STOREFRONT_REJECTION_TTL_MS) {
    storefrontPopularityRejectedAt.delete(country);
    return false;
  }
  return true;
}

function markStorefrontPopularityRejected(country: string, status: number): void {
  if (!storefrontPopularityRejectedAt.has(country)) {
    logger.warn(
      `[aso-popularity] Apple rejected the per-storefront popularity request for ${country} (status ${status}); using account-level popularity for ${country} for 24h`
    );
  }
  storefrontPopularityRejectedAt.set(country, Date.now());
}

export function __resetStorefrontPopularityRejectionsForTests(): void {
  storefrontPopularityRejectedAt.clear();
}

export class AsoAuthReauthRequiredError extends ContextualError {
  readonly code = AUTH_REAUTH_REQUIRED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AsoAuthReauthRequiredError";
  }
}

export function isAsoAuthReauthRequiredError(error: unknown): boolean {
  return (
    error instanceof AsoAuthReauthRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === AUTH_REAUTH_REQUIRED_ERROR_CODE)
  );
}

/** Any common term works; only the auth outcome of the call matters. */
const SESSION_PROBE_TERM = "music";

export type SessionProbeResult = "ok" | "rejected" | "unknown";

/**
 * One cheap popularity request with the stored cookies, no reauthentication
 * and no retries.
 *
 * - "ok": Apple accepted the session.
 * - "rejected": no cookies, or Apple answered with an auth failure - a login
 *   is what fixes it.
 * - "unknown": throttled (429), 5xx, an unexpected business error, or the
 *   request failed outright. A login would not help and adds load, so the
 *   caller should simply try again next cycle.
 *
 * The session keeper used to run a full SRP login every six hours just to
 * learn whether the session was alive. A login is many requests, can trip
 * Apple's anti-abuse checks, and rotates the cookies under a running crawl.
 */
export async function probeAsoPopularitySession(): Promise<SessionProbeResult> {
  const cookieHeader = asoAuthService.getCookieHeader(APPLE_POPULARITY_URL);
  if (!cookieHeader.trim()) return "rejected";
  const adamId = getConfiguredAsoAdamId();
  if (!adamId) return "unknown";
  let response: { statusCode: number; data: PopularityResponse };
  try {
    response = await requestPopularitiesWithKwsRetry(
      [SESSION_PROBE_TERM],
      cookieHeader,
      adamId,
      { maxAttempts: 1 }
    );
  } catch {
    return "unknown";
  }
  if (isAuthFailure(response.statusCode, response.data)) return "rejected";
  if (response.statusCode >= 200 && response.statusCode < 300) return "ok";
  return "unknown";
}

function sanitizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function requireAdamId(): string {
  const adamId = getConfiguredAsoAdamId();
  if (!adamId) {
    throw new ContextualError(
      "Primary App ID is missing. Run 'aso --primary-app-id <id>' or run 'aso' to set it."
    );
  }
  return adamId;
}

function isRefreshError(statusCode: number, data: PopularityResponse): boolean {
  return statusCode === 403 && data.internalErrorCode === "REFRESH";
}

function firstMessageCode(data: PopularityResponse): string | undefined {
  return data.error?.errors?.[0]?.messageCode;
}

function firstMessage(data: PopularityResponse): string | undefined {
  return data.error?.errors?.[0]?.message;
}

function isPrimaryAppIdAccessMessageCode(messageCode: string): boolean {
  return messageCode === NO_USER_OWNED_APPS_FOUND_CODE;
}

function isPrimaryAppIdAccessError(
  statusCode: number,
  data: PopularityResponse
): boolean {
  if (statusCode !== 403) return false;
  const messageCode = firstMessageCode(data) || "";
  if (isPrimaryAppIdAccessMessageCode(messageCode)) {
    return true;
  }
  const message = (firstMessage(data) || "").toLowerCase();
  return message.includes("no user owned apps found");
}

function isKnownBusiness403(data: PopularityResponse): boolean {
  const messageCode = firstMessageCode(data) || "";
  if (
    messageCode.startsWith("KWS_") ||
    isPrimaryAppIdAccessMessageCode(messageCode)
  ) {
    return true;
  }
  const message = (firstMessage(data) || "").toLowerCase();
  return message.includes("no user owned apps found");
}

function isAuthFailure(statusCode: number, data: PopularityResponse): boolean {
  if (statusCode === 401) return true;
  if (isRefreshError(statusCode, data)) return true;
  if (statusCode !== 403) return false;
  return !isKnownBusiness403(data);
}

function logPopularityResponse(
  stage: string,
  statusCode: number,
  data: PopularityResponse
): void {
  logger.debug(
    `[aso-popularity] ${stage} response status=${statusCode} apiStatus=${
      data.status || "unknown"
    } requestID=${data.requestID || "none"} internalErrorCode=${
      data.internalErrorCode || "none"
    } messageCode=${firstMessageCode(data) || "none"} message=${
      firstMessage(data) || "none"
    } items=${data.data?.length || 0}`
  );
}

export class AsoPopularityService {
  async fetchKeywordPopularitiesWithFailures(
    keywords: string[],
    options?: FetchKeywordPopularitiesOptions
  ): Promise<KeywordPopularityResult> {
    if (keywords.length > ASO_MAX_KEYWORDS) {
      throw new ContextualError(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
    }

    const sanitizedToOriginal = new Map<string, string>();
    for (const keyword of keywords) {
      const sanitized = sanitizeKeyword(keyword);
      if (sanitized) {
        sanitizedToOriginal.set(sanitized, keyword);
      }
    }

    const sanitizedKeywords = Array.from(sanitizedToOriginal.keys());
    if (sanitizedKeywords.length === 0) {
      return {
        popularities: {},
        failedKeywords: [],
      };
    }
    const adamId = requireAdamId();
    logger.debug(
      `[aso-popularity] requesting popularities terms=${sanitizedKeywords.length} adamId=${adamId}`
    );

    const allowInteractiveAuthRecovery =
      options?.allowInteractiveAuthRecovery !== false;
    let cookieHeader = asoAuthService.getCookieHeader(APPLE_POPULARITY_URL);
    if (!cookieHeader.trim()) {
      if (!allowInteractiveAuthRecovery) {
        const recovered = await tryUnattendedReauth();
        if (!recovered) {
          throw new AsoAuthReauthRequiredError(
            "Apple Search Ads session expired. Reauthentication is required."
          );
        }
        cookieHeader = recovered;
      } else {
        logger.debug(
          "[aso-popularity] no cached cookie header, reauthenticating"
        );
        cookieHeader = await asoAuthService.reAuthenticate();
      }
    }
    let activeStorefronts: string[] = [];
    const requestWithAuthRecovery = async (
      terms: string[],
      stageLabel: string,
      baseOptions?: { maxAttempts?: number }
    ): Promise<{
      statusCode: number;
      data: PopularityResponse;
      attempts: number;
    }> => {
      const options = { ...baseOptions, storefronts: activeStorefronts };
      logger.debug(
        `[aso-popularity] sending ${stageLabel} request cookieHeaderLength=${cookieHeader.length} terms=${terms.length}`
      );
      let response = await requestPopularitiesWithKwsRetry(
        terms,
        cookieHeader,
        adamId,
        options
      );
      logPopularityResponse(stageLabel, response.statusCode, response.data);

      if (isAuthFailure(response.statusCode, response.data)) {
        if (!allowInteractiveAuthRecovery) {
          const recovered = await tryUnattendedReauth();
          if (!recovered) {
            throw new AsoAuthReauthRequiredError(
              "Apple Search Ads session expired. Reauthentication is required."
            );
          }
          cookieHeader = recovered;
          const retried = await requestPopularitiesWithKwsRetry(
            terms,
            cookieHeader,
            adamId,
            options
          );
          logPopularityResponse(
            `${stageLabel}-post-unattended-reauth`,
            retried.statusCode,
            retried.data
          );
          // A retry that still fails auth means the credentials or the trust
          // cookie are gone, not that these keywords are bad. Returning the
          // response here would turn it into ordinary per-keyword failures and
          // leave `requiresReauthentication` false, so nothing would ever tell
          // the operator to log in - the crawl would just quietly stop updating.
          if (isAuthFailure(retried.statusCode, retried.data)) {
            throw new AsoAuthReauthRequiredError(
              "Apple Search Ads session expired and unattended reauthentication did not restore it."
            );
          }
          return retried;
        }
        logger.debug(
          `[aso-popularity] ${stageLabel} auth failure detected, reauthenticating before retry`
        );
        cookieHeader = await asoAuthService.reAuthenticate();
        response = await requestPopularitiesWithKwsRetry(
          terms,
          cookieHeader,
          adamId,
          options
        );
        logPopularityResponse(
          `${stageLabel}-post-reauth`,
          response.statusCode,
          response.data
        );
      }

      return response;
    };

    const toFailedKeyword = (
      keyword: string,
      normalized: NormalizedAppleUpstreamError
    ): FailedKeyword => ({
      keyword,
      stage: "popularity",
      reasonCode: normalized.reasonCode,
      message: normalized.message,
      statusCode: normalized.statusCode,
      retryable: normalized.retryable,
      attempts: normalized.attempts,
      requestId: normalized.requestId,
    });

    const parseSuccessPopularities = (response: {
      statusCode: number;
      data: PopularityResponse;
    }): Record<string, number> => {
      const result: Record<string, number> = {};
      if (!Array.isArray(response.data.data)) {
        reportAppleContractChange({
          provider: "apple-search-ads",
          operation: "keywords-popularities-response",
          endpoint: APPLE_POPULARITY_URL,
          statusCode: response.statusCode,
          requestId: response.data.requestID,
          expectedContract:
            "Successful popularity response includes data[] entries with { name, popularity }",
          actualSignal: `status=${String(response.data.status || "unknown")} dataType=${typeof response.data.data}`,
          context: {
            termsCount: sanitizedKeywords.length,
            hasErrorArray: Array.isArray(response.data.error?.errors),
          },
          isTerminal: false,
          dedupeKey: "keywords-popularities-response-data-array",
        });
        return result;
      }

      let invalidItemCount = 0;
      for (const item of response.data.data || []) {
        if (!item || typeof item.name !== "string") {
          invalidItemCount += 1;
          continue;
        }
        if (item.popularity === null) continue;
        const originalKeyword = sanitizedToOriginal.get(item.name);
        if (originalKeyword) {
          result[originalKeyword] = item.popularity;
        }
      }
      if (invalidItemCount > 0) {
        reportAppleContractChange({
          provider: "apple-search-ads",
          operation: "keywords-popularities-response",
          endpoint: APPLE_POPULARITY_URL,
          statusCode: response.statusCode,
          requestId: response.data.requestID,
          expectedContract:
            "Popularity data[] items include a string name and numeric popularity|null",
          actualSignal: `invalid_items=${invalidItemCount}`,
          context: {
            termsCount: sanitizedKeywords.length,
            returnedItems: response.data.data.length,
          },
          isTerminal: false,
          dedupeKey: "keywords-popularities-response-invalid-items",
        });
      }
      return result;
    };

    const toFailureFromResponse = (
      keyword: string,
      response: {
        statusCode: number;
        data: PopularityResponse;
        attempts: number;
      }
    ): FailedKeyword => {
      const messageCode = firstMessageCode(response.data);
      const message = firstMessage(response.data);
      logger.debug(
        `[aso-popularity] final failure status=${response.statusCode} requestID=${
          response.data.requestID || "none"
        } messageCode=${messageCode || "none"}`
      );
      const normalized = normalizeAppleUpstreamError({
        error: Object.assign(
          new Error(
            message ||
              `Popularity API request failed with status ${response.statusCode}`
          ),
          {
            statusCode: response.statusCode,
            code: messageCode || response.data.internalErrorCode,
          }
        ),
        operation: "keywords-popularities-response",
        attempts: response.attempts,
        requestId: response.data.requestID,
      });
      return toFailedKeyword(keyword, normalized);
    };

    const toFailureFromError = (
      keyword: string,
      error: unknown
    ): FailedKeyword => {
      const normalized = normalizeAppleUpstreamError({
        error,
        operation: "keywords-popularities-request",
        attempts: getAsoResilienceConfig().maxAttempts,
      });
      return toFailedKeyword(keyword, normalized);
    };

    const fetchTerms = async (
      terms: string[],
      modeLabel: string,
      isolate: boolean
    ): Promise<KeywordPopularityResult & { rejectedStatus?: number }> => {
      let response = await requestWithAuthRecovery(terms, `${modeLabel}:initial`);

      if (response.statusCode !== 200 || response.data.status !== "success") {
      if (!isolate) {
        // Per-storefront attempt: no keyword-by-keyword isolation. The
        // account-level fallback re-asks for every term in one request.
        return {
          popularities: {},
          failedKeywords: terms.map((term) =>
            toFailureFromResponse(sanitizedToOriginal.get(term) ?? term, response)
          ),
          rejectedStatus: response.statusCode,
        };
      }
      const messageCode = firstMessageCode(response.data);
      const message = firstMessage(response.data);
      if (isPrimaryAppIdAccessError(response.statusCode, response.data)) {
        throw withAppleHttpTraceContext(
          new ContextualError(
            `Primary App ID ${adamId} is not accessible for this Apple Ads account. Set a Primary App ID you can access with 'aso --primary-app-id <id>' and retry.${
              messageCode ? ` (messageCode=${messageCode})` : ""
            }`
          ),
          {
            provider: "apple-search-ads",
            operation: "keywords-popularities-response",
            context: {
              adamId,
              termsCount: terms.length,
              statusCode: response.statusCode,
              requestID: response.data.requestID || null,
              messageCode: messageCode || null,
            },
            isTerminal: true,
          }
        );
      }
      if (
        response.statusCode === 403 &&
        messageCode === KWS_NO_ORG_CONTENT_PROVIDERS
      ) {
        logger.debug(
          `[aso-popularity] KWS_NO_ORG_CONTENT_PROVIDERS requestID=${
            response.data.requestID || "none"
          }; attempting keyword-level isolation`
        );
      }
      if (terms.length === 1) {
        const keyword =
          sanitizedToOriginal.get(terms[0]) ?? terms[0];
        return {
          popularities: {},
          failedKeywords: [toFailureFromResponse(keyword, response)],
        };
      }

      const popularities: Record<string, number> = {};
      const failedKeywords: FailedKeyword[] = [];
      for (const term of terms) {
        const keyword = sanitizedToOriginal.get(term) ?? term;
        try {
          const singleResponse = await requestWithAuthRecovery(
            [term],
            `${modeLabel}:isolation:${term}`,
            { maxAttempts: 1 }
          );
          if (
            singleResponse.statusCode === 200 &&
            singleResponse.data.status === "success"
          ) {
            popularities[keyword] =
              parseSuccessPopularities(singleResponse)[keyword] ?? 1;
          } else {
            failedKeywords.push(toFailureFromResponse(keyword, singleResponse));
          }
        } catch (error) {
          failedKeywords.push(toFailureFromError(keyword, error));
        }
      }
      return {
        popularities,
        failedKeywords,
      };
    }

      return {
        popularities: parseSuccessPopularities(response),
        failedKeywords: [],
      };
    };

    const country = options?.country?.trim().toUpperCase() || null;
    const perStorefront =
      ASO_ENV.popularityPerStorefront &&
      country != null &&
      !isStorefrontPopularityRejected(country);
    if (!perStorefront) {
      const result = await fetchTerms(sanitizedKeywords, "account", true);
      logger.info(
        `[aso-popularity] mode=account country=${country ?? "none"} answered=${Object.keys(result.popularities).length}/${sanitizedKeywords.length} failed=${result.failedKeywords.length}`
      );
      return { ...result, sourceByKeyword: sourceMap(result.popularities, "account") };
    }

    activeStorefronts = [country];
    const storefrontResult = await fetchTerms(
      sanitizedKeywords,
      `storefront:${country}`,
      false
    );
    activeStorefronts = [];
    // Only a malformed-request answer means "this endpoint will not take a
    // storefront"; throttling and 5xx are transient and must not switch it off.
    if (
      storefrontResult.rejectedStatus === 400 ||
      storefrontResult.rejectedStatus === 404 ||
      storefrontResult.rejectedStatus === 422
    ) {
      markStorefrontPopularityRejected(country, storefrontResult.rejectedStatus);
    }
    const popularities: Record<string, number> = {
      ...storefrontResult.popularities,
    };
    const sourceByKeyword = sourceMap(popularities, "storefront");
    // Terms the storefront could not answer - rejected, missing or no data -
    // fall back to the account-level score in one more request.
    const remaining = sanitizedKeywords.filter(
      (term) => popularities[sanitizedToOriginal.get(term) ?? term] == null
    );
    let failedKeywords: FailedKeyword[] = [];
    let fallbackAnswered = 0;
    if (remaining.length > 0) {
      const fallback = await fetchTerms(remaining, "account-fallback", true);
      for (const [keyword, value] of Object.entries(fallback.popularities)) {
        popularities[keyword] = value;
        sourceByKeyword[keyword] = "account";
        fallbackAnswered += 1;
      }
      failedKeywords = fallback.failedKeywords;
    }
    const fallbackReason =
      storefrontResult.rejectedStatus != null
        ? `rejected(${storefrontResult.rejectedStatus})`
        : remaining.length > 0
          ? "no-data"
          : "none";
    logger.info(
      `[aso-popularity] mode=storefront country=${country} storefront=${sanitizedKeywords.length - remaining.length} account-fallback=${fallbackAnswered} fallbackReason=${fallbackReason} failed=${failedKeywords.length} of ${sanitizedKeywords.length}`
    );
    return { popularities, failedKeywords, sourceByKeyword };
  }

  async fetchKeywordPopularities(
    keywords: string[],
    options?: FetchKeywordPopularitiesOptions
  ): Promise<Record<string, number>> {
    const result = await this.fetchKeywordPopularitiesWithFailures(
      keywords,
      options
    );
    if (result.failedKeywords.length > 0) {
      const first = result.failedKeywords[0];
      throw new ContextualError(first.message);
    }
    return result.popularities;
  }
}

export function summarizeFailedPopularityKeywords(
  failures: FailedKeyword[]
): string | null {
  if (failures.length === 0) return null;
  const preview = failures
    .slice(0, 5)
    .map(
      (failure) =>
        `${failure.keyword}:${failure.reasonCode}${
          failure.statusCode != null ? `(${failure.statusCode})` : ""
        }`
    )
    .join(", ");
  const suffix = failures.length > 5 ? ` (+${failures.length - 5} more)` : "";
  return `${preview}${suffix}`;
}

export const asoPopularityService = new AsoPopularityService();
