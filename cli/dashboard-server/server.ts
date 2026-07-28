import * as http from "http";
import * as path from "path";
import { logger } from "../utils/logger";
import {
  listOwnedAppIdsByKind,
  listOwnedApps,
  upsertOwnedAppSnapshots,
} from "../db/owned-apps";
import { listKeywords } from "../db/aso-keywords";
import {
  listAllAppKeywords,
  getAppLastKeywordAddedAtMap,
} from "../db/app-keywords";
import {
  keywordPipelineService,
} from "../services/keywords/keyword-pipeline-service";
import {
  asoAuthService,
} from "../services/auth/aso-auth-service";
import { isAsoAuthReauthRequiredError } from "../services/keywords/aso-popularity-service";
import {
  getConfiguredAsoAdamId,
  resolveAsoAdamId,
} from "../services/keywords/aso-adam-id-service";
import { reportBugsnagError } from "../services/telemetry/error-reporter";
import {
  mapToDashboardUserSafeError,
  statusForDashboardErrorCode,
  type DashboardErrorCode,
  type DashboardUserSafeError,
} from "../domain/errors/dashboard-errors";
import {
  DEFAULT_ASO_COUNTRY,
  listEnabledStorefronts,
} from "../domain/keywords/policy";
import {
  createStartupRefreshManager,
  STARTUP_KEYWORD_REFRESH_BATCH_SIZE,
  type StartupRefreshState,
} from "./startup-refresh-manager";
import {
  readDashboardSettings,
  updateDashboardSettings,
  type DashboardSettings,
} from "./dashboard-settings";
import {
  createAsoRouteHandlers,
} from "./routes/aso-routes";
import {
  sendApiError,
  sendJson,
  parseJsonBody,
  resolveRequestCountry,
} from "./http-utils";
import { enforceRequestAuth } from "./request-auth";
import { createRefreshScheduler } from "./refresh-scheduler";
import { closeDb } from "../db/store";
import { shutdownPostHog } from "../services/telemetry/posthog-usage-tracking";
import {
  resolveStaticPath,
  sendDashboardRuntimeConfig,
  sendStaticFile,
  staticFileExists,
} from "./static-files";
import { createDashboardAuthStateManager } from "./auth-state";
import { createDashboardSetupStateManager } from "./setup-state";
import {
  createAppsHandlers,
  ensureDefaultResearchAppExists,
} from "./apps-handler";
import { fetchOwnedAppSnapshotsFromApi } from "./owned-app-details";
import { ASO_ENV } from "../shared/aso-env";
import {
  formatDashboardHttpUrl,
  getDashboardBrowserUrl,
  getDashboardExposureWarning,
  isLoopbackDashboardHost,
} from "../shared/dashboard-network";
import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../shared/aso-interactive-prompts";

const DEFAULT_APP_DOCS_HYDRATION_COUNTRY = DEFAULT_ASO_COUNTRY;
const DASHBOARD_PUBLIC_DIR = path.resolve(__dirname, "dashboard-public");
const DASHBOARD_RUNTIME_CONFIG_PATH = "/runtime-config.js";
const MIN_API_TOKEN_LENGTH = 32;
const SHUTDOWN_TIMEOUT_MS = 8000;

let foregroundMutationCount = 0;

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function toDashboardOperation(
  method: string | undefined,
  path: string | undefined
): string | undefined {
  if (!method || !path) return undefined;
  return `${method.toUpperCase()} ${path.split("?")[0] || path}`;
}

function reportDashboardError(
  error: unknown,
  metadata: Record<string, unknown>
): void {
  const method = toStringValue(metadata.method);
  const path = toStringValue(metadata.path);
  const operation = toDashboardOperation(method, path);
  reportBugsnagError(error, {
    surface: "aso-dashboard-server",
    source: toStringValue(metadata.source) ?? "dashboard-server.runtime",
    operation: toStringValue(metadata.operation) ?? operation ?? "server-runtime",
    endpoint: toStringValue(metadata.endpoint) ?? path,
    ...metadata,
  });
}

function toUserSafeError(error: unknown, fallback: string): DashboardUserSafeError {
  return mapToDashboardUserSafeError(error, {
    fallback,
    isAuthReauthRequiredError: isAsoAuthReauthRequiredError,
  });
}

function beginForegroundMutation(): () => void {
  foregroundMutationCount += 1;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    foregroundMutationCount = Math.max(0, foregroundMutationCount - 1);
  };
}

