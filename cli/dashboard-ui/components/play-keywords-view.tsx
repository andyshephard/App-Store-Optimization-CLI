import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Input } from "../ui-react";
import {
  copyTextToClipboard,
  countryFlagEmoji,
  formatDate,
  toActionableErrorMessage,
} from "../app-helpers";
import { sanitizeKeywords } from "../../domain/keywords/policy";
import { ASO_MAX_KEYWORDS, ASO_MAX_KEYWORDS_PER_REQUEST_ERROR } from "../../shared/aso-keyword-limits";
import type { PlayCountryOption } from "../hooks/use-storefronts";
import { addPlayKeywords, fetchPlayKeywords, removePlayKeywords } from "../store-api";
import type { PlayKeywordItem } from "../store-merge";
import { ContextDeleteConfirm } from "./context-delete-confirm";
import { KeywordActionMenu } from "./keyword-action-menu";
import { MetricBar } from "./metric-bar";
import { PlayPositionHistoryDialog } from "./play-position-history-dialog";
import { SortableTh } from "./sortable-th";
import { StatusBanners } from "./status-banners";

export const PLAY_POPULARITY_HINT =
  "Google Play publishes no search volume. Popularity here is how few letters you " +
  "have to type before Play suggests the keyword, and its position in the " +
  "suggestions: fewer letters means more people search for it.";

/** Pending rows are crawled in the background; re-read until they land. */
const PENDING_POLL_MS = 15000;
const MENU_SIZE = { width: 190, height: 96 };
const CONFIRM_SIZE = { width: 300, height: 156 };

type SortKey = "keyword" | "popularity" | "difficulty" | "rank" | "change" | "updatedAt";
type SortDir = "asc" | "desc";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  keyword: "asc",
  popularity: "asc",
  difficulty: "asc",
  rank: "asc",
  change: "asc",
  updatedAt: "desc",
};

const LAYOUT_LABEL: Record<string, string> = {
  list: "List",
  "top-card": "Top card",
  empty: "No results",
};

function sortValue(item: PlayKeywordItem, key: SortKey): number | string | null {
  switch (key) {
    case "popularity":
      return item.autocompleteLetters;
    case "difficulty":
      return item.difficultyScore;
    case "rank":
      return item.rank;
    case "change":
      return item.rankChange;
    case "updatedAt":
      return item.updatedAt;
    default:
      return item.normalizedKeyword;
  }
}

export function sortPlayItems(items: PlayKeywordItem[], key: SortKey, dir: SortDir) {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    const byKeyword = a.normalizedKeyword.localeCompare(b.normalizedKeyword);
    if (va == null && vb == null) return byKeyword;
    if (va == null) return 1;
    if (vb == null) return -1;
    const compared =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return sign * compared || byKeyword;
  });
}

function clamp(x: number, y: number, size: { width: number; height: number }) {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - size.width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - size.height - 8)),
  };
}

