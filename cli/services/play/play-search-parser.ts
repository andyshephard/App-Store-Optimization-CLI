/**
 * Google Play search page parser.
 *
 * `play.google.com/store/search?q=&c=apps` is server-rendered: its data sits
 * in `AF_initDataCallback({key: 'ds:N', ..., data: <json>, sideChannel: {}})`
 * script blocks. The results block (`ds:4` today) holds `data[0][1]`, a list
 * of sections in page order. Seen on 2026-10-30:
 *
 * - **Organic list**: `section[22][0]` is the result list, one `[app, ...]`
 *   item per result. Its `section[3]` token names the cluster
 *   `search_results_cluster_apps_range_<from>_<to>` (0-based, end exclusive),
 *   so `to - from` is the item count and `from` where it starts in the ranking.
 * - **Top-result card** (e.g. "stoic", "history timeline"): a section whose
 *   `section[23][16][2]` is an app-details record, followed by the organic list
 *   as `..._range_1_<to>`. The card is rank 1.
 * - **No results**: a `zero_results_cluster` section and no list.
 *
 * Play shows at most 30 results with no further page, so ranks are 1-30.
 * Anything that does not fit these shapes throws PlayContractError rather
 * than returning ranks that might be wrong: an app list without a range label
 * (a "you might also like"-style cluster) is excluded, and a page with only
 * such lists, an inconsistent range, or a second top card is a contract
 * failure.
 */

export const PLAY_MAX_RESULTS = 30;

export type PlaySearchApp = {
  appId: string;
  title: string;
  developer: string | null;
  category: string | null;
  /** Lower bound of the install band, e.g. 5000 for "5,000+". */
  installs: number | null;
  installsBand: string | null;
  rating: number | null;
  /** Only the top-result card carries a rating count. */
  ratingCount: number | null;
  free: boolean | null;
  isTopCard: boolean;
};

export type PlaySearchLayout = "list" | "top-card" | "empty";

export type PlaySearchParseResult = {
  layout: PlaySearchLayout;
  /** Ranked results, rank = index + 1, at most PLAY_MAX_RESULTS. */
  apps: PlaySearchApp[];
  /** Apps in unlabelled clusters that were left out of the ranking. */
  excludedClusterApps: number;
};

export class PlayContractError extends Error {
  readonly code = "PLAY_CONTRACT_CHANGED";
  constructor(
    readonly signal: string,
    message: string
  ) {
    super(message);
    this.name = "PlayContractError";
  }
}

/** Longest keyword accepted for Play tracking. */
export const PLAY_MAX_KEYWORD_LENGTH = 100;

/** A Play package name (e.g. com.andyshephard.chunks). */
export const PACKAGE_ID = /^[A-Za-z][\w]*(\.[\w]+)+$/;
const RANGE_LABEL = /search_results_cluster_apps_range_(\d+)_(\d+)/;
const TOP_CARD_LABEL = /apps_mdp_search_results_cluster_([A-Za-z][\w.]*)/;
const ZERO_LABEL = /zero_results_cluster/;
const DETAILS_ID = /details\?id=([A-Za-z][\w]*(?:\.[\w]+)+)/;

/** Every `ds:N` data block on the page; a block that fails to parse maps to undefined. */
export function extractPlayDataBlocks(html: string): Map<string, unknown> {
  const blocks = new Map<string, unknown>();
  const re =
    /AF_initDataCallback\(\{key: '(ds:\d+)'[\s\S]*?data:([\s\S]*?), sideChannel: \{\}\}\);<\/script/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      blocks.set(match[1], JSON.parse(match[2]));
    } catch {
      blocks.set(match[1], undefined);
    }
  }
  return blocks;
}