async function runAsForegroundMutation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const end = beginForegroundMutation();
  try {
    return await operation();
  } finally {
    end();
  }
}

function runAsForegroundMutationSync(operation: () => void): void {
  const end = beginForegroundMutation();
  try {
    operation();
  } finally {
    end();
  }
}

const startupRefreshManager = createStartupRefreshManager({
  country: DEFAULT_ASO_COUNTRY,
  // Background refresh covers every enabled storefront, not just the default —
  // otherwise keywords tracked in GB would never refresh on their own.
  listRefreshCountries: () =>
    listEnabledStorefronts().map((storefront) => storefront.country),
  listKeywords,
  listAppKeywords: listAllAppKeywords,
  listAssociatedAppIds: () => {
    const settings = readDashboardSettings();
    const appIds = listOwnedAppIdsByKind("owned");
    if (settings.includeResearchAppsInKeywordRefresh) {
      appIds.push(...listOwnedAppIdsByKind("research"));
    }
    return new Set(appIds);
  },
  listOrderRelevantAppIds: () => new Set(listOwnedAppIdsByKind("owned")),
  enrichKeywords: (country, items, options) =>
    keywordPipelineService.refreshStartup(country, items, options),
  isForegroundBusy: () => foregroundMutationCount > 0,
  interCountryDelayMs: ASO_ENV.refreshInterCountryDelayMs,
  interBatchDelayMs: ASO_ENV.refreshInterBatchDelayMs,
  // Two full batches of nothing but failures means the storefront is throttled,
  // not that these particular keywords are bad.
  abandonCountryAfterFailedKeywords: STARTUP_KEYWORD_REFRESH_BATCH_SIZE * 2,
  reportError: (error, metadata) => {
    reportDashboardError(error, {
      ...metadata,
      context: "startup-refresh",
    });
  },
  isAuthReauthRequiredError: isAsoAuthReauthRequiredError,
});

/**
 * Owns the clock for the daily refresh, so the database stays current whether
 * or not anything external calls the API. Disabled unless ASO_REFRESH_DAILY_AT
 * is set, which keeps local runs and existing installs unchanged.
 */
const refreshScheduler = createRefreshScheduler({
  dailyAt: ASO_ENV.refreshDailyAt,
  timeZone: ASO_ENV.refreshTimeZone,
  run: () => startupRefreshManager.start(),
  onError: (error, metadata) => {
    reportDashboardError(error, { ...metadata, context: "refresh-scheduler" });
  },
});

function getStartupRefreshState(): StartupRefreshState {
  return startupRefreshManager.getState();
}

function startStartupRefresh(options?: { force?: boolean }): void {
  startupRefreshManager.start(options);
}

function stopStartupRefresh(): void {
  startupRefreshManager.stop();
}

function startConfiguredKeywordRefresh(): void {
  const settings = readDashboardSettings();
  if (settings.refreshMode === "startup") {
    startStartupRefresh();
  }
}

const dashboardAuthStateManager = createDashboardAuthStateManager({
  reAuthenticate: (options) => asoAuthService.reAuthenticate(options),
  onError: (error) => {
    reportDashboardError(error, {
      method: "POST",
      path: "/api/aso/auth/start",
    });
  },
});

const dashboardSetupStateManager = createDashboardSetupStateManager({
  isSetupRequired: () => getConfiguredAsoAdamId() == null,
  resolvePrimaryAppId: (options) =>
    resolveAsoAdamId({
      allowPrompt: true,
      forcePrompt: options?.forcePrompt,
      promptHandler: options?.promptHandler,
    }),
  onResolved: () => {
    startConfiguredKeywordRefresh();
  },
  onError: (error) => {
    reportDashboardError(error, {
      method: "POST",
      path: "/api/aso/setup/start",
    });
  },
});

function beginDashboardReauthentication(): boolean {
  return dashboardAuthStateManager.start();
}

function beginDashboardPrimaryAppSetup(options?: {
  forcePrompt?: boolean;
}): boolean {
  return dashboardSetupStateManager.start(options);
}

function getDashboardAuthState() {
  return dashboardAuthStateManager.getState();
}

function getDashboardSetupState() {
  return dashboardSetupStateManager.getState();
}