function PopularityCell({ item }: { item: PlayKeywordItem }) {
  if (item.autocompleteLetters == null) {
    return item.autocompleteCheckedAt == null ? (
      <span className="metric-pending" title="Autocomplete is checked over the week after adding">
        Not checked yet
      </span>
    ) : (
      <span className="metric-empty" title="Play never suggested it, even with the whole word typed">
        Not suggested
      </span>
    );
  }
  const letters = item.autocompleteLetters;
  const position = item.autocompleteRank;
  return (
    <span
      className="play-popularity"
      title={`Play suggests it after ${letters} letter${letters === 1 ? "" : "s"}${
        position != null ? `, as suggestion ${position}` : ""
      }`}
    >
      <strong>{letters}</strong> letter{letters === 1 ? "" : "s"}
      {position != null ? <span className="play-popularity-rank"> · #{position}</span> : null}
    </span>
  );
}

export function RankChange({ change }: { change: number | null }) {
  if (change == null) return <span className="metric-empty">-</span>;
  if (change === 0) return <span className="delta same">0</span>;
  return change < 0 ? (
    <span className="delta up" title={`Up ${Math.abs(change)}`}>
      ↑{Math.abs(change)}
    </span>
  ) : (
    <span className="delta down" title={`Down ${change}`}>
      ↓{change}
    </span>
  );
}

type Props = {
  country: string;
  countries: PlayCountryOption[];
  onCountryChange: (country: string) => void;
  playAppId: string;
  displayLocale?: string;
};

export function PlayKeywordsView(props: Props) {
  const { country, playAppId, displayLocale } = props;
  const [items, setItems] = useState<PlayKeywordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyText, setBusyText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");
  const [addInput, setAddInput] = useState("");
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("keyword");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [historyKeyword, setHistoryKeyword] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; keyword: string } | null>(null);
  const [confirm, setConfirm] = useState<{ x: number; y: number; keyword: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchPlayKeywords(country);
      setItems(next);
      setErrorText("");
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to load Google Play keywords"));
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    void load();
  }, [load]);

  const pendingCount = items.filter((item) => item.keywordStatus === "pending").length;
  const failedCount = items.filter((item) => item.keywordStatus === "failed").length;

  useEffect(() => {
    if (pendingCount === 0) return;
    const timer = window.setTimeout(() => void load(), PENDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [load, pendingCount, items]);

  useEffect(() => {
    if (!menu && !confirm) return;
    const close = () => {
      setMenu(null);
      setConfirm(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [menu, confirm]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = needle
      ? items.filter((item) => item.normalizedKeyword.includes(needle))
      : items;
    return sortPlayItems(visible, sortBy, sortDir);
  }, [filter, items, sortBy, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const onAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const keywords = sanitizeKeywords(addInput.split(","));
    if (keywords.length === 0) return;
    if (keywords.length > ASO_MAX_KEYWORDS) {
      setErrorText(ASO_MAX_KEYWORDS_PER_REQUEST_ERROR);
      return;
    }
    setErrorText("");
    setSuccessText("");
    setBusyText(`Adding ${keywords.length} keyword${keywords.length === 1 ? "" : "s"}...`);
    try {
      const result = await addPlayKeywords(country, keywords);
      setAddInput("");
      setSuccessText(
        result.addedCount === 0
          ? "Already tracked on Google Play."
          : result.refreshStarted
            ? `Added ${result.addedCount}. Checking Google Play now...`
            : `Added ${result.addedCount}. They are checked on the next refresh.`
      );
      await load();
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to add Google Play keywords"));
    } finally {
      setBusyText("");
    }
  };

  const onDelete = async (keyword: string) => {
    setConfirm(null);
    setErrorText("");
    setSuccessText("");
    setBusyText("Deleting 1 keyword...");
    try {
      await removePlayKeywords(country, [keyword]);
      setSuccessText(`Deleted "${keyword}" from Google Play.`);
      await load();
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to delete keywords"));
    } finally {
      setBusyText("");
    }
  };

  const openConfirm = (keyword: string, x: number, y: number) => {
    setMenu(null);
    setConfirm({ keyword, ...clamp(x, y, CONFIRM_SIZE) });
  };

  const isBusy = busyText !== "";

  return (
    <>
      <Card className="add-card">
        <form className="add-form" onSubmit={onAdd} aria-label="Add Google Play keywords">
          <div className="add-keywords-slot store-add-slot">
            <Input
              id="play-add-keywords"
              type="text"
              className="store-add-input"
              placeholder="Add Google Play keywords (comma-separated)"
              aria-label="Add Google Play keywords"
              value={addInput}
              onChange={(event) => setAddInput(event.target.value)}
            />
          </div>
          <Button id="play-add-submit" type="submit" disabled={isBusy || addInput.trim() === ""}>
            Add
          </Button>
          <StatusBanners
            idPrefix="play-"
            showLoading={isBusy}
            loadingText={busyText}
            showError={!isBusy && errorText !== ""}
            errorText={errorText}
            showSuccess={!isBusy && errorText === "" && successText !== ""}
            successText={successText}
          />
        </form>
      </Card>

      <Card className="top-toolbar store-toolbar">
        <label className="store-country">
          <span className="sr-only">Google Play country</span>
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
        <span className="store-app-id" title="Google Play package (ASO_PLAY_APP_ID)">
          {playAppId}
        </span>
        <Input
          type="search"
          className="store-filter"
          placeholder="Search"
          aria-label="Search Google Play keywords"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Badge>
          {items.length} keyword{items.length === 1 ? "" : "s"}
          {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
          {failedCount > 0 ? ` · ${failedCount} failed` : ""}
        </Badge>
      </Card>

      <Card className="table-card">
        <span id="play-popularity-hint" hidden>
          {PLAY_POPULARITY_HINT}
        </span>
        <div className="table-wrap">
          <table className="store-table play-table" aria-label="Google Play keywords">
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
                  label={
                    <>
                      Popularity <span aria-hidden="true">ⓘ</span>
                    </>
                  }
                  className="col-middle"
                  title={PLAY_POPULARITY_HINT}
                  describedBy="play-popularity-hint"
                  active={sortBy === "popularity"}
                  dir={sortDir}
                  onSort={() => onSort("popularity")}
                />
                <SortableTh
                  label="Difficulty"
                  className="num col-middle"
                  title="Play difficulty (play-installs-v1): compare Play keywords with each other, not with App Store difficulty"
                  active={sortBy === "difficulty"}
                  dir={sortDir}
                  onSort={() => onSort("difficulty")}
                />
                <SortableTh
                  label="Rank"
                  className="num col-middle"
                  active={sortBy === "rank"}
                  dir={sortDir}
                  onSort={() => onSort("rank")}
                />
                <SortableTh
                  label="Change"
                  className="col-middle"
                  active={sortBy === "change"}
                  dir={sortDir}
                  onSort={() => onSort("change")}
                />
                <th className="col-middle">Results</th>
                <SortableTh
                  label="Updated"
                  active={sortBy === "updatedAt"}
                  dir={sortDir}
                  onSort={() => onSort("updatedAt")}
                />
                <th>Failures</th>
                <th className="col-middle">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const crawled = item.updatedAt != null;
                return (
                  <tr
                    key={item.normalizedKeyword}
                    data-keyword={item.keyword}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setConfirm(null);
                      setMenu({
                        keyword: item.keyword,
                        ...clamp(event.clientX, event.clientY, MENU_SIZE),
                      });
                    }}
                  >
                    <td className="col-keyword">
                      <span className="keyword-cell-label">{item.keyword}</span>
                    </td>
                    <td className="col-middle">
                      <PopularityCell item={item} />
                    </td>
                    <td className="num col-middle">
                      {item.keywordStatus === "failed" && item.difficultyScore == null ? (
                        <span className="metric-empty">-</span>
                      ) : item.difficultyScore == null ? (
                        <span className="metric-pending">Calculating...</span>
                      ) : (
                        <MetricBar value={item.difficultyScore} tone="difficulty" />
                      )}
                    </td>
                    <td className="num col-middle">
                      {!crawled ? (
                        <span className="metric-pending">Pending</span>
                      ) : (
                        <button
                          type="button"
                          className="rank-history-trigger"
                          aria-label={`Google Play position history for ${item.keyword}`}
                          title={
                            item.rank == null && item.resultCount != null && item.resultCount < 30
                              ? `Play listed only ${item.resultCount} results`
                              : "Show position history"
                          }
                          onClick={() => setHistoryKeyword(item.keyword)}
                        >
                          {item.rank ?? <span className="metric-empty">Not in top 30</span>}
                        </button>
                      )}
                    </td>
                    <td className="col-middle">
                      <RankChange change={item.rankChange} />
                    </td>
                    <td className="col-middle">
                      {item.layout == null
                        ? "-"
                        : `${LAYOUT_LABEL[item.layout] ?? item.layout}${
                            item.resultCount != null && item.layout !== "empty"
                              ? ` · ${item.resultCount}`
                              : ""
                          }`}
                    </td>
                    <td className="updated-value">{formatDate(item.updatedAt ?? undefined, displayLocale)}</td>
                    <td>
                      {item.failure ? (
                        <span
                          className="play-failure"
                          title={[
                            item.failure.message,
                            item.failure.attempts ? `${item.failure.attempts} attempts` : null,
                            item.failure.updatedAt
                              ? `last ${formatDate(item.failure.updatedAt, displayLocale)}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          {item.failure.reasonCode}
                        </span>
                      ) : (
                        <span className="metric-empty">-</span>
                      )}
                    </td>
                    <td className="col-middle">
                      <button
                        type="button"
                        className="store-row-remove"
                        aria-label={`Remove ${item.keyword} from Google Play`}
                        title="Remove"
                        disabled={isBusy}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          openConfirm(item.keyword, rect.left - CONFIRM_SIZE.width, rect.bottom + 4);
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 ? (
          <p className="empty">
            {items.length === 0
              ? `No Google Play keywords tracked in ${country} yet. Add some above.`
              : "No keywords match the search."}
          </p>
        ) : null}
        {loading ? <p className="empty">Loading Google Play keywords...</p> : null}
      </Card>

      {menu ? (
        <KeywordActionMenu
          x={menu.x}
          y={menu.y}
          onCopy={() => {
            void copyTextToClipboard(menu.keyword);
            setMenu(null);
          }}
          onDelete={() => openConfirm(menu.keyword, menu.x, menu.y)}
        />
      ) : null}
      {confirm ? (
        <ContextDeleteConfirm
          x={confirm.x}
          y={confirm.y}
          title="Delete keywords?"
          message={`Delete "${confirm.keyword}" from Google Play (${country})?`}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void onDelete(confirm.keyword)}
        />
      ) : null}
      {historyKeyword ? (
        <PlayPositionHistoryDialog
          keyword={historyKeyword}
          country={country}
          appId={items.find((item) => item.keyword === historyKeyword)?.appId ?? playAppId}
          displayLocale={displayLocale}
          onClose={() => setHistoryKeyword(null)}
        />
      ) : null}
    </>
  );
}
