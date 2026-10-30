import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Card, Input } from "../ui-react";
import { countryFlagEmoji, toActionableErrorMessage } from "../app-helpers";
import {
  addIosKeywordsDeferred,
  addPlayKeywords,
  fetchIosKeywords,
  fetchPlayKeywords,
} from "../store-api";
import {
  MERGED_DEFAULT_SORT_DIR,
  mergeStoreKeywords,
  sortMergedRows,
  toIosSide,
  toPlaySide,
  type MergedKeywordRow,
  type MergedSortDir,
  type MergedSortKey,
  type StoreSide,
} from "../store-merge";
import { MetricBar } from "./metric-bar";
import { PLAY_POPULARITY_HINT, RankChange } from "./play-keywords-view";
import { SortableTh } from "./sortable-th";
import { StatusBanners } from "./status-banners";

type Props = {
  country: string;
  /** Countries enabled on both stores. */
  countries: Array<{ country: string; name: string }>;
  onCountryChange: (country: string) => void;
  iosAppId: string;
  iosAppName: string;
  /** False for a Research entry: it is not an app, so it has no App Store rank. */
  iosHasRank: boolean;
  playAppId: string;
  /** Called after a keyword is tracked on the App Store from here. */
  onIosKeywordsChanged: () => void;
};

type Store = "ios" | "play";
const STORE_LABEL: Record<Store, string> = { ios: "App Store", play: "Google Play" };

function PopularityTrend({ change }: { change: number | null }) {
  if (change == null || change === 0) return null;
  return (
    <span
      className={`pop-trend ${change > 0 ? "up" : "down"}`}
      title={`${change > 0 ? "Up" : "Down"} ${Math.abs(change)} vs previous week`}
    >
      {change > 0 ? "↑" : "↓"}
      {Math.abs(change)}
    </span>
  );
}

function RankCell({
  side,
  available,
  unrankedLabel,
}: {
  side: StoreSide;
  available: boolean;
  unrankedLabel: string;
}) {
  if (!available) {
    return (
      <span className="metric-empty" title="Research entries have no App Store rank">
        -
      </span>
    );
  }
  if (side.status === "pending" && side.rank == null) {
    return <span className="metric-pending">Pending</span>;
  }
  if (side.rank == null) return <span className="metric-empty">{unrankedLabel}</span>;
  return (
    <span className="store-rank">
      {side.rank}
      <RankChange change={side.rankChange} />
    </span>
  );
}

function PlayPopularityCell({ side }: { side: StoreSide }) {
  if (side.popularity == null) {
    return side.popularityPending ? (
      <span className="metric-pending">Not checked yet</span>
    ) : (
      <span className="metric-empty">Not suggested</span>
    );
  }
  return (
    <span
      className="play-popularity"
      title={`Play suggests it after ${side.popularity} letters${
        side.suggestionRank != null ? `, as suggestion ${side.suggestionRank}` : ""
      }`}
    >
      <strong>{side.popularity}</strong> letter{side.popularity === 1 ? "" : "s"}
    </span>
  );
}

