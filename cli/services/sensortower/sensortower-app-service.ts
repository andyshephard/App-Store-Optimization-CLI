import axios from "axios";
import { parseRetryAfterMs } from "../../shared/aso-retry-delay";

const SENSOR_TOWER_APPS_ENDPOINT = "https://app.sensortower.com/api/ios/apps";
const SENSOR_TOWER_REQUEST_TIMEOUT_MS = 10_000;
const SENSOR_TOWER_MAX_ATTEMPTS = 2;
const SENSOR_TOWER_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const SENSOR_TOWER_MAX_RETRY_DELAY_MS = 5_000;

type SensorTowerApp = {
  app_id?: number | string;
  humanized_worldwide_last_month_downloads?: {
    string?: string;
  };
  humanized_worldwide_last_month_revenue?: {
    string?: string;
  };
};

type SensorTowerAppsResponse = {
  apps?: SensorTowerApp[];
};

export type SensorTowerAppMetrics = {
  lastMonthDownloads?: string;
  lastMonthRevenue?: string;
};

const sensorTowerHttpClient = axios.create();

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeAppId(appId: string): string | null {
  const normalized = appId.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function mapSensorTowerAppMetrics(
  app: SensorTowerApp
): SensorTowerAppMetrics | null {
  const lastMonthDownloads = readString(
    app.humanized_worldwide_last_month_downloads?.string
  );
  const lastMonthRevenue = readString(
    app.humanized_worldwide_last_month_revenue?.string
  );
  if (!lastMonthDownloads && !lastMonthRevenue) return null;

  return {
    ...(lastMonthDownloads ? { lastMonthDownloads } : {}),
    ...(lastMonthRevenue ? { lastMonthRevenue } : {}),
  };
}

function getResponseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : undefined;
}

function getResponseHeaders(
  error: unknown
): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const headers = (error as { response?: { headers?: unknown } }).response?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  return headers as Record<string, unknown>;
}

function getRateLimitRetryDelayMs(error: unknown): number {
  const retryAfterMs = parseRetryAfterMs(getResponseHeaders(error));
  return Math.min(
    retryAfterMs ?? SENSOR_TOWER_RATE_LIMIT_RETRY_DELAY_MS,
    SENSOR_TOWER_MAX_RETRY_DELAY_MS
  );
}

async function fetchSensorTowerMetricsBatch(
  appIds: string[]
): Promise<Map<string, SensorTowerAppMetrics>> {
  let responseData: SensorTowerAppsResponse | undefined;

  for (let attempt = 1; attempt <= SENSOR_TOWER_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await sensorTowerHttpClient.get<SensorTowerAppsResponse>(
        SENSOR_TOWER_APPS_ENDPOINT,
        {
          params: { app_ids: appIds.join(",") },
          timeout: SENSOR_TOWER_REQUEST_TIMEOUT_MS,
        }
      );
      responseData = response.data;
      break;
    } catch (error) {
      const shouldRetry =
        getResponseStatus(error) === 429 && attempt < SENSOR_TOWER_MAX_ATTEMPTS;
      if (!shouldRetry) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, getRateLimitRetryDelayMs(error))
      );
    }
  }

  const requestedAppIds = new Set(appIds);
  const metricsByAppId = new Map<string, SensorTowerAppMetrics>();
  for (const app of responseData?.apps ?? []) {
    const appId = String(app.app_id ?? "").trim();
    if (!requestedAppIds.has(appId)) continue;
    const metrics = mapSensorTowerAppMetrics(app);
    if (metrics) metricsByAppId.set(appId, metrics);
  }
  return metricsByAppId;
}

export async function fetchSensorTowerAppMetrics(
  appId: string
): Promise<SensorTowerAppMetrics | null> {
  const normalizedAppId = normalizeAppId(appId);
  if (!normalizedAppId) return null;
  const metricsByAppId = await fetchSensorTowerMetricsBatch([normalizedAppId]);
  return metricsByAppId.get(normalizedAppId) ?? null;
}

export async function fetchSensorTowerMetricsForApps(
  appIds: string[],
  onError?: (error: unknown, appIds: string[]) => void
): Promise<Map<string, SensorTowerAppMetrics>> {
  const uniqueAppIds = Array.from(
    new Set(
      appIds
        .map(normalizeAppId)
        .filter((appId): appId is string => appId != null)
    )
  );
  if (uniqueAppIds.length === 0) return new Map();

  try {
    return await fetchSensorTowerMetricsBatch(uniqueAppIds);
  } catch (error) {
    onError?.(error, uniqueAppIds);
    return new Map();
  }
}
