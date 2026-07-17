import type { StoredSensorTowerAppMetrics } from "./types";
import { getDb } from "./store";

type SensorTowerAppMetricsRow = {
  app_id: string;
  last_month_downloads: string;
  last_month_revenue: string;
  fetched_at: string;
};

export type SensorTowerAppMetricsInput = {
  appId: string;
  lastMonthDownloads: string;
  lastMonthRevenue: string;
};

function toStoredMetrics(
  row: SensorTowerAppMetricsRow
): StoredSensorTowerAppMetrics {
  return {
    appId: row.app_id,
    lastMonthDownloads: row.last_month_downloads,
    lastMonthRevenue: row.last_month_revenue,
    fetchedAt: row.fetched_at,
  };
}

export function getSensorTowerAppMetrics(
  appIds: string[]
): StoredSensorTowerAppMetrics[] {
  const uniqueAppIds = Array.from(
    new Set(appIds.map((appId) => appId.trim()).filter(Boolean))
  );
  if (uniqueAppIds.length === 0) return [];

  const placeholders = uniqueAppIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT app_id, last_month_downloads, last_month_revenue, fetched_at
       FROM sensor_tower_app_metrics
       WHERE app_id IN (${placeholders})`
    )
    .all(...uniqueAppIds) as SensorTowerAppMetricsRow[];
  const byAppId = new Map(
    rows.map((row) => [row.app_id, toStoredMetrics(row)] as const)
  );
  return uniqueAppIds
    .map((appId) => byAppId.get(appId))
    .filter((metrics): metrics is StoredSensorTowerAppMetrics => metrics != null);
}

export function upsertSensorTowerAppMetrics(
  metrics: SensorTowerAppMetricsInput[],
  fetchedAt: string = new Date().toISOString()
): void {
  if (metrics.length === 0) return;
  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO sensor_tower_app_metrics (
       app_id, last_month_downloads, last_month_revenue, fetched_at
     )
     VALUES (@appId, @lastMonthDownloads, @lastMonthRevenue, @fetchedAt)
     ON CONFLICT(app_id) DO UPDATE SET
       last_month_downloads = excluded.last_month_downloads,
       last_month_revenue = excluded.last_month_revenue,
       fetched_at = excluded.fetched_at`
  );
  const write = db.transaction(() => {
    for (const entry of metrics) {
      const appId = entry.appId.trim();
      const lastMonthDownloads = entry.lastMonthDownloads.trim();
      const lastMonthRevenue = entry.lastMonthRevenue.trim();
      if (!appId || !lastMonthDownloads || !lastMonthRevenue) continue;
      statement.run({
        appId,
        lastMonthDownloads,
        lastMonthRevenue,
        fetchedAt,
      });
    }
  });
  write();
}
