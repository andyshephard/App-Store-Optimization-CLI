import { useCallback, useEffect, useState } from "react";
import { addPlayCompetitor, fetchPlayApps, removePlayCompetitor } from "../store-api";
import { readStoredPlayAppId, writeStoredPlayAppId, type PlayApp } from "../store-merge";

/** Our app alone, until (or if) the list loads. */
function ownAppOnly(playAppId: string): PlayApp[] {
  return [
    {
      id: playAppId,
      name: null,
      developer: null,
      iconUrl: null,
      kind: "owned",
      source: "ASO_PLAY_APP_ID",
      removable: false,
      addedAt: null,
    },
  ];
}

/**
 * The Google Play apps in the sidebar (our app and the competitors) and the
 * selected one, remembered per browser. Does nothing without `playAppId`.
 */
export function usePlayApps(playAppId: string | null) {
  const [apps, setApps] = useState<PlayApp[]>([]);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(() => readStoredPlayAppId());
  // Bumped after an add or remove: keyword lists carry competitor ranks for
  // the roster as it was when they were read, so the views re-read them.
  const [rosterVersion, setRosterVersion] = useState(0);

  const load = useCallback(async () => {
    if (!playAppId) return;
    try {
      setApps(await fetchPlayApps());
    } catch {
      // The views still work for our app; the list shows it alone.
      setApps((current) => (current.length > 0 ? current : ownAppOnly(playAppId)));
    }
  }, [playAppId]);

  useEffect(() => {
    void load();
  }, [load]);

  const list = apps.length > 0 || !playAppId ? apps : ownAppOnly(playAppId);
  // A remembered competitor that has since been removed falls back to our app.
  const selectedAppId =
    list.find((app) => app.id === selectedChoice)?.id ?? playAppId ?? "";

  const select = useCallback((appId: string) => {
    setSelectedChoice(appId);
    writeStoredPlayAppId(appId);
  }, []);

  const add = useCallback(
    async (appId: string) => {
      await addPlayCompetitor(appId);
      await load();
      setRosterVersion((version) => version + 1);
      select(appId);
    },
    [load, select]
  );

  const remove = useCallback(
    async (appId: string) => {
      await removePlayCompetitor(appId);
      await load();
      setRosterVersion((version) => version + 1);
    },
    [load]
  );

  return { apps: list, selectedAppId, select, add, remove, rosterVersion };
}
