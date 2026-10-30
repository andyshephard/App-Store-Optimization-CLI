import axios, { AxiosError, AxiosResponse } from "axios";
import { logger } from "../../utils/logger";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import { getRetryDelayMs } from "../../shared/aso-retry-delay";
import {
  isRetryableTransientStatusCode,
  isTransientTransportFailure,
} from "../../shared/aso-transient-error";
import {
  afterAppleResponse,
  beforeAppleRequest,
} from "../../shared/apple-rate-limiter";

/**
 * The one HTTP path to play.google.com. Every attempt takes a slot from the
 * shared per-host limiter (host classes `playsearch` / `playsuggest`, AIMD on
 * 429/503), so Play traffic is paced, counted in `lastRun.requests.byHost`
 * and shown in health `rateLimits` exactly like Apple's.
 */

/** A desktop Chrome UA: the search page serves its data blocks to browsers. */
export const PLAY_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;

const playHttpClient = axios.create();

export type PlayRequest = {
  method: "GET" | "POST";
  url: string;
  operation: string;
  params?: Record<string, string>;
  data?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
};

function shouldRetry(error: AxiosError): boolean {
  if (isRetryableTransientStatusCode(error.response?.status)) return true;
  return isTransientTransportFailure({ code: error.code, message: error.message });
}

export async function playRequest(request: PlayRequest): Promise<AxiosResponse<string>> {
  const resilience = getAsoResilienceConfig();
  const maxAttempts = Math.max(1, request.maxAttempts ?? resilience.maxAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const hostClass = await beforeAppleRequest(request.url);
    try {
      const response = await playHttpClient.request<string>({
        method: request.method,
        url: request.url,
        params: request.params,
        data: request.data,
        headers: request.headers,
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        responseType: "text",
        // Keep the body a string; axios would otherwise try JSON.parse.
        transformResponse: [(body) => body],
      });
      afterAppleResponse(hostClass, response.status);
      return response;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      afterAppleResponse(hostClass, status);
      if (!shouldRetry(axiosError) || attempt >= maxAttempts) {
        logger.error(
          `[play] ERR ${request.method} ${request.operation} status=${status ?? axiosError.code ?? "?"} attempt=${attempt}/${maxAttempts}`
        );
        throw error;
      }
      const waitMs = getRetryDelayMs({
        statusCode: status,
        headers: axiosError.response?.headers as Record<string, unknown> | undefined,
        attempt,
        defaultBaseDelayMs: resilience.baseDelayMs,
        rateLimitBaseDelayMs: resilience.rateLimitBaseDelayMs,
      });
      logger.debug(
        `[play] retry ${request.operation} status=${status ?? axiosError.code ?? "?"} attempt=${attempt} waitMs=${Math.round(waitMs)}`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`play request loop exhausted: ${request.operation}`);
}
