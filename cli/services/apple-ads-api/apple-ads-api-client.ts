import axios, { type AxiosInstance } from "axios";
import { logger } from "../../utils/logger";
import { ContextualError } from "../../utils/error-handling-helpers";
import { getAppleAdsApiAccessToken } from "./apple-ads-api-auth";
import { getAppleAdsApiCredentials } from "./apple-ads-api-config";

const API_BASE_URL = "https://api.ads.apple.com";
const MAX_RATE_LIMIT_RETRIES = 3;

const client: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  validateStatus: () => true,
});

let cachedOrgId: string | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveOrgId(): Promise<string> {
  const credentials = getAppleAdsApiCredentials();
  if (credentials?.orgId) return credentials.orgId;
  if (cachedOrgId) return cachedOrgId;
  const token = await getAppleAdsApiAccessToken();
  const response = await client.get("/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const orgId = response.data?.result?.orgId;
  if (response.status !== 200 || orgId == null) {
    throw new ContextualError(
      `Apple Ads API /v1/me failed with status ${response.status}`
    );
  }
  cachedOrgId = String(orgId);
  return cachedOrgId;
}

/**
 * POST to the Apple Ads Platform API with auth, org context, and
 * Retry-After-aware backoff on 429. Throws ContextualError on any
 * non-2xx final response.
 */
export async function appleAdsApiPost<T>(
  apiPath: string,
  body: unknown
): Promise<T> {
  const orgId = await resolveOrgId();
  for (let attempt = 0; ; attempt++) {
    const token = await getAppleAdsApiAccessToken();
    const response = await client.post(apiPath, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Ap-Context": `orgId=${orgId}`,
        "Content-Type": "application/json",
      },
    });
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterSeconds = Number(response.headers?.["retry-after"]);
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : 2 ** attempt * 1000;
      logger.debug(
        `[apple-ads-api] 429 on ${apiPath}, retrying in ${waitMs}ms (attempt ${
          attempt + 1
        })`
      );
      await sleep(waitMs);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const message =
        response.data?.error?.message ?? JSON.stringify(response.data);
      throw new ContextualError(
        `Apple Ads API ${apiPath} failed with status ${response.status}: ${message}`
      );
    }
    return response.data as T;
  }
}

/** Test seam: drops the cached orgId. */
export function resetAppleAdsApiOrgCacheForTests(): void {
  cachedOrgId = null;
}
