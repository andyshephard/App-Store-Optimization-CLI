import axios from "axios";

const SENSOR_TOWER_APPS_ENDPOINT = "https://app.sensortower.com/api/ios/apps";
const SENSOR_TOWER_REQUEST_TIMEOUT_MS = 10_000;

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

export async function fetchSensorTowerAppMetrics(
  appId: string
): Promise<SensorTowerAppMetrics | null> {
  const normalizedAppId = normalizeAppId(appId);
  if (!normalizedAppId) return null;

  const response = await sensorTowerHttpClient.get<SensorTowerAppsResponse>(
    SENSOR_TOWER_APPS_ENDPOINT,
    {
      params: { app_ids: normalizedAppId },
      timeout: SENSOR_TOWER_REQUEST_TIMEOUT_MS,
    }
  );
  const app = response.data.apps?.find(
    (candidate) => String(candidate.app_id ?? "") === normalizedAppId
  );
  if (!app) return null;

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

export async function fetchSensorTowerMetricsForApps(
  appIds: string[],
  onError?: (error: unknown, appId: string) => void
): Promise<Map<string, SensorTowerAppMetrics>> {
  const uniqueAppIds = Array.from(new Set(appIds));
  const metricsByAppId = new Map<string, SensorTowerAppMetrics>();

  await Promise.all(
    uniqueAppIds.map(async (appId) => {
      try {
        const metrics = await fetchSensorTowerAppMetrics(appId);
        if (metrics) metricsByAppId.set(appId, metrics);
      } catch (error) {
        onError?.(error, appId);
      }
    })
  );

  return metricsByAppId;
}
