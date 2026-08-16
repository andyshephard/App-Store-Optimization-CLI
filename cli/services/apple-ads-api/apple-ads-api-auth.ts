import * as fs from "fs";
import { createSign } from "crypto";
import axios from "axios";
import { logger } from "../../utils/logger";
import { ContextualError } from "../../utils/error-handling-helpers";
import {
  getAppleAdsApiCredentials,
  type AppleAdsApiCredentials,
} from "./apple-ads-api-config";

const TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
const AUDIENCE = "https://appleid.apple.com";
const SCOPE = "searchadsorg";
/** Refresh the access token a minute before Apple expires it. */
const TOKEN_EXPIRY_SLACK_MS = 60 * 1000;
/**
 * Client secrets may live up to 180 days, but a short-lived one leaks less if
 * it ever escapes; regenerating is free because it is signed locally.
 */
const CLIENT_SECRET_TTL_SECONDS = 3600;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

export function createClientSecret(
  credentials: AppleAdsApiCredentials,
  nowMs: number = Date.now()
): string {
  const privateKey = fs.readFileSync(credentials.privateKeyPath, "utf8");
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "ES256", kid: credentials.keyId };
  const payload = {
    sub: credentials.clientId,
    aud: AUDIENCE,
    iat,
    exp: iat + CLIENT_SECRET_TTL_SECONDS,
    iss: credentials.teamId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload)
  )}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  // JWTs carry the raw r||s signature, not OpenSSL's default DER encoding.
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

export async function getAppleAdsApiAccessToken(): Promise<string> {
  const credentials = getAppleAdsApiCredentials();
  if (!credentials) {
    throw new ContextualError(
      "Apple Ads API credentials are not configured. Set ASO_ADS_API_CLIENT_ID / ASO_ADS_API_KEY_ID and place the private key at ~/.aso/apple-ads-api/private-key.pem, or write ~/.aso/apple-ads-api/credentials.json."
    );
  }
  const nowMs = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - TOKEN_EXPIRY_SLACK_MS > nowMs) {
    return cachedToken.accessToken;
  }

  const clientSecret = createClientSecret(credentials, nowMs);
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: clientSecret,
    scope: SCOPE,
  });
  const response = await axios.post(TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (response.status !== 200 || !response.data?.access_token) {
    logger.debug(
      `[apple-ads-api] token request failed: ${response.status} ${JSON.stringify(
        response.data
      )}`
    );
    throw new ContextualError(
      `Apple Ads API token request failed with status ${response.status}`
    );
  }
  const expiresInSeconds =
    typeof response.data.expires_in === "number"
      ? response.data.expires_in
      : 3600;
  cachedToken = {
    accessToken: response.data.access_token,
    expiresAtMs: nowMs + expiresInSeconds * 1000,
  };
  return cachedToken.accessToken;
}

/** Test seam: drops the cached access token. */
export function resetAppleAdsApiTokenCacheForTests(): void {
  cachedToken = null;
}
