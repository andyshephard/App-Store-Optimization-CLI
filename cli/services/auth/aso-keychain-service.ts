import { execFileSync } from "child_process";
import { logger } from "../../utils/logger";

const SERVICE_NAME = "aso.cli.apple";
const ACCOUNT_NAME = "default";

export interface AppleLoginCredentials {
  appleId: string;
  password: string;
}

/**
 * The only credential store implemented is the macOS Keychain, reached through
 * the `security` binary. On any other platform there is nothing to shell out
 * to, so every method becomes a no-op rather than throwing ENOENT.
 *
 * This matters for a Linux/container deployment: `saveCredentials` runs *after*
 * a successful Apple login, so an unhandled ENOENT there would discard a
 * session the user had just completed two-factor authentication for.
 *
 * Set ASO_DISABLE_CREDENTIAL_STORE=1 to opt out on macOS too.
 */
function isCredentialStoreAvailable(): boolean {
  if (process.env.ASO_DISABLE_CREDENTIAL_STORE === "1") return false;
  return process.platform === "darwin";
}

function loadEnvCredentials(): AppleLoginCredentials | null {
  const appleId = process.env.ASO_APPLE_ID?.trim();
  const password = process.env.ASO_APPLE_PASSWORD?.trim();
  if (!appleId || !password) return null;
  return { appleId, password };
}

/** Whether credentials are supplied by the environment rather than a prompt. */
export function hasEnvAppleCredentials(): boolean {
  return loadEnvCredentials() != null;
}

function runSecurityCommand(args: string[]): string {
  return execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export class AsoKeychainService {
  /** Whether credentials can be persisted at all on this host. */
  isAvailable(): boolean {
    return isCredentialStoreAvailable();
  }

  loadCredentials(): AppleLoginCredentials | null {
    // Environment credentials come first and work on every platform. This is
    // what lets a server re-authenticate unattended: Apple's 2FA trust cookie
    // lasts ~30 days, so a re-login inside that window needs only the Apple ID
    // and password, no verification code.
    const envCredentials = loadEnvCredentials();
    if (envCredentials) return envCredentials;

    if (!isCredentialStoreAvailable()) return null;
    try {
      const raw = runSecurityCommand([
        "find-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        ACCOUNT_NAME,
        "-w",
      ]);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as AppleLoginCredentials;
      if (!parsed.appleId || !parsed.password) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  saveCredentials(credentials: AppleLoginCredentials): void {
    if (!isCredentialStoreAvailable()) {
      logger.debug(
        "[aso-keychain] No OS credential store on this platform; skipping save."
      );
      return;
    }
    try {
      runSecurityCommand([
        "add-generic-password",
        "-U",
        "-s",
        SERVICE_NAME,
        "-a",
        ACCOUNT_NAME,
        "-w",
        JSON.stringify(credentials),
      ]);
    } catch (error) {
      // Caching credentials is a convenience. Never fail an otherwise
      // successful Apple login because the keychain write failed.
      logger.debug(
        `[aso-keychain] Failed to save credentials: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  clearCredentials(): void {
    if (!isCredentialStoreAvailable()) return;
    try {
      runSecurityCommand([
        "delete-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        ACCOUNT_NAME,
      ]);
    } catch {
      return;
    }
  }
}

export const asoKeychainService = new AsoKeychainService();
