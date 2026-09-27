import { logger } from "../utils/logger";

/**
 * Keeps the Apple Search Ads session alive without a human.
 *
 * The session behind keyword popularity expires after a day or two, but
 * asocli only noticed when a popularity fetch failed — so it sat dead until
 * someone logged in by hand. With ASO_APPLE_ID/ASO_APPLE_PASSWORD set, a
 * re-login needs no 2FA code while Apple's device-trust cookie lasts (~30
 * days), so this checks every few hours and silently re-authenticates.
 *
 * It must never block on a prompt: any 2FA request fails the attempt, which is
 * recorded (needsTwoFactor) and reported through the existing alert email.
 * That is the only case left that needs you — roughly once a month.
 */

export type SessionKeeperState = {
  lastCheckAt: string | null;
  lastOkAt: string | null;
  ok: boolean | null;
  needsTwoFactor: boolean;
  lastError: string | null;
};

type Deps = {
  reAuthenticate: (options: {
    promptHandler: { prompt: (p: unknown) => Promise<never> };
    onUserActionRequired: () => never;
  }) => Promise<unknown>;
  onNeedsTwoFactor: (detail: string) => void;
  now?: () => Date;
  timeoutMs?: number;
};

export function createSessionKeeper(deps: Deps) {
  const state: SessionKeeperState = {
    lastCheckAt: null,
    lastOkAt: null,
    ok: null,
    needsTwoFactor: false,
    lastError: null,
  };
  let running = false;
  const now = deps.now ?? (() => new Date());

  async function check(): Promise<SessionKeeperState> {
    if (running) return state;
    running = true;
    state.lastCheckAt = now().toISOString();
    try {
      const attempt = deps.reAuthenticate({
        promptHandler: {
          prompt: async () => {
            throw new Error("TWO_FACTOR_REQUIRED");
          },
        },
        onUserActionRequired: () => {
          throw new Error("TWO_FACTOR_REQUIRED");
        },
      });
      await Promise.race([
        attempt,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("session check timed out")), deps.timeoutMs ?? 120_000)
        ),
      ]);
      state.ok = true;
      state.needsTwoFactor = false;
      state.lastError = null;
      state.lastOkAt = state.lastCheckAt;
      logger.info("[session-keeper] Apple session ok");
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      state.ok = false;
      state.lastError = message.slice(0, 300);
      state.needsTwoFactor = /TWO_FACTOR_REQUIRED|verification code|2fa/i.test(message);
      logger.warn(`[session-keeper] Apple session check failed: ${state.lastError}`);
      if (state.needsTwoFactor) deps.onNeedsTwoFactor(state.lastError);
    } finally {
      running = false;
    }
    return { ...state };
  }

  function start(intervalMs = 6 * 60 * 60 * 1000, firstDelayMs = 60_000): () => void {
    const first = setTimeout(() => void check(), firstDelayMs);
    const every = setInterval(() => void check(), intervalMs);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }

  return { check, start, getState: (): SessionKeeperState => ({ ...state }) };
}