function parseQuery(url: string): Record<string, string> {
  const i = url.indexOf("?");
  if (i < 0) return {};
  const out: Record<string, string> = {};
  const search = new URLSearchParams(url.slice(i));
  search.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function isTruthyQueryParam(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getPendingPromptResponse(
  prompt: AsoInteractivePrompt | null,
  body: unknown
): AsoInteractivePromptResponse | null {
  if (!prompt || typeof body !== "object" || body == null) {
    return null;
  }

  const payload = body as Record<string, unknown>;
  const submittedKind =
    typeof payload.kind === "string" ? payload.kind : undefined;
  if (submittedKind !== prompt.kind) {
    return null;
  }

  switch (prompt.kind) {
    case "primary_app_id": {
      const adamId = toStringValue(payload.adamId);
      if (!adamId) return null;
      return { kind: "primary_app_id", adamId };
    }
    case "apple_credentials": {
      const appleId = toStringValue(payload.appleId);
      const password = toStringValue(payload.password);
      if (!appleId || !password) return null;
      return { kind: "apple_credentials", appleId, password };
    }
    case "remember_credentials": {
      if (typeof payload.remember !== "boolean") return null;
      return {
        kind: "remember_credentials",
        remember: payload.remember,
      };
    }
    case "two_factor_method":
    case "trusted_phone": {
      const value = toStringValue(payload.value);
      if (!value) return null;
      if (!prompt.choices.some((choice) => choice.value === value)) return null;
      return {
        kind: prompt.kind,
        value,
      };
    }
    case "verification_code": {
      const code = toStringValue(payload.code);
      if (!code) return null;
      const regex = new RegExp(`^\\d{${prompt.digits}}$`);
      if (!regex.test(code)) return null;
      return { kind: "verification_code", code };
    }
  }
}

const appsHandlers = createAppsHandlers({
  parseJsonBody,
  sendJson,
  sendApiError,
  reportDashboardError,
  fetchOwnedAppSnapshotsFromApi,
  hydrationCountry: DEFAULT_APP_DOCS_HYDRATION_COUNTRY,
});

function handleApiAsoAuthStatusGet(res: http.ServerResponse): void {
  sendJson(res, 200, { success: true, data: getDashboardAuthState() });
}

function handleApiAsoSetupStatusGet(res: http.ServerResponse): void {
  sendJson(res, 200, { success: true, data: getDashboardSetupState() });
}

function handleApiAsoRefreshStatusGet(res: http.ServerResponse): void {
  sendJson(res, 200, {
    success: true,
    data: { ...getStartupRefreshState(), schedule: refreshScheduler.getState() },
  });
}

function handleApiAsoStorefrontsGet(res: http.ServerResponse): void {
  sendJson(res, 200, {
    success: true,
    data: {
      storefronts: listEnabledStorefronts(),
      defaultCountry: DEFAULT_ASO_COUNTRY,
    },
  });
}

function handleApiAsoRefreshStartPost(
  res: http.ServerResponse,
  query: Record<string, string>
): void {
  // force=1 re-crawls every tracked keyword instead of only the stale ones.
  startStartupRefresh({ force: isTruthyQueryParam(query.force) });
  sendJson(res, 202, { success: true, data: getStartupRefreshState() });
}

function handleApiAsoRefreshStopPost(res: http.ServerResponse): void {
  stopStartupRefresh();
  sendJson(res, 202, { success: true, data: getStartupRefreshState() });
}

function handleApiDashboardSettingsGet(res: http.ServerResponse): void {
  sendJson(res, 200, { success: true, data: readDashboardSettings() });
}

async function handleApiDashboardSettingsPatch(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    sendApiError(
      res,
      400,
      "INVALID_REQUEST",
      "Settings payload must be an object."
    );
    return;
  }

  const payload = body as Partial<Record<keyof DashboardSettings, unknown>>;
  const patch: Partial<DashboardSettings> = {};

  if ("includeResearchAppsInKeywordRefresh" in payload) {
    if (typeof payload.includeResearchAppsInKeywordRefresh !== "boolean") {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "includeResearchAppsInKeywordRefresh must be a boolean."
      );
      return;
    }
    patch.includeResearchAppsInKeywordRefresh =
      payload.includeResearchAppsInKeywordRefresh;
  }

  if ("refreshMode" in payload) {
    if (payload.refreshMode !== "startup" && payload.refreshMode !== "manual") {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "refreshMode must be startup or manual."
      );
      return;
    }
    patch.refreshMode = payload.refreshMode;
  }

  const settings = updateDashboardSettings(patch);
  sendJson(res, 200, { success: true, data: settings });
}

