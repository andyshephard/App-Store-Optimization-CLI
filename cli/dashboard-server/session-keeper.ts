import { logger } from "../utils/logger";

/**
 * Keeps the Apple Search Ads session alive without a human.
 *
 * The session behind keyword popularity expires after a day or two, but
 * asocli only noticed when a popularity fetch failed — so it sat dead until
 * someone logged in by hand. With ASO_APPLE_ID/ASO_APPLE_PASSWORD set, a
 * re-login needs no 2FA code while Apple's device-trust cookie lasts (~30
 * days), so this checks every few hours - first with one cheap popularity
 * call, and only when that is rejected with a full silent re-login.
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
  /**
   * Cheap check that the stored session still works (one popularity call).
   * Resolves true when it does, in which case no login is attempted. Optional
   * so existing callers keep the login-every-check behaviour.
   */
  probe?: () => Promise<boolean>;
  /** True while a human-driven login is in progress; the keeper stays out of its way. */
  isAuthInProgress?: () => boolean;
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
  let inFlight: Promise<SessionKeeperState> | null = null;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 120_000;

  function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("session check timed out")),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function markHealthy(how: string): void {
    state.ok = true;
    state.needsTwoFactor = false;
    state.lastError = null;
    state.lastOkAt = state.lastCheckAt;
    logger.info(`[session-keeper] Apple session ok (${how})`);
  }

  /**
   * Overlapping calls (the timer and POST /api/aso/session/check) share one
   * attempt instead of racing two logins against each other.
   */
  function check(): Promise<SessionKeeperState> {
    if (inFlight) return inFlight;
    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function runCheck(): Promise<SessionKeeperState> {
    if (deps.isAuthInProgress?.()) {
      logger.info("[session-keeper] skipped: an interactive Apple login is in progress");
      return { ...state };
    }
    state.lastCheckAt = now().toISOString();
    if (deps.probe) {
      try {
        if (await withTimeout(deps.probe())) {
          markHealthy("probe");
          return { ...state };
        }
        logger.info("[session-keeper] session probe rejected; logging in again");
      } catch (error) {
        logger.warn(
          `[session-keeper] session probe failed (${String(
            error instanceof Error ? error.message : error
          ).slice(0, 200)}); logging in again`
        );
      }
    }
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
      await withTimeout(Promise.resolve(attempt));
      markHealthy("login");
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      state.ok = false;
      state.lastError = message.slice(0, 300);
      state.needsTwoFactor = /TWO_FACTOR_REQUIRED|verification code|2fa/i.test(message);
      logger.warn(`[session-keeper] Apple session check failed: ${state.lastError}`);
      if (state.needsTwoFactor) deps.onNeedsTwoFactor(state.lastError);
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

  // A human finished the 2FA login in the dashboard; clear the flag now
  // rather than leaving the reconnect prompt up until the next 6h check.
  function markOk(): void {
    state.lastCheckAt = now().toISOString();
    state.lastOkAt = state.lastCheckAt;
    state.ok = true;
    state.needsTwoFactor = false;
    state.lastError = null;
  }

  return {
    check,
    start,
    markOk,
    getState: (): SessionKeeperState => ({ ...state }),
  };
}
