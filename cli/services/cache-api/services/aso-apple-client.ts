import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { ContextualError } from "../../../utils/error-handling-helpers";
import { logger } from "../../../utils/logger";
import { getAsoResilienceConfig } from "../../../shared/aso-resilience";
import { getRetryDelayMs } from "../../../shared/aso-retry-delay";
import {
  isRetryableTransientStatusCode,
  isTransientTransportFailure,
} from "../../../shared/aso-transient-error";
import { attachAppleHttpTracing } from "../../keywords/apple-http-trace";
import {
  afterAppleResponse,
  beforeAppleRequest,
} from "../../../shared/apple-rate-limiter";

const SENSITIVE_HEADER_KEYS = ["authorization", "cookie", "set-cookie", "x-api-key"];
const asoAppleHttpClient = axios.create();
attachAppleHttpTracing(asoAppleHttpClient, "apple-appstore");

type AsoAppleGetConfig<T = unknown> = AxiosRequestConfig<T> & {
  operation: string;
  maxAttempts?: number;
  delayMs?: number;
  /**
   * Extra statuses this endpoint uses to mean "slow down". 429 always counts;
   * the app-detail endpoint answers 403 instead.
   */
  throttleStatusCodes?: number[];
};

/**
 * Host-wide pause after Apple throttles a request.
 *
 * Retry-After used to slow down only the request that received it, while every
 * other worker kept firing at the same host and collected its own 429 — one
 * burst on 2026-09-25 produced ~1,000 of them. Now a throttle response closes
 * the gate for the whole host until the backoff has passed, and every request
 * to that host waits at the gate before going out.
 */
const throttledUntilByHost = new Map<string, number>();

function getRequestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function waitForThrottleGate(host: string): Promise<void> {
  // Loop: another request may extend the gate while this one sleeps.
  while (true) {
    const waitMs = (throttledUntilByHost.get(host) ?? 0) - Date.now();
    if (waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function extendThrottleGate(host: string, delayMs: number): void {
  const until = Date.now() + delayMs;
  if (until > (throttledUntilByHost.get(host) ?? 0)) {
    throttledUntilByHost.set(host, until);
  }
}

export function resetAppleThrottleGateForTests(): void {
  throttledUntilByHost.clear();
}

function generateRequestId(): string {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

function sanitizeHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
    if (SENSITIVE_HEADER_KEYS.some((sensitiveKey) => key.includes(sensitiveKey))) {
      sanitized[rawKey] = "[REDACTED]";
      continue;
    }
    sanitized[rawKey] = value;
  }
  return sanitized;
}

function shouldRetry(error: AxiosError): boolean {
  if (isRetryableTransientStatusCode(error.response?.status)) {
    return true;
  }
  return isTransientTransportFailure({
    code: error.code,
    message: error.message,
  });
}

function computeRetryDelayMs(
  error: AxiosError,
  attempt: number,
  delayMs: number,
  throttled: boolean
): number {
  return getRetryDelayMs({
    // A 403 throttle carries no Retry-After; treating it as 429 gives it the
    // rate-limit backoff rather than the short transient one.
    statusCode: throttled ? 429 : error.response?.status,
    headers: error.response?.headers as Record<string, unknown> | undefined,
    attempt,
    defaultBaseDelayMs: delayMs,
    rateLimitBaseDelayMs: getAsoResilienceConfig().rateLimitBaseDelayMs,
  });
}

export async function asoAppleGet<T = unknown>(
  url: string,
  config: AsoAppleGetConfig<T>
): Promise<AxiosResponse<T>> {
  const {
    operation,
    maxAttempts = getAsoResilienceConfig().maxAttempts,
    delayMs = getAsoResilienceConfig().baseDelayMs,
    throttleStatusCodes = [],
    ...requestConfig
  } = config;
  const requestId = generateRequestId();
  const startedAt = Date.now();
  const host = getRequestHost(url);
  // Search terms are in params, not the URL; name them on errors so a term
  // Apple fails on can be told apart from throttling.
  const term = (requestConfig.params as { term?: unknown } | undefined)?.term;
  const termLabel = typeof term === "string" ? ` term=${JSON.stringify(term)}` : "";

  logger.debug(`[${requestId}] ASO APPLE REQ GET ${operation}`, {
    requestId,
    operation,
    method: "GET",
    url,
    params: requestConfig.params,
    headers: sanitizeHeaders(requestConfig.headers as Record<string, unknown> | undefined),
    timeout: requestConfig.timeout,
    maxAttempts,
    timestamp: new Date().toISOString(),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForThrottleGate(host);
    // Every attempt, retries included, takes a slot from the host's limiter.
    const hostClass = await beforeAppleRequest(url);
    // The slot may have been a long wait; a throttle elsewhere in the
    // meantime closes the gate, and this request must respect it too.
    await waitForThrottleGate(host);
    try {
      const response = await asoAppleHttpClient.get<T>(url, requestConfig);
      afterAppleResponse(hostClass, response.status);
      logger.debug(`[${requestId}] ASO APPLE RES GET ${operation}`, {
        requestId,
        operation,
        method: "GET",
        url,
        status: response.status,
        statusText: response.statusText,
        attempt,
        durationMs: Date.now() - startedAt,
        responseHeaders: sanitizeHeaders(
          response.headers as Record<string, unknown> | undefined
        ),
        timestamp: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      afterAppleResponse(hostClass, status);
      const throttled =
        status === 429 || (status != null && throttleStatusCodes.includes(status));
      const retryable = throttled || shouldRetry(axiosError);
      const waitedMs = computeRetryDelayMs(axiosError, attempt, delayMs, throttled);

      // Close the gate even when this request is giving up, so the requests
      // behind it back off too.
      if (throttled) {
        extendThrottleGate(host, waitedMs);
      }

      if (!retryable || attempt >= maxAttempts) {
        // One line per failure. Response headers go to debug only: at info
        // they made every error ~35 lines, which was 51k lines in 48h.
        logger.error(
          `[${requestId}] ASO APPLE ERR GET ${operation} status=${status ?? axiosError.code ?? "?"} attempt=${attempt}/${maxAttempts} ${url}${termLabel}`
        );
        logger.debug(`[${requestId}] ASO APPLE ERR DETAIL GET ${operation}`, {
          requestId,
          operation,
          method: "GET",
          url,
          attempt,
          maxAttempts,
          retryable,
          throttled,
          durationMs: Date.now() - startedAt,
          status,
          statusText: axiosError.response?.statusText,
          code: axiosError.code,
          message: axiosError.message,
          responseHeaders: sanitizeHeaders(
            axiosError.response?.headers as Record<string, unknown> | undefined
          ),
          timestamp: new Date().toISOString(),
        });
        throw error;
      }

      // A throttled request waits at the gate at the top of the loop;
      // anything else sleeps its own backoff.
      if (!throttled) {
        await new Promise((resolve) => setTimeout(resolve, waitedMs));
      }

      logger.debug(`[${requestId}] ASO APPLE RETRY GET ${operation}`, {
        requestId,
        operation,
        method: "GET",
        url,
        attempt,
        nextAttempt: attempt + 1,
        retryCause: throttled
          ? "rate_limit"
          : axiosError.response?.status != null
              ? "upstream_5xx"
              : "network",
        waitedMs: Math.round(waitedMs),
        status: axiosError.response?.status,
        code: axiosError.code,
        message: axiosError.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  throw new ContextualError("ASO apple request loop exhausted unexpectedly", {
    operation,
    url,
    maxAttempts,
  });
}