function handleApiAsoAuthStartPost(res: http.ServerResponse): void {
  if (!beginDashboardReauthentication()) {
    sendApiError(
      res,
      409,
      "AUTH_IN_PROGRESS",
      "Reauthentication is already in progress."
    );
    return;
  }

  sendJson(res, 202, { success: true, data: getDashboardAuthState() });
}

function handleApiAsoSetupStartPost(
  res: http.ServerResponse,
  query: Record<string, string>
): void {
  const forcePrompt = isTruthyQueryParam(query.force);
  if (!beginDashboardPrimaryAppSetup({ forcePrompt })) {
    const state = getDashboardSetupState();
    const errorCode =
      state.status === "in_progress" ? "SETUP_IN_PROGRESS" : "SETUP_NOT_REQUIRED";
    const statusCode = state.status === "in_progress" ? 409 : 409;
    sendApiError(
      res,
      statusCode,
      errorCode,
      errorCode === "SETUP_IN_PROGRESS"
        ? "Primary App ID setup is already in progress."
        : "Primary App ID setup is not required."
    );
    return;
  }

  sendJson(res, 202, { success: true, data: getDashboardSetupState() });
}

async function handleApiAsoAuthRespondPost(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const state = getDashboardAuthState();
  const response = getPendingPromptResponse(state.pendingPrompt, body);
  if (!response || !dashboardAuthStateManager.submitPromptResponse(response)) {
    const currentState = getDashboardAuthState();
    if (currentState.status === "in_progress" && currentState.pendingPrompt == null) {
      sendJson(res, 202, { success: true, data: currentState });
      return;
    }
    sendApiError(
      res,
      400,
      "INVALID_PROMPT_RESPONSE",
      "Prompt response did not match the active authentication step."
    );
    return;
  }
  sendJson(res, 202, { success: true, data: getDashboardAuthState() });
}

async function handleApiAsoSetupRespondPost(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const state = getDashboardSetupState();
  const response = getPendingPromptResponse(state.pendingPrompt, body);
  if (!response || !dashboardSetupStateManager.submitPromptResponse(response)) {
    const currentState = getDashboardSetupState();
    if (currentState.status === "in_progress" && currentState.pendingPrompt == null) {
      sendJson(res, 202, { success: true, data: currentState });
      return;
    }
    sendApiError(
      res,
      400,
      "INVALID_PROMPT_RESPONSE",
      "Prompt response did not match the active setup step."
    );
    return;
  }
  sendJson(res, 202, { success: true, data: getDashboardSetupState() });
}
const asoRouteHandlers = createAsoRouteHandlers({
  parseJsonBody,
  sendJson,
  sendApiError,
  reportDashboardError,
  toUserSafeError,
  statusForDashboardErrorCode: (errorCode) =>
    statusForDashboardErrorCode(errorCode as DashboardErrorCode),
  isDashboardAuthInProgress: () => dashboardAuthStateManager.isInProgress(),
  isTruthyQueryParam,
});

