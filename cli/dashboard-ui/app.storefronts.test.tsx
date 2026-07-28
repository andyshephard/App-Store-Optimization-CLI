/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";

const STOREFRONT_STORAGE_KEY = "aso-dashboard:storefront";

type Storefront = { country: string; name: string; isDefault: boolean };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
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

function emptyKeywordPayload() {
  return {
    items: [],
    page: 1,
    pageSize: 100,
    totalCount: 0,
    totalPages: 1,
    hasPrevPage: false,
    hasNextPage: false,
    associatedCount: 0,
    failedCount: 0,
    pendingCount: 0,
  };
}

/**
 * Minimal mock that records the storefront each data route was called with.
 * Any storefront outside `enabledStorefronts` answers 400 the way the server
 * does, so a stale persisted selection is exercised for real.
 */
function buildFetchMock(params: { storefronts: Storefront[] }) {
  const enabled = new Set(params.storefronts.map((entry) => entry.country));
  const appsCountries: string[] = [];
  const keywordCountries: string[] = [];

  const rejectDisabled = (country: string) =>
    enabled.has(country)
      ? null
      : jsonResponse(400, {
          success: false,
          errorCode: "COUNTRY_NOT_ENABLED",
          error: `Storefront ${country} is not enabled.`,
        });

  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const [pathname, search = ""] = url.split("?");
      const query = new URLSearchParams(search);

      if (method === "GET" && pathname === "/api/aso/storefronts") {
        return jsonResponse(200, {
          success: true,
          data: {
            storefronts: params.storefronts,
            defaultCountry: "US",
          },
        });
      }

      if (method === "GET" && pathname === "/api/apps") {
        const country = query.get("country") ?? "";
        appsCountries.push(country);
        const rejected = rejectDisabled(country);
        if (rejected) return rejected;
        return jsonResponse(200, {
          success: true,
          data: [
            { id: DEFAULT_RESEARCH_APP_ID, kind: "research", name: "Research" },
          ],
        });
      }

      if (method === "GET" && pathname === "/api/aso/keywords") {
        const country = query.get("country") ?? "";
        keywordCountries.push(country);
        const rejected = rejectDisabled(country);
        if (rejected) return rejected;
        return jsonResponse(200, { success: true, data: emptyKeywordPayload() });
      }

      if (method === "GET" && pathname === "/api/dashboard/settings") {
        return jsonResponse(200, {
          success: true,
          data: {
            includeResearchAppsInKeywordRefresh: true,
            refreshMode: "manual",
          },
        });
      }

      if (method === "GET" && pathname === "/api/aso/refresh-status") {
        return jsonResponse(200, {
          success: true,
          data: {
            status: "idle",
            startedAt: null,
            finishedAt: null,
            lastError: null,
            requiresReauthentication: false,
            counters: {
              eligibleKeywordCount: 0,
              refreshedKeywordCount: 0,
              failedKeywordCount: 0,
            },
          },
        });
      }

      if (
        method === "GET" &&
        (pathname === "/api/aso/auth/status" ||
          pathname === "/api/aso/setup/status")
      ) {
        return jsonResponse(200, {
          success: true,
          data: {
            status: "idle",
            updatedAt: null,
            lastError: null,
            requiresTerminalAction: false,
            canPrompt: true,
          },
        });
      }

      if (method === "GET" && pathname === "/api/aso/apps") {
        return jsonResponse(200, { success: true, data: [] });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    }
  );

  return { fetchMock, appsCountries, keywordCountries };
}

describe("dashboard storefront selector", () => {
  beforeEach(() => {
    setupMatchMediaMock();
    localStorage.clear();
  });

  it("hides the selector when only one storefront is enabled", async () => {
    const { fetchMock } = buildFetchMock({
      storefronts: [{ country: "US", name: "United States", isDefault: true }],
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByRole("tab", { name: "Research" });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aso/storefronts",
        expect.anything()
      )
    );
    expect(screen.queryByLabelText("Storefront")).not.toBeInTheDocument();
  });

  it("switches storefront, refetches with it, and persists the choice", async () => {
    const { fetchMock, appsCountries, keywordCountries } = buildFetchMock({
      storefronts: [
        { country: "US", name: "United States", isDefault: true },
        { country: "GB", name: "United Kingdom", isDefault: false },
      ],
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const select = (await screen.findByLabelText(
      "Storefront"
    )) as HTMLSelectElement;
    expect(select.value).toBe("US");
    await waitFor(() => expect(keywordCountries).toContain("US"));

    fireEvent.change(select, { target: { value: "GB" } });

    await waitFor(() => expect(appsCountries).toContain("GB"));
    await waitFor(() => expect(keywordCountries).toContain("GB"));
    expect(localStorage.getItem(STOREFRONT_STORAGE_KEY)).toBe("GB");
  });

  it("recovers when the persisted storefront is no longer enabled", async () => {
    localStorage.setItem(STOREFRONT_STORAGE_KEY, "DE");
    const { fetchMock, appsCountries } = buildFetchMock({
      storefronts: [{ country: "US", name: "United States", isDefault: true }],
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    // The first load uses the persisted storefront and is rejected; the app
    // then falls back to an enabled one and reloads.
    await waitFor(() => expect(appsCountries).toContain("DE"));
    await waitFor(() => expect(appsCountries).toContain("US"));
    await screen.findByRole("tab", { name: "Research" });
    expect(localStorage.getItem(STOREFRONT_STORAGE_KEY)).toBe("US");
  });
});
