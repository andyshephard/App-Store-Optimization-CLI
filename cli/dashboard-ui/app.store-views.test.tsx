/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";

const IOS_APP_ID = "6692632196";
const PLAY_APP_ID = "com.andyshephard.chunks";
const STORE_MODE_KEY = "aso-dashboard:store-mode";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function setupMatchMediaMock(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

function paged(items: unknown[]) {
  return {
    items,
    page: 1,
    pageSize: 500,
    totalCount: items.length,
    totalPages: 1,
    hasPrevPage: false,
    hasNextPage: false,
    associatedCount: items.length,
    failedCount: 0,
    pendingCount: 0,
  };
}

function iosItem(keyword: string, popularity: number, current: number | null, previous: number | null) {
  return {
    keyword,
    popularity,
    difficultyScore: 30,
    appCount: 200,
    keywordStatus: "ok",
    orderedAppIds: [],
    updatedAt: "2026-10-30T00:00:00.000Z",
    positions: [{ appId: IOS_APP_ID, currentPosition: current, previousPosition: previous }],
  };
}

function playItem(keyword: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: "android",
    keyword,
    normalizedKeyword: keyword,
    country: "US",
    appId: PLAY_APP_ID,
    popularity: null,
    autocompleteLetters: 6,
    autocompleteRank: 3,
    autocompleteCheckedAt: "2026-10-29T00:00:00.000Z",
    difficultyScore: 36,
    difficultyModelVersion: "play-installs-v1",
    appCount: 30,
    resultCount: 30,
    rankDepth: 30,
    layout: "list",
    rank: 6,
    previousRank: 7,
    rankChange: -1,
    orderedAppIds: [],
    competitorRanks: {},
    isFavorite: false,
    addedAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    keywordStatus: "ok",
    failure: null,
    positions: [],
    ...overrides,
  };
}

function buildFetchMock(params: { playAppId?: string }) {
  const writes: Array<{ method: string; body: any }> = [];
  const playItems = [
    playItem("microlearning"),
    playItem("audio stories", { rank: null, previousRank: 12, rankChange: null, autocompleteLetters: null }),
    playItem("chunks", {
      rank: 1,
      rankChange: 0,
      keywordStatus: "failed",
      failure: { stage: "search", reasonCode: "HTTP_429", message: "Too many requests", attempts: 3 },
    }),
  ];
  const iosItems = [iosItem("microlearning", 40, 24, 30), iosItem("stoicism", 55, 9, 9)];

  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const [pathname, search = ""] = url.split("?");
    const query = new URLSearchParams(search);
    if (method !== "GET") {
      writes.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse(201, { success: true, data: { addedCount: 1, refreshStarted: true } });
    }
    switch (pathname) {
      case "/api/aso/storefronts":
        return jsonResponse(200, {
          success: true,
          data: {
            storefronts: [
              { country: "US", name: "United States", isDefault: true },
              { country: "GB", name: "United Kingdom", isDefault: false },
            ],
            defaultCountry: "US",
            playCountries: [
              { country: "US", name: "United States", language: "en" },
              { country: "GB", name: "United Kingdom", language: "en" },
            ],
            ...(params.playAppId ? { playAppId: params.playAppId } : {}),
          },
        });
      case "/api/apps":
        return jsonResponse(200, {
          success: true,
          data: [{ id: IOS_APP_ID, kind: "owned", name: "Chunks" }],
        });
      case "/api/aso/keywords":
        return jsonResponse(200, {
          success: true,
          data: paged(query.get("platform") === "android" ? playItems : iosItems),
        });
      case "/api/aso/position-history":
        return jsonResponse(200, {
          success: true,
          data: {
            items: [
              { appId: PLAY_APP_ID, keyword: "microlearning", country: "US", date: "2026-10-28", position: 8 },
              { appId: PLAY_APP_ID, keyword: "microlearning", country: "GB", date: "2026-10-28", position: 2 },
              { appId: PLAY_APP_ID, keyword: "microlearning", country: "US", date: "2026-10-29", position: null },
              { appId: PLAY_APP_ID, keyword: "microlearning", country: "US", date: "2026-10-30", position: 6 },
            ],
            hasNextPage: false,
          },
        });
      case "/api/dashboard/settings":
        return jsonResponse(200, {
          success: true,
          data: { includeResearchAppsInKeywordRefresh: true, refreshMode: "manual" },
        });
      case "/api/aso/refresh-status":
        return jsonResponse(200, {
          success: true,
          data: {
            status: "idle",
            startedAt: null,
            finishedAt: null,
            lastError: null,
            requiresReauthentication: false,
            counters: { eligibleKeywordCount: 0, refreshedKeywordCount: 0, failedKeywordCount: 0 },
          },
        });
      case "/api/aso/auth/status":
      case "/api/aso/setup/status":
        return jsonResponse(200, {
          success: true,
          data: { status: "idle", updatedAt: null, lastError: null, requiresTerminalAction: false, canPrompt: true },
        });
      case "/api/aso/apps":
        return jsonResponse(200, { success: true, data: [] });
      default:
        return jsonResponse(404, { success: false, error: `Unhandled ${pathname}` });
    }
  });
  return { fetchMock, writes };
}

function rowFor(table: HTMLElement, keyword: string): HTMLElement {
  const row = within(table)
    .getAllByRole("row")
    .find((entry) => entry.getAttribute("data-keyword") === keyword);
  if (!row) throw new Error(`no row for ${keyword}`);
  return row;
}