export function createServerRequestHandler(): http.RequestListener {
  return async (req, res) => {
    const url = req.url ?? "/";
    const [pathname] = url.split("?");
    if (!enforceRequestAuth(req, res, pathname)) return;
    try {
      const query = parseQuery(url);

      if (req.method === "GET" && pathname === "/") {
        sendStaticFile(res, path.join(DASHBOARD_PUBLIC_DIR, "index.html"));
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { success: true });
        return;
      }

      if (req.method === "GET" && pathname === DASHBOARD_RUNTIME_CONFIG_PATH) {
        sendDashboardRuntimeConfig(
          res,
          process.env.NODE_ENV ?? "",
          process.env.ASO_BUGSNAG_VERBOSE_TRACES === "1",
          process.env.BUGSNAG_API_KEY
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/apps") {
        const country = resolveRequestCountry(res, query.country);
        if (!country) return;
        ensureDefaultResearchAppExists();
        let apps = listOwnedApps(country);
        const nowMs = Date.now();
        const refreshMaxAgeMs = ASO_ENV.ownedAppDocRefreshMaxAgeMs;
        const staleOwnedAppIds = apps
          .filter((app) => app.kind === "owned")
          .map((app) => {
            const fetchedAtMs = Date.parse(app.lastFetchedAt ?? "");
            if (!Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs >= refreshMaxAgeMs) {
              return app.id;
            }
            return null;
          })
          .filter((id): id is string => id != null);

        if (staleOwnedAppIds.length > 0) {
          try {
            const snapshots = await fetchOwnedAppSnapshotsFromApi(
              country,
              staleOwnedAppIds
            );
            if (snapshots.length > 0) {
              upsertOwnedAppSnapshots(country, snapshots);
            }
            apps = listOwnedApps(country);
          } catch (error) {
            reportDashboardError(error, {
              method: "GET",
              path: "/api/apps",
              phase: "owned-app-refresh",
              country,
              staleOwnedAppCount: staleOwnedAppIds.length,
            });
          }
        }
        const appLastAddedAt = getAppLastKeywordAddedAtMap(country);
        const payload = apps
          .map((app) => ({
            id: app.id,
            kind: app.kind,
            name: app.name,
            averageUserRating: app.averageUserRating,
            userRatingCount: app.userRatingCount,
            previousAverageUserRating: app.previousAverageUserRating,
            previousUserRatingCount: app.previousUserRatingCount,
            icon: app.icon,
            expiresAt: app.expiresAt,
            lastFetchedAt: app.lastFetchedAt,
            lastKeywordAddedAt: appLastAddedAt.get(app.id) ?? null,
          }))
          .sort((a, b) => {
            const ad = a.lastKeywordAddedAt ?? "";
            const bd = b.lastKeywordAddedAt ?? "";
            if (ad && bd && ad !== bd) return bd.localeCompare(ad);
            if (ad && !bd) return -1;
            if (!ad && bd) return 1;
            return a.name.localeCompare(b.name);
          });
        sendJson(res, 200, { success: true, data: payload });
        return;
      }

      if (req.method === "POST" && pathname === "/api/apps") {
        await runAsForegroundMutation(() =>
          appsHandlers.handleApiAppsPost(req, res)
        );
        return;
      }

      if (req.method === "DELETE" && pathname === "/api/apps") {
        await runAsForegroundMutation(() =>
          appsHandlers.handleApiAppsDelete(req, res)
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/auth/status") {
        handleApiAsoAuthStatusGet(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/setup/status") {
        handleApiAsoSetupStatusGet(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/refresh-status") {
        handleApiAsoRefreshStatusGet(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/storefronts") {
        handleApiAsoStorefrontsGet(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/dashboard/settings") {
        handleApiDashboardSettingsGet(res);
        return;
      }

      if (req.method === "PATCH" && pathname === "/api/dashboard/settings") {
        await runAsForegroundMutation(() =>
          handleApiDashboardSettingsPatch(req, res)
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/refresh/start") {
        runAsForegroundMutationSync(() => {
          handleApiAsoRefreshStartPost(res, query);
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/refresh/stop") {
        runAsForegroundMutationSync(() => {
          handleApiAsoRefreshStopPost(res);
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/auth/start") {
        runAsForegroundMutationSync(() => {
          handleApiAsoAuthStartPost(res);
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/auth/respond") {
        await runAsForegroundMutation(() =>
          handleApiAsoAuthRespondPost(req, res)
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/setup/start") {
        runAsForegroundMutationSync(() => {
          handleApiAsoSetupStartPost(res, query);
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/setup/respond") {
        await runAsForegroundMutation(() =>
          handleApiAsoSetupRespondPost(req, res)
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/keywords") {
        asoRouteHandlers.handleApiAsoKeywordsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/keywords/history") {
        asoRouteHandlers.handleApiAsoKeywordHistoryGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/top-apps") {
        await asoRouteHandlers.handleApiAsoTopAppsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/apps/search") {
        await asoRouteHandlers.handleApiAsoAppsSearchGet(res, query);
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/keywords") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsPost(req, res)
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/keywords/favorite") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsFavoritePost(req, res)
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/keywords/retry-failed") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsRetryFailedPost(req, res)
        );
        return;
      }

      if (req.method === "DELETE" && pathname === "/api/aso/keywords") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsDelete(req, res)
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/apps") {
        await asoRouteHandlers.handleApiAsoAppsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname && !pathname.startsWith("/api/")) {
        const staticPath = resolveStaticPath(DASHBOARD_PUBLIC_DIR, pathname);
        if (staticPath && staticFileExists(staticPath)) {
          sendStaticFile(res, staticPath);
          return;
        }
        sendStaticFile(res, path.join(DASHBOARD_PUBLIC_DIR, "index.html"));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      reportDashboardError(error, {
        method: req.method,
        path: pathname,
      });
      if (res.writableEnded) return;
      if (pathname.startsWith("/api/")) {
        sendApiError(
          res,
          500,
          "INTERNAL_ERROR",
          "Internal server error."
        );
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal server error.");
    }
  };
}

export function createServer(): http.Server {
  return http.createServer(createServerRequestHandler());
}

/**
 * Stop cleanly on the signals a container runtime sends.
 *
 * `stopStartupRefresh()` sets the flag the batch loop already checks, so a
 * crawl in flight finishes its current batch instead of being cut off
 * mid-request to Apple.
 */
function registerShutdownHandlers(server: http.Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down ASO dashboard.`);

    // Backstop: never hang past the runtime's grace period.
    const force = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    force.unref();

    refreshScheduler.stop();
    stopStartupRefresh();
    server.close(() => {
      try {
        closeDb();
      } catch {
        // Already reported by the DB layer; exiting regardless.
      }
      void shutdownPostHog().finally(() => process.exit(0));
    });
    server.closeIdleConnections?.();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

export function startDashboard(openBrowser: boolean = true): Promise<never> {
  return new Promise((_, reject) => {
    const dashboardHost = ASO_ENV.dashboardHost;
    const dashboardPort = ASO_ENV.dashboardPort;
    const apiToken = ASO_ENV.apiToken;
    const isLoopback = isLoopbackDashboardHost(dashboardHost);

    // Refuse to be reachable without a token rather than merely warning about
    // it. Anything that reaches this port can delete tracked data and drive the
    // Apple login prompts.
    if (!isLoopback && !apiToken) {
      reject(
        new Error(
          `Refusing to bind the ASO dashboard to ${formatDashboardHttpUrl(dashboardHost, dashboardPort)} ` +
            "without authentication. Set ASO_API_TOKEN (32+ characters), or bind to 127.0.0.1."
        )
      );
      return;
    }
    if (apiToken && apiToken.length < MIN_API_TOKEN_LENGTH) {
      reject(
        new Error(
          `ASO_API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters ` +
            `(got ${apiToken.length}). Generate one with: openssl rand -hex 32`
        )
      );
      return;
    }

    const server = createServer();
    let boundPort = dashboardPort;
    let retriedWithDynamicPort = false;
    // Silently moving to a random port is a convenience for local runs. Where
    // the port is pinned or the host is remote it would only produce failing
    // health checks and proxy errors that look like a healthy process.
    const allowDynamicPortFallback =
      isLoopback && process.env.ASO_DASHBOARD_PORT == null;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (
        err.code === "EADDRINUSE" &&
        allowDynamicPortFallback &&
        !retriedWithDynamicPort
      ) {
        retriedWithDynamicPort = true;
        boundPort = 0;
        logger.debug(
          `ASO dashboard port ${dashboardPort} is busy; retrying with an available local port.`
        );
        server.listen(0, dashboardHost);
        return;
      }

      if (err.code === "EADDRINUSE") {
        logger.error(
          `ASO dashboard failed to start: no available local port found after retry (last attempted: ${boundPort}).`
        );
        reject(
          new Error(
            `Failed to start ASO dashboard: no available local port found after retry (last attempted: ${boundPort}).`
          )
        );
        return;
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        logger.error(
          `ASO dashboard failed to start: cannot bind to ${dashboardHost}:${boundPort} (${err.code}).`
        );
        reject(
          new Error(
            `Cannot bind dashboard to ${dashboardHost}:${boundPort} (${err.code}).`
          )
        );
        return;
      }
      reject(err);
    });

    registerShutdownHandlers(server);
    refreshScheduler.start();

    server.listen(dashboardPort, dashboardHost, () => {
      const address = server.address();
      const activePort =
        address && typeof address === "object" && "port" in address
          ? address.port
          : boundPort;
      const url = formatDashboardHttpUrl(dashboardHost, activePort);
      logger.info(`ASO Dashboard: ${url}`);
      const exposureWarning = getDashboardExposureWarning(
        dashboardHost,
        activePort,
        apiToken != null
      );
      if (exposureWarning) logger.warn(exposureWarning);
      if (getConfiguredAsoAdamId()) {
        startConfiguredKeywordRefresh();
      } else {
        dashboardSetupStateManager.start();
      }
      if (openBrowser) {
        const launchUrl = getDashboardBrowserUrl(dashboardHost, activePort);
        try {
          const { exec } = require("child_process");
          const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
          exec(`${open} ${launchUrl}`);
        } catch {
          // ignore
        }
      }
    });
  });
}