export function BothStoresView(props: Props) {
  const { country, iosAppId, onIosKeywordsChanged } = props;
  const [rows, setRows] = useState<MergedKeywordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<MergedSortKey>("keyword");
  const [sortDir, setSortDir] = useState<MergedSortDir>("asc");

  const load = useCallback(async () => {
    try {
      const [ios, play] = await Promise.all([
        fetchIosKeywords(country, iosAppId),
        fetchPlayKeywords(country),
      ]);
      setRows(
        mergeStoreKeywords(
          ios.map((item) => toIosSide(item, iosAppId)),
          play.map(toPlaySide)
        )
      );
      setErrorText("");
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to load keywords"));
    } finally {
      setLoading(false);
    }
  }, [country, iosAppId]);

  useEffect(() => {
    setLoading(true);
    setRows([]);
    void load();
  }, [load]);

  const visibleRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle ? rows.filter((row) => row.key.includes(needle)) : rows;
    return sortMergedRows(filtered, sortBy, sortDir);
  }, [filter, rows, sortBy, sortDir]);

  const onSort = (key: MergedSortKey) => {
    if (key === sortBy) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(MERGED_DEFAULT_SORT_DIR[key]);
    }
  };

  const onTrack = async (row: MergedKeywordRow, store: Store) => {
    setBusyKey(`${store}:${row.key}`);
    setErrorText("");
    setSuccessText("");
    try {
      if (store === "ios") {
        await addIosKeywordsDeferred(country, iosAppId, [row.keyword]);
        onIosKeywordsChanged();
        setSuccessText(`Tracking "${row.keyword}" on the App Store from the next refresh.`);
      } else {
        await addPlayKeywords(country, [row.keyword]);
        setSuccessText(`Tracking "${row.keyword}" on Google Play.`);
      }
      await load();
    } catch (error) {
      setErrorText(
        toActionableErrorMessage(error, `Failed to track on ${STORE_LABEL[store]}`)
      );
    } finally {
      setBusyKey(null);
    }
  };

  const notTracked = (row: MergedKeywordRow, store: Store) => (
    <td colSpan={2} className="col-middle store-not-tracked">
      <span className="metric-empty">Not tracked</span>
      <button
        type="button"
        className="store-track-button"
        disabled={busyKey != null}
        aria-label={`Track ${row.keyword} on ${STORE_LABEL[store]}`}
        onClick={() => void onTrack(row, store)}
      >
        {busyKey === `${store}:${row.key}` ? "Adding..." : `Track on ${STORE_LABEL[store]}`}
      </button>
    </td>
  );

  const onlyIos = rows.filter((row) => row.play == null).length;
  const onlyPlay = rows.filter((row) => row.ios == null).length;

  return (
    <>
      <Card className="add-card store-both-status">
        <p className="store-both-apps">
          <span>
            App Store: <strong>{props.iosAppName}</strong>
          </span>
          <span>
            Google Play: <strong>{props.playAppId}</strong>
          </span>
        </p>
        <StatusBanners
          idPrefix="both-"
          showLoading={busyKey != null}
          loadingText="Adding keyword..."
          showError={busyKey == null && errorText !== ""}
          errorText={errorText}
          showSuccess={busyKey == null && errorText === "" && successText !== ""}
          successText={successText}
        />
      </Card>

      <Card className="top-toolbar store-toolbar">
        <label className="store-country">
          <span className="sr-only">Country</span>
          <select
            className="storefront-select"
            value={country}
            onChange={(event) => props.onCountryChange(event.target.value)}
          >
            {props.countries.map((entry) => (
              <option key={entry.country} value={entry.country} title={entry.name}>
                {`${countryFlagEmoji(entry.country)} ${entry.country}`}
              </option>
            ))}
          </select>
        </label>
        <Input
          type="search"
          className="store-filter"
          placeholder="Search"
          aria-label="Search keywords"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Badge>
          {rows.length} keyword{rows.length === 1 ? "" : "s"}
          {onlyIos > 0 ? ` · ${onlyIos} App Store only` : ""}
          {onlyPlay > 0 ? ` · ${onlyPlay} Play only` : ""}
        </Badge>
      </Card>

      <Card className="table-card">
        <span id="both-play-popularity-hint" hidden>
          {PLAY_POPULARITY_HINT}
        </span>
        <div className="table-wrap">
          <table className="store-table both-table" aria-label="Keywords on both stores">
            <thead>
              <tr>
                <SortableTh
                  label="Keyword"
                  className="col-keyword"
                  active={sortBy === "keyword"}
                  dir={sortDir}
                  onSort={() => onSort("keyword")}
                />
                <SortableTh
                  label="App Store popularity"
                  className="num col-middle"
                  active={sortBy === "iosPopularity"}
                  dir={sortDir}
                  onSort={() => onSort("iosPopularity")}
                />
                <SortableTh
                  label="App Store rank"
                  className="num col-middle"
                  active={sortBy === "iosRank"}
                  dir={sortDir}
                  onSort={() => onSort("iosRank")}
                />
                <SortableTh
                  label={
                    <>
                      Play popularity <span aria-hidden="true">ⓘ</span>
                    </>
                  }
                  className="col-middle"
                  title={PLAY_POPULARITY_HINT}
                  describedBy="both-play-popularity-hint"
                  active={sortBy === "playPopularity"}
                  dir={sortDir}
                  onSort={() => onSort("playPopularity")}
                />
                <SortableTh
                  label="Play rank"
                  className="num col-middle"
                  active={sortBy === "playRank"}
                  dir={sortDir}
                  onSort={() => onSort("playRank")}
                />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.key} data-keyword={row.key}>
                  <td className="col-keyword">
                    <span className="keyword-cell-label">{row.keyword}</span>
                  </td>
                  {row.ios ? (
                    <>
                      <td className="num col-middle">
                        <span className="store-metric">
                          <MetricBar value={row.ios.popularity} tone="popularity" />
                          <PopularityTrend change={row.ios.popularityChange} />
                        </span>
                      </td>
                      <td className="num col-middle">
                        <RankCell
                          side={row.ios}
                          available={props.iosHasRank}
                          unrankedLabel="Not ranked"
                        />
                      </td>
                    </>
                  ) : (
                    notTracked(row, "ios")
                  )}
                  {row.play ? (
                    <>
                      <td className="col-middle">
                        <PlayPopularityCell side={row.play} />
                      </td>
                      <td className="num col-middle">
                        <RankCell side={row.play} available unrankedLabel="Not in top 30" />
                      </td>
                    </>
                  ) : (
                    notTracked(row, "play")
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && visibleRows.length === 0 ? (
          <p className="empty">
            {rows.length === 0
              ? `No keywords tracked in ${country} on either store.`
              : "No keywords match the search."}
          </p>
        ) : null}
        {loading ? <p className="empty">Loading keywords...</p> : null}
      </Card>
    </>
  );
}