describe("dashboard store views", () => {
  beforeEach(() => {
    setupMatchMediaMock();
    localStorage.clear();
    localStorage.setItem("aso-dashboard:selected-app-id", IOS_APP_ID);
  });

  it("shows no store toggle when the server has no Google Play app", async () => {
    const { fetchMock } = buildFetchMock({});
    global.fetch = fetchMock as typeof fetch;
    localStorage.setItem(STORE_MODE_KEY, "android");

    render(<App />);

    await screen.findByRole("tab", { name: /Chunks/ });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/aso/storefronts", expect.anything()));
    expect(screen.queryByRole("group", { name: "Store" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Google Play keywords" })).not.toBeInTheDocument();
    expect(document.getElementById("add-keywords")).toBeVisible();
  });

  it("switches to Google Play, remembers it, and renders the Play table", async () => {
    const { fetchMock } = buildFetchMock({ playAppId: PLAY_APP_ID });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const toggle = await screen.findByRole("group", { name: "Store" });
    expect(within(toggle).getByRole("button", { name: "App Store" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(toggle).getByRole("button", { name: "Google Play" }));
    expect(localStorage.getItem(STORE_MODE_KEY)).toBe("android");

    const table = await screen.findByRole("table", { name: "Google Play keywords" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith("/api/aso/keywords?platform=android&country=US")
      )
    ).toBe(true);

    const micro = rowFor(table, "microlearning");
    expect(within(micro).getByText("letters", { exact: false })).toHaveTextContent("6 letters · #3");
    expect(within(micro).getByText("↑1")).toBeInTheDocument();
    expect(within(rowFor(table, "audio stories")).getByText("Not in top 30")).toBeInTheDocument();
    expect(within(rowFor(table, "audio stories")).getByText("Not suggested")).toBeInTheDocument();
    expect(within(rowFor(table, "chunks")).getByText("HTTP_429")).toBeInTheDocument();
    // The App Store view is kept, hidden.
    expect(document.getElementById("add-keywords")).not.toBeVisible();
  });

  it("adds and removes Play keywords with platform android", async () => {
    localStorage.setItem(STORE_MODE_KEY, "android");
    const { fetchMock, writes } = buildFetchMock({ playAppId: PLAY_APP_ID });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByLabelText("Add Google Play keywords", { selector: "input" });
    fireEvent.change(input, { target: { value: "Stoic, history timeline" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: "POST",
      body: { platform: "android", country: "US", keywords: ["stoic", "history timeline"] },
    });

    const table = await screen.findByRole("table", { name: "Google Play keywords" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Remove microlearning from Google Play" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete keywords?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      method: "DELETE",
      body: { platform: "android", country: "US", keywords: ["microlearning"] },
    });
  });

  it("charts Play position history for the row's keyword and country", async () => {
    localStorage.setItem(STORE_MODE_KEY, "android");
    const { fetchMock } = buildFetchMock({ playAppId: PLAY_APP_ID });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Google Play position history for microlearning" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Google Play position history for microlearning",
    });
    await within(dialog).findByText("Best rank:", { exact: false });
    expect(within(dialog).getByText("Best rank:", { exact: false })).toHaveTextContent("Best rank: 6");
    expect(within(dialog).getByText("Worst rank:", { exact: false })).toHaveTextContent("Worst rank: 8");
    expect(within(dialog).getByText("Days outside the top 30:", { exact: false })).toHaveTextContent(
      "Days outside the top 30: 1"
    );
    const historyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/aso/position-history")
    );
    expect(String(historyCall?.[0])).toContain(`platform=android&appIds=${PLAY_APP_ID}`);
  });

  it("merges both stores into one row per keyword and tracks on the missing store", async () => {
    localStorage.setItem(STORE_MODE_KEY, "both");
    const { fetchMock, writes } = buildFetchMock({ playAppId: PLAY_APP_ID });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const table = await screen.findByRole("table", { name: "Keywords on both stores" });
    // microlearning (both), stoicism (iOS only), audio stories and chunks (Play only).
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(5));

    const micro = rowFor(table, "microlearning");
    expect(within(micro).getByText("24")).toBeInTheDocument();
    expect(within(micro).getByText("↑6")).toBeInTheDocument();
    expect(within(micro).getByText("↑1")).toBeInTheDocument();
    expect(within(micro).queryByText("Not tracked")).not.toBeInTheDocument();

    const stoicism = rowFor(table, "stoicism");
    expect(within(stoicism).getByText("Not tracked")).toBeInTheDocument();
    fireEvent.click(within(stoicism).getByRole("button", { name: "Track stoicism on Google Play" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ platform: "android", country: "US", keywords: ["stoicism"] });

    const trackChunks = within(rowFor(table, "chunks")).getByRole("button", {
      name: "Track chunks on App Store",
    });
    // Track buttons are disabled while the previous one reloads the table.
    await waitFor(() => expect(trackChunks).toBeEnabled());
    fireEvent.click(trackChunks);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toEqual({
      appId: IOS_APP_ID,
      country: "US",
      keywords: ["chunks"],
      defer: true,
    });
  });

  it("sorts the Both view by Play rank with untracked keywords last", async () => {
    localStorage.setItem(STORE_MODE_KEY, "both");
    const { fetchMock } = buildFetchMock({ playAppId: PLAY_APP_ID });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const table = await screen.findByRole("table", { name: "Keywords on both stores" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(5));
    fireEvent.click(within(table).getByRole("button", { name: /Play rank/ }));
    const order = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("data-keyword"));
    expect(order()).toEqual(["chunks", "microlearning", "audio stories", "stoicism"]);
    expect(within(table).getByRole("columnheader", { name: /Play rank/ })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
    fireEvent.click(within(table).getByRole("button", { name: /Play rank/ }));
    expect(order()).toEqual(["microlearning", "chunks", "audio stories", "stoicism"]);
  });
});
