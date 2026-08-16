import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Credentials for the Apple Ads Platform API (api.ads.apple.com).
 *
 * Resolution order: environment variables, then
 * ~/.aso/apple-ads-api/credentials.json. When neither yields a complete set
 * the API is treated as not configured and every caller must fall back to the
 * legacy cookie-authenticated popularity endpoint — with nothing configured,
 * behaviour stays byte-identical to upstream.
 */
export interface AppleAdsApiCredentials {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPath: string;
  /** Optional; discovered via GET /v1/me when absent. */
  orgId: string | null;
}

const CREDENTIALS_DIR = path.join(os.homedir(), ".aso", "apple-ads-api");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");
const DEFAULT_PRIVATE_KEY_PATH = path.join(CREDENTIALS_DIR, "private-key.pem");

let cached: AppleAdsApiCredentials | null | undefined;

function readCredentialsFile(): Partial<AppleAdsApiCredentials> {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      clientId: typeof parsed.clientId === "string" ? parsed.clientId : undefined,
      teamId: typeof parsed.teamId === "string" ? parsed.teamId : undefined,
      keyId: typeof parsed.keyId === "string" ? parsed.keyId : undefined,
      privateKeyPath:
        typeof parsed.privateKeyPath === "string"
          ? parsed.privateKeyPath
          : undefined,
      orgId:
        typeof parsed.orgId === "string" || typeof parsed.orgId === "number"
          ? String(parsed.orgId)
          : undefined,
    };
  } catch {
    return {};
  }
}

export function getAppleAdsApiCredentials(): AppleAdsApiCredentials | null {
  if (cached !== undefined) return cached;
  const file = readCredentialsFile();
  const env = process.env;
  const clientId = env.ASO_ADS_API_CLIENT_ID || file.clientId;
  const teamId = env.ASO_ADS_API_TEAM_ID || file.teamId || clientId;
  const keyId = env.ASO_ADS_API_KEY_ID || file.keyId;
  const privateKeyPath =
    env.ASO_ADS_API_PRIVATE_KEY_PATH ||
    file.privateKeyPath ||
    DEFAULT_PRIVATE_KEY_PATH;
  const orgId = env.ASO_ADS_API_ORG_ID || file.orgId || null;

  if (!clientId || !teamId || !keyId || !fs.existsSync(privateKeyPath)) {
    cached = null;
    return cached;
  }
  cached = { clientId, teamId, keyId, privateKeyPath, orgId };
  return cached;
}

export function isAppleAdsApiConfigured(): boolean {
  return getAppleAdsApiCredentials() !== null;
}

/** Test seam: clears the memoized credential lookup. */
export function resetAppleAdsApiCredentialsCacheForTests(): void {
  cached = undefined;
}
