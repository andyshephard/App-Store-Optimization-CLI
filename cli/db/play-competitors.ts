import { getDb } from "./store";
import { ASO_ENV } from "../shared/aso-env";
import type { PlayTopApp } from "./play-keywords";

/**
 * Google Play competitors: the packages whose ranks are kept beside our own
 * app's. The roster is ASO_PLAY_ROSTER_APP_IDS (fixed by the deployment) plus
 * the packages in play_competitor_apps (added and removed from the dashboard
 * or `POST/DELETE /api/apps` with platform=android). Only the package is
 * stored; names and icons come from the search results already crawled.
 */

export type PlayCompetitorApp = { appId: string; addedAt: string };

export type PlayAppDetails = {
  title: string;
  developer: string | null;
  iconUrl: string | null;
};

/** Adds a package; false when it was already there. */
export function addPlayCompetitorApp(appId: string, now: Date = new Date()): boolean {
  return (
    getDb()
      .prepare(`INSERT OR IGNORE INTO play_competitor_apps (app_id, added_at) VALUES (?, ?)`)
      .run(appId, now.toISOString()).changes > 0
  );
}

/** Removes a package; false when it was not there. Its rank history is kept. */
export function removePlayCompetitorApp(appId: string): boolean {
  return (
    getDb().prepare(`DELETE FROM play_competitor_apps WHERE app_id = ?`).run(appId).changes > 0
  );
}

export function listPlayCompetitorApps(): PlayCompetitorApp[] {
  return getDb()
    .prepare(
      `SELECT app_id AS appId, added_at AS addedAt FROM play_competitor_apps ORDER BY added_at, app_id`
    )
    .all() as PlayCompetitorApp[];
}

/**
 * Every competitor package: ASO_PLAY_ROSTER_APP_IDS first, then the stored
 * ones, without duplicates and without our own app (ASO_PLAY_APP_ID).
 */
export function listPlayRosterAppIds(): string[] {
  const ids = new Set([
    ...ASO_ENV.playRosterAppIds,
    ...listPlayCompetitorApps().map((app) => app.appId),
  ]);
  if (ASO_ENV.playAppId) ids.delete(ASO_ENV.playAppId);
  return Array.from(ids);
}

/**
 * Title, developer and icon of each package, from the most recent stored
 * search result that lists it (any keyword, any country). A package that has
 * not appeared in any crawled top 30 is missing from the map.
 */
export function listPlayAppDetails(appIds: string[]): Map<string, PlayAppDetails> {
  const wanted = new Set(appIds);
  const details = new Map<string, PlayAppDetails>();
  if (wanted.size === 0) return details;
  const rows = getDb()
    .prepare(`SELECT top_apps_json FROM play_keywords ORDER BY updated_at DESC`)
    .all() as Array<{ top_apps_json: string | null }>;
  for (const row of rows) {
    if (details.size === wanted.size) break;
    let apps: PlayTopApp[];
    try {
      const parsed = JSON.parse(row.top_apps_json ?? "[]");
      apps = Array.isArray(parsed) ? parsed : [];
    } catch {
      continue;
    }
    for (const app of apps) {
      if (!app || !wanted.has(app.appId)) continue;
      const known = details.get(app.appId);
      if (known && (known.iconUrl || !app.iconUrl)) continue;
      // The newest title wins; an older row only fills in a missing icon.
      details.set(app.appId, {
        title: known?.title ?? app.title,
        developer: known?.developer ?? app.developer ?? null,
        iconUrl: app.iconUrl ?? null,
      });
    }
  }
  return details;
}