function at(value: unknown, ...path: number[]): unknown {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** "5,000+" -> 5000, "100K+" -> 100000, "1M+" -> 1000000; null when unrecognised. */
export function parseInstallBand(band: string | null | undefined): number | null {
  if (!band) return null;
  const match = /^\s*([\d.,]+)\s*([KMB])?\+?\s*$/i.exec(band);
  if (!match) return null;
  const multiplier =
    { K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  const digits = multiplier === 1 ? match[1].replace(/[.,]/g, "") : match[1].replace(/,/g, "");
  const value = Number(digits);
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

/** Text a section is labelled with: its token, plain and base64-decoded. */
function sectionLabel(section: unknown[]): string {
  const token = section[3];
  if (token == null) return "";
  let label = JSON.stringify(token);
  const encoded = at(token, 0);
  if (typeof encoded === "string") {
    try {
      label += ` ${Buffer.from(encoded, "base64").toString("latin1")}`;
    } catch {
      // Not base64; the plain text above is all there is.
    }
  }
  return label;
}

function parseOrganicItem(item: unknown, keyword: string): PlaySearchApp {
  const app = at(item, 0);
  const appId = at(app, 0, 0);
  const title = at(app, 3);
  if (typeof appId !== "string" || !PACKAGE_ID.test(appId) || typeof title !== "string") {
    throw new PlayContractError(
      "item_shape",
      `Play search for "${keyword}": a result item has no package id / title at [0][0][0] / [0][3]`
    );
  }
  const installsBand = asString(at(app, 15));
  const priceMicros = asNumber(at(app, 8, 1, 0, 0));
  return {
    appId,
    title,
    developer: asString(at(app, 14)),
    category: asString(at(app, 5)),
    installs: parseInstallBand(installsBand),
    installsBand,
    rating: asNumber(at(app, 4, 1)),
    ratingCount: null,
    free: priceMicros == null ? null : priceMicros === 0,
    isTopCard: false,
  };
}

function parseTopCard(details: unknown[], labelAppId: string | null, keyword: string): PlaySearchApp {
  const title = asString(at(details, 0, 0));
  const urlMatch = DETAILS_ID.exec(JSON.stringify(at(details, 41) ?? at(details, 57) ?? ""));
  const appId = urlMatch?.[1] ?? null;
  if (!title || !appId || (labelAppId && labelAppId !== appId)) {
    throw new PlayContractError(
      "top_card_shape",
      `Play search for "${keyword}": top-result card without a consistent package id / title`
    );
  }
  const installsBand = asString(at(details, 13, 0));
  const priceMicros = asNumber(at(details, 57, 0, 0, 0, 0, 1, 0, 0));
  return {
    appId,
    title,
    developer: asString(at(details, 68, 0)),
    category: asString(at(details, 79, 0, 0, 0)),
    installs: asNumber(at(details, 13, 1)) ?? parseInstallBand(installsBand),
    installsBand,
    rating: asNumber(at(details, 51, 0, 1)),
    ratingCount: asNumber(at(details, 51, 2, 1)),
    free: priceMicros == null ? null : priceMicros === 0,
    isTopCard: true,
  };
}

function findSections(blocks: Map<string, unknown>): unknown[] | null {
  const keys = ["ds:4", ...Array.from(blocks.keys()).filter((key) => key !== "ds:4")];
  for (const key of keys) {
    const sections = at(blocks.get(key), 0, 1);
    if (!Array.isArray(sections)) continue;
    const looksLikeResults = sections.some(
      (section) =>
        Array.isArray(section) &&
        (Array.isArray(at(section, 22, 0)) ||
          Array.isArray(at(section, 23, 16, 2)) ||
          ZERO_LABEL.test(sectionLabel(section)))
    );
    if (looksLikeResults) return sections;
  }
  return null;
}

export function parsePlaySearchPage(html: string, keyword: string): PlaySearchParseResult {
  const sections = findSections(extractPlayDataBlocks(html));
  if (!sections) {
    throw new PlayContractError(
      "no_result_sections",
      `Play search for "${keyword}": no data block with result sections`
    );
  }

  let topCard: PlaySearchApp | null = null;
  let zeroResults = false;
  let excludedClusterApps = 0;
  const organic: PlaySearchApp[] = [];
  let expectedStart: number | null = null;
  // Play labels a list by its page size ("0-30"), not its count; it can hold
  // fewer apps (seen with 29 under "0-30", 30 Oct 2026). A short list is
  // fine only as the last labelled range: after it, ranks would be ambiguous.
  let shortRange = false;

  for (const section of sections) {
    if (!Array.isArray(section)) continue;
    const label = sectionLabel(section);
    if (ZERO_LABEL.test(label)) zeroResults = true;

    const details = at(section, 23, 16, 2);
    if (Array.isArray(details)) {
      if (topCard || organic.length > 0) {
        throw new PlayContractError(
          "top_card_position",
          `Play search for "${keyword}": a top-result card after other results`
        );
      }
      topCard = parseTopCard(details, TOP_CARD_LABEL.exec(label)?.[1] ?? null, keyword);
      continue;
    }

    const items = at(section, 22, 0);
    if (!Array.isArray(items)) continue;
    const range = RANGE_LABEL.exec(label);
    if (!range) {
      // A cluster ("you might also like", "similar apps"): not part of the ranking.
      excludedClusterApps += items.length;
      continue;
    }
    const from = Number(range[1]);
    const to = Number(range[2]);
    const start = expectedStart ?? (topCard ? 1 : 0);
    if (shortRange || from !== start || items.length === 0 || items.length > to - from) {
      throw new PlayContractError(
        "range_mismatch",
        `Play search for "${keyword}": result range ${from}-${to} with ${items.length} items, expected to start at ${start}`
      );
    }
    for (const item of items) organic.push(parseOrganicItem(item, keyword));
    shortRange = items.length < to - from;
    expectedStart = to;
  }

  if (topCard == null && organic.length === 0) {
    if (zeroResults) return { layout: "empty", apps: [], excludedClusterApps };
    throw new PlayContractError(
      excludedClusterApps > 0 ? "only_unlabelled_clusters" : "no_results_or_marker",
      `Play search for "${keyword}": no ranked results and no no-results marker`
    );
  }
  if (topCard && organic.length === 0) {
    // The card is always followed by the labelled range_1_N list. Without it
    // (or with only an unlabelled list, which may well be the organic
    // results) ranking the card alone would record every other app as outside
    // the top 30.
    throw new PlayContractError(
      "top_card_without_list",
      `Play search for "${keyword}": a top-result card followed only by unlabelled results`
    );
  }
  const ranked = (topCard ? 1 : 0) + organic.length;
  if (excludedClusterApps > 0 && ranked < PLAY_MAX_RESULTS) {
    // A short labelled ranking plus an unlabelled list: the list may be the
    // rest of the ranking under a new label, not a "similar apps" cluster.
    throw new PlayContractError(
      "cluster_after_short_ranking",
      `Play search for "${keyword}": ${ranked} ranked results plus ${excludedClusterApps} unlabelled ones`
    );
  }
  if (zeroResults) {
    throw new PlayContractError(
      "results_with_zero_marker",
      `Play search for "${keyword}": ranked results alongside a no-results marker`
    );
  }
  const apps = (topCard ? [topCard, ...organic] : organic).slice(0, PLAY_MAX_RESULTS);
  return { layout: topCard ? "top-card" : "list", apps, excludedClusterApps };
}
