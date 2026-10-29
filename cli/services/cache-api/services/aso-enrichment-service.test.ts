import { jest } from "@jest/globals";
import {
  __resetIncompleteTopDocLookupCooldownForTests,
  enrichKeyword,
  refreshKeywordOrder,
  refreshKeywordOrdersBatch,
} from "./aso-enrichment-service";
import { asoAppleGet } from "./aso-apple-client";
import {
  fetchAppStoreLookupAppDocs,
  fetchItunesLookupAppDocs,
} from "./aso-app-doc-service";
import { fetchAppStoreAdditionalLocalizations } from "./aso-app-store-details";
import { logger } from "../../../utils/logger";

jest.mock("./aso-apple-client", () => ({
  asoAppleGet: jest.fn(),
}));

jest.mock("./aso-app-doc-service", () => ({
  fetchAppStoreLookupAppDocs: jest.fn(),
  fetchItunesLookupAppDocs: jest.fn(),
}));

jest.mock("./aso-app-store-details", () => ({
  fetchAppStoreLocalizedAppData: jest.fn(),
  fetchAppStoreAdditionalLocalizations: jest.fn(),
}));

jest.mock("./aso-keyword-utils", () => ({
  normalizeKeyword: jest.fn((value: string) => value.trim().toLowerCase()),
  normalizeTextForKeywordMatch: jest.fn((value: string) =>
    value.toLowerCase().trim()
  ),
  computeAppExpiryIsoForApp: jest.fn(() => "2099-01-01T00:00:00.000Z"),
}));
jest.mock("../../../utils/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedAsoAppleGet = jest.mocked(asoAppleGet);
const mockedFetchAppStoreLookupAppDocs = jest.mocked(fetchAppStoreLookupAppDocs);
const mockedFetchItunesLookupAppDocs = jest.mocked(fetchItunesLookupAppDocs);
const mockedFetchAppStoreAdditionalLocalizations = jest.mocked(
  fetchAppStoreAdditionalLocalizations
);
const mockedLogger = jest.mocked(logger);

function buildSearchHtml(): string {
  return buildSearchHtmlForIds(["1", "2", "3", "4", "5"]);
}

function buildSearchHtmlForIds(
  ids: string[],
  tailIds: string[] = [],
  options?: {
    developerNamesById?: Record<string, string>;
    ratingCountById?: Record<string, string | number>;
    kindsById?: Record<string, string>;
    resultTypesById?: Record<string, string>;
  }
): string {
  const items = ids.map((id, index) => ({
    ...(options?.kindsById?.[id] ? { $kind: options.kindsById[id] } : {}),
    ...(options?.resultTypesById?.[id]
      ? { resultType: options.resultTypesById[id] }
      : {}),
    lockup: {
      adamId: id,
      title: `App ${id}`,
      subtitle: `Sub ${id}`,
      rating: Math.max(1, 4.9 - index * 0.1),
      ratingCount: String(options?.ratingCountById?.[id] ?? `${(index + 1) * 1000}`),
      ...(options?.developerNamesById?.[id]
        ? { developerName: options.developerNamesById[id] }
        : {}),
    },
  }));
  return `<html><body><script id="serialized-server-data">${JSON.stringify({
    data: [
      {
        data: {
          shelves: [
            {
              contentType: "searchResult",
              items,
            },
          ],
          nextPage: {
            results: tailIds.map((id) => ({ id, type: "apps" })),
          },
        },
      },
    ],
  })}</script></body></html>`;
}

function buildCompleteCachedTopDocs(
  ids: string[],
  options?: {
    publisherNamesById?: Record<string, string>;
  }
) {
  return ids.map((appId, index) => ({
    appId,
    country: "US",
    name: `Cached ${appId}`,
    averageUserRating: 4.8 - index * 0.1,
    userRatingCount: (index + 1) * 1000,
    releaseDate: "2024-01-01T00:00:00.000Z",
    currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...(options?.publisherNamesById?.[appId]
      ? { publisherName: options.publisherNamesById[appId] }
      : {}),
  }));
}

describe("aso-enrichment-service", () => {
  beforeEach(() => {
    process.env.ASO_ENRICHMENT_MODE = "legacy";
    jest.clearAllMocks();
    __resetIncompleteTopDocLookupCooldownForTests();
    mockedFetchAppStoreAdditionalLocalizations.mockResolvedValue({});
  });

  it("logs source and result summaries for order refresh", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"]),
    } as never);

    const result = await refreshKeywordOrder({
      keyword: "word game",
      country: "US",
    });

    expect(result.appCount).toBe(3);
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] order source",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
      })
    );
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] order result",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
        appCount: 3,
      })
    );
  });

  it("uses exact lookup rating count for first apps when lookup is used", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtml(),
    } as never);

    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 130123,
        releaseDate: "2022-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 12100,
        releaseDate: "2021-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3600,
        releaseDate: "2020-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Lookup 4",
        averageUserRating: 4.5,
        userRatingCount: 890,
        releaseDate: "2019-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 1250,
        releaseDate: "2018-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [],
      }
    );

    expect(result.appDocs[0]).toEqual(
      expect.objectContaining({
        appId: "1",
        country: "US",
        userRatingCount: 130123,
        releaseDate: "2022-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      })
    );
    expect(result.appDocs[1]).toEqual(
      expect.objectContaining({
        appId: "2",
        country: "US",
        userRatingCount: 12100,
      })
    );
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] enrich source",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
      })
    );
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] enrich result",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
      })
    );
  });

  it("refetches lookup details when cached top app is missing dates", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);

    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [
          {
            appId: "1",
            country: "US",
            name: "Cached 1",
            averageUserRating: 4.7,
            userRatingCount: 1000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: null,
            currentVersionReleaseDate: null,
          },
          {
            appId: "2",
            country: "US",
            name: "Cached 2",
            averageUserRating: 4.6,
            userRatingCount: 2000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "3",
            country: "US",
            name: "Cached 3",
            averageUserRating: 4.5,
            userRatingCount: 3000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "4",
            country: "US",
            name: "Cached 4",
            averageUserRating: 4.4,
            userRatingCount: 4000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "5",
            country: "US",
            name: "Cached 5",
            averageUserRating: 4.3,
            userRatingCount: 5000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
        ],
      }
    );

    expect(mockedFetchAppStoreLookupAppDocs).toHaveBeenCalledWith(
      expect.objectContaining({
        country: "US",
        appIds: ["1"],
      })
    );
    expect(result.appDocs.find((doc) => doc.appId === "1")).toEqual(
      expect.objectContaining({
        appId: "1",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      })
    );
  });

  it("applies lookup cooldown for unresolved top-app docs across nearby keywords", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1 Missing Dates",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: null,
        currentVersionReleaseDate: null,
      },
    ]);

    const getAppDocs = async () => [
      {
        appId: "1",
        country: "US",
        name: "Cached 1",
        averageUserRating: 4.7,
        userRatingCount: 1000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: null,
        currentVersionReleaseDate: null,
      },
      {
        appId: "2",
        country: "US",
        name: "Cached 2",
        averageUserRating: 4.6,
        userRatingCount: 2000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Cached 3",
        averageUserRating: 4.5,
        userRatingCount: 3000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Cached 4",
        averageUserRating: 4.4,
        userRatingCount: 4000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Cached 5",
        averageUserRating: 4.3,
        userRatingCount: 5000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ];

    await expect(
      enrichKeyword(
        {
          keyword: "word game",
          country: "US",
          popularity: 66,
        },
        { getAppDocs }
      )
    ).rejects.toThrow("Insufficient top-app docs for difficulty scoring");

    expect(mockedFetchAppStoreLookupAppDocs).toHaveBeenCalledTimes(2);

    await expect(
      enrichKeyword(
        {
          keyword: "word game plus",
          country: "US",
          popularity: 66,
        },
        { getAppDocs }
      )
    ).rejects.toThrow("Insufficient top-app docs for difficulty scoring");

    expect(mockedFetchAppStoreLookupAppDocs).toHaveBeenCalledTimes(2);
  });

  it("skips bundle search results when building top app ids for difficulty docs", async () => {
    const bundleId = "1814195639";
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", bundleId, "3", "4"],
        ["5", "6"],
        {
          kindsById: {
            [bundleId]: "BundleSearchResult",
          },
          resultTypesById: {
            [bundleId]: "bundle",
          },
        }
      ),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 2000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Lookup 4",
        averageUserRating: 4.5,
        userRatingCount: 4000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 5000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "youtube",
        country: "US",
        popularity: 92,
      },
      {
        getAppDocs: async () => [],
      }
    );

    expect(result.orderedAppIds.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.orderedAppIds).not.toContain(bundleId);
    const lookupCalls = mockedFetchAppStoreLookupAppDocs.mock.calls.map(
      (call) => call[0]
    );
    expect(lookupCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          country: "US",
          appIds: ["1", "2", "3", "4"],
        }),
        expect.objectContaining({
          country: "US",
          appIds: ["5"],
        }),
      ])
    );
    for (const call of lookupCalls) {
      expect(call?.appIds ?? []).not.toContain(bundleId);
    }
  });

  it("matches keywords per localization and does not mix words across localizations", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "app dormir",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [
          {
            appId: "1",
            country: "US",
            name: "Cached 1",
            averageUserRating: 4.7,
            userRatingCount: 1000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
            additionalLocalizations: {
              "es-MX": {
                name: "dormir rapido",
              },
            },
          },
          {
            appId: "2",
            country: "US",
            name: "Cached 2",
            averageUserRating: 4.6,
            userRatingCount: 2000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
            additionalLocalizations: {
              "es-MX": {
                name: "app dormir rapido",
              },
            },
          },
          {
            appId: "3",
            country: "US",
            name: "Cached 3",
            averageUserRating: 4.5,
            userRatingCount: 3000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "4",
            country: "US",
            name: "Cached 4",
            averageUserRating: 4.4,
            userRatingCount: 4000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "5",
            country: "US",
            name: "Cached 5",
            averageUserRating: 4.3,
            userRatingCount: 5000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
        ],
      }
    );

    expect(result.keywordMatch).toBe("titleExactPhrase");
  });

  it("does not set expiresAt for non-top apps without app-specific lookup", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5", "6"]),
    } as never);

    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 2222,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3333,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Lookup 4",
        averageUserRating: 4.5,
        userRatingCount: 4444,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 5555,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [],
      }
    );

    expect(result.appDocs.find((doc) => doc.appId === "6")?.expiresAt).toBeUndefined();
    expect(result.appDocs.find((doc) => doc.appId === "1")?.expiresAt).toBe(
      "2099-01-01T00:00:00.000Z"
    );
  });

  it("backfills missing top docs from cache and lookup when lockups are sparse", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"], ["4", "5", "6"]),
    } as never);

    const lookupById: Record<string, any> = {
      "1": {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      "2": {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 2222,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      "3": {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3333,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      "5": {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 5555,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    };
    mockedFetchAppStoreLookupAppDocs.mockImplementation(async ({ appIds }) =>
      appIds.flatMap((id) => (lookupById[id] ? [lookupById[id]] : []))
    );

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async (appIds) =>
          appIds.includes("4")
            ? [
                {
                  appId: "4",
                  country: "US",
                  name: "Cached 4",
                  averageUserRating: 4.5,
                  userRatingCount: 4444,
                  releaseDate: "2024-01-01T00:00:00.000Z",
                  currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                },
              ]
            : [],
      }
    );

    expect(result.orderedAppIds.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    const docsForDifficultyCount = result.orderedAppIds
      .slice(0, 5)
      .filter((id) => result.appDocs.some((doc) => doc.appId === id)).length;
    expect(docsForDifficultyCount).toBe(5);
    expect(result.appDocs.find((doc) => doc.appId === "4")).toEqual(
      expect.objectContaining({
        appId: "4",
        name: "Cached 4",
      })
    );
    expect(result.appDocs.find((doc) => doc.appId === "5")).toEqual(
      expect.objectContaining({
        appId: "5",
        name: "Lookup 5",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
    );
  });

  it("fails with INSUFFICIENT_DOCS when top docs remain missing for competitive keywords", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"], ["4", "5"]),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([]);

    await expect(
      enrichKeyword(
        {
          keyword: "word game",
          country: "US",
          popularity: 66,
        },
        {
          getAppDocs: async () => [],
        }
      )
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_DOCS",
      statusCode: 503,
    });
  });

  it("fails with INSUFFICIENT_DOCS when top docs exist but release dates remain missing", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"], ["4", "5"]),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([]);

    await expect(
      enrichKeyword(
        {
          keyword: "word game",
          country: "US",
          popularity: 66,
        },
        {
          getAppDocs: async (appIds) =>
            appIds.map((appId) => ({
              appId,
              country: "US",
              name: `Cached ${appId}`,
              averageUserRating: 4.5,
              userRatingCount: 1000,
              releaseDate: null,
              currentVersionReleaseDate: null,
              expiresAt: "2099-01-01T00:00:00.000Z",
            })),
        }
      )
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_DOCS",
      statusCode: 503,
    });
  });

  it("detects brand keyword from search lockup publisher", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Dream Labs LLC",
          },
          ratingCountById: {
            "1": 1500,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "dream labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(true);
  });

  it("detects brand keyword from lookup fallback publisher", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: "<html><body>no serialized data</body></html>",
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [
                  { id: "1" },
                  { id: "2" },
                  { id: "3" },
                  { id: "4" },
                  { id: "5" },
                ],
              },
            ],
          },
        },
      } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue(
      buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"], {
        publisherNamesById: {
          "1": "Acme Studios",
          "2": "Other One",
          "3": "Other Two",
          "4": "Other Three",
          "5": "Other Four",
        },
      }).map((doc) => ({
        ...doc,
        userRatingCount: doc.appId === "1" ? 2000 : doc.userRatingCount,
      }))
    );

    const result = await enrichKeyword({
      keyword: "acme studios",
      country: "US",
      popularity: 66,
    });

    expect(result.isBrandKeyword).toBe(true);
  });

  it("returns non-brand when #1 publisher tokens do not match keyword", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Different Publisher",
          },
          ratingCountById: {
            "1": 3000,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme sleep",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(false);
  });

  it("marks weak leader as brand when independent runner-up median ratings are strong", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Acme Labs",
            "2": "Runner A",
            "3": "Runner B",
            "4": "Runner C",
            "5": "Runner D",
          },
          ratingCountById: {
            "1": 500,
            "2": 12000,
            "3": 15000,
            "4": 20000,
            "5": 8000,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(true);
  });

  it("marks weak leader as non-brand when independent runner-up median ratings are weak", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Acme Labs",
            "2": "Runner A",
            "3": "Runner B",
            "4": "Runner C",
            "5": "Runner D",
          },
          ratingCountById: {
            "1": 500,
            "2": 1000,
            "3": 2000,
            "4": 5000,
            "5": 7000,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(false);
  });

  it("defaults brand detection to false when publisher metadata is missing", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () =>
          buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]).map((doc) => {
            const { publisherName, ...rest } = doc;
            return rest;
          }),
      }
    );

    expect(result.isBrandKeyword).toBe(false);
  });
});

describe("aso-enrichment-service (ratings mode)", () => {
  function mzsearch(ids: string[]) {
    return {
      data: {
        pageData: {
          bubbles: [{ name: "software", results: ids.map((id) => ({ id })) }],
        },
      },
    } as never;
  }

  function itunesDocs(counts: Record<string, number>, publisher?: Record<string, string>) {
    return new Map(
      Object.entries(counts).map(([appId, userRatingCount]) => [
        appId,
        {
          appId,
          country: "US",
          name: `App ${appId}`,
          publisherName: publisher?.[appId] ?? `Publisher ${appId}`,
          averageUserRating: 4.5,
          userRatingCount,
          releaseDate: "2020-01-01",
          currentVersionReleaseDate: "2026-01-01",
        },
      ])
    );
  }

  beforeEach(() => {
    delete process.env.ASO_ENRICHMENT_MODE;
    // These cases are about MZSearch + lookup; the search-page prefix has its own.
    process.env.ASO_RANK_SEARCHPAGE_PREFIX = "0";
    jest.clearAllMocks();
  });

  afterAll(() => {
    delete process.env.ASO_RANK_SEARCHPAGE_PREFIX;
  });

  it("orders from MZSearch, looks up only the top 10 and scores difficulty from their ratings", async () => {
    const ids = Array.from({ length: 240 }, (_, i) => String(i + 1));
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch(ids));
    const counts = Object.fromEntries(ids.slice(0, 10).map((id) => [id, 100000]));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(itunesDocs(counts) as never);

    const result = await enrichKeyword({ keyword: "budget", country: "US", popularity: 40 });

    expect(mockedAsoAppleGet).toHaveBeenCalledTimes(1);
    expect(mockedFetchItunesLookupAppDocs).toHaveBeenCalledWith(
      expect.objectContaining({ country: "US", appIds: ids.slice(0, 10) })
    );
    expect(mockedFetchAppStoreLookupAppDocs).not.toHaveBeenCalled();
    expect(mockedFetchAppStoreAdditionalLocalizations).not.toHaveBeenCalled();
    expect(result.appCount).toBe(240);
    expect(result.orderedAppIds).toHaveLength(240);
    expect(result.appDocs.map((doc) => doc.appId)).toEqual(ids.slice(0, 10));
    expect(result.difficultyScore).toBeGreaterThan(50);
    expect(result.difficultyScore).toBe(result.minDifficultyScore);
  });

  it("keeps a cached subtitle, which iTunes lookup does not return", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch(["1", "2"]));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(itunesDocs({ "1": 10, "2": 20 }) as never);

    const result = await enrichKeyword(
      { keyword: "budget", country: "US", popularity: 40 },
      {
        getAppDocs: async () => [
          {
            appId: "1",
            country: "US",
            name: "Old",
            subtitle: "Budget planner",
            averageUserRating: 4,
            userRatingCount: 5,
          },
        ],
      }
    );

    expect(result.appDocs[0]).toEqual(
      expect.objectContaining({ name: "App 1", subtitle: "Budget planner", userRatingCount: 10 })
    );
  });

  it("fails as insufficient docs when the lookup returns none of the top apps", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch(["1", "2", "3"]));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(new Map() as never);

    await expect(
      enrichKeyword({ keyword: "budget", country: "US", popularity: 40 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_DOCS" });
  });

  it("recomputes difficulty when only the order is refreshed", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch(["1", "2", "3"]));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(
      itunesDocs({ "1": 1_000_000, "2": 1_000_000, "3": 1_000_000 }) as never
    );

    const result = await refreshKeywordOrder({ keyword: "budget", country: "US" });

    expect(result.orderedAppIds).toEqual(["1", "2", "3"]);
    expect(typeof result.difficultyScore).toBe("number");
  });
});

describe("aso-enrichment-service (untrustworthy MZSearch order)", () => {
  const storedOrder = (ids: string[] | null) => () => ids;

  beforeEach(() => {
    delete process.env.ASO_ENRICHMENT_MODE;
    jest.clearAllMocks();
  });

  it("refuses an empty software bubble when the keyword already has a stored order", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce({
      data: { pageData: { bubbles: [{ name: "software", results: [] }] } },
    } as never);

    await expect(
      refreshKeywordOrder({
        keyword: "budget",
        country: "GB",
        getStoredOrderedAppIds: storedOrder(["1", "2"]),
      })
    ).rejects.toMatchObject({ code: "EMPTY_ORDER" });
    expect(mockedFetchItunesLookupAppDocs).not.toHaveBeenCalled();
  });

  it("accepts an empty result for a never-enriched keyword", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce({
      data: { pageData: { bubbles: [{ name: "software", results: [] }] } },
    } as never);

    const result = await enrichKeyword(
      { keyword: "zzqx", country: "VN", popularity: 5 },
      { getStoredOrderedAppIds: storedOrder(null) }
    );
    expect(result.appCount).toBe(0);
    expect(result.orderedAppIds).toEqual([]);
  });

  it.each([
    ["no software bubble", [{ name: "editorial", results: [] }]],
    ["a bare bubbles: []", []],
  ])("refuses %s over a stored non-empty order", async (_label, bubbles) => {
    mockedAsoAppleGet.mockResolvedValueOnce({
      data: { pageData: { bubbles } },
    } as never);

    await expect(
      refreshKeywordOrder({
        keyword: "zzqx",
        country: "PT",
        getStoredOrderedAppIds: storedOrder(["1"]),
      })
    ).rejects.toMatchObject({ code: "EMPTY_ORDER" });
  });

  it("accepts a bare bubbles: [] for a never-enriched keyword", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce({
      data: { pageData: { bubbles: [] } },
    } as never);

    const result = await enrichKeyword(
      { keyword: "zzqx", country: "VN", popularity: 5 },
      { getStoredOrderedAppIds: storedOrder([]) }
    );
    expect(result.orderedAppIds).toEqual([]);
  });

  it("refuses a response whose shape drifted, whatever is stored", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce({
      status: 200,
      data: { pageData: {} },
    } as never);

    await expect(
      refreshKeywordOrder({ keyword: "budget", country: "GB" })
    ).rejects.toMatchObject({ code: "ORDER_CONTRACT_DRIFT" });
  });
});

describe("aso-enrichment-service (ratings mode, search-page prefix)", () => {
  function mzsearch(ids: string[]) {
    return {
      data: { pageData: { bubbles: [{ name: "software", results: ids.map((id) => ({ id })) }] } },
    } as never;
  }
  function organicPage(ids: string[], extraRows: unknown[] = []) {
    const items = [
      ...extraRows,
      ...ids.map((id) => ({
        $kind: "AppSearchResult",
        resultType: "content",
        lockup: { adamId: id, title: `App ${id}`, rating: 4.5, ratingCount: "1000" },
      })),
    ];
    return {
      data: `<html><script id="serialized-server-data">${JSON.stringify({
        data: [{ data: { shelves: [{ contentType: "searchResult", items }] } }],
      })}</script></html>`,
    } as never;
  }
  function lookupFor(ids: string[]) {
    return new Map(
      ids.map((appId) => [
        appId,
        { appId, country: "US", name: `App ${appId}`, averageUserRating: 4.5, userRatingCount: 1000 },
      ])
    ) as never;
  }

  beforeEach(() => {
    delete process.env.ASO_ENRICHMENT_MODE;
    delete process.env.ASO_RANK_SEARCHPAGE_PREFIX;
    jest.clearAllMocks();
  });

  it("puts the search page's organic order first and appends MZSearch's unseen ids", async () => {
    const mz = Array.from({ length: 30 }, (_, i) => String(i + 1));
    mockedAsoAppleGet
      .mockResolvedValueOnce(mzsearch(mz))
      .mockResolvedValueOnce(
        organicPage(["5", "1", "9"], [
          // Ads and editorial rows are not ranks.
          { $kind: "AdSearchResult", resultType: "ad", lockup: { adamId: "999" } },
          { $kind: "EditorialSearchResult", resultType: "editorial", lockup: { adamId: "888" } },
        ])
      );
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(lookupFor(["5", "1", "9"]));

    const result = await refreshKeywordOrder({ keyword: "budget", country: "US" });

    expect(result.orderedAppIds.slice(0, 5)).toEqual(["5", "1", "9", "2", "3"]);
    expect(result.orderedAppIds).toHaveLength(30);
    expect(result.orderedAppIds).not.toContain("999");
    expect(result.orderSource).toBe("searchpage+mzsearch");
  });

  it("counts an app-event row as that app's slot", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce(mzsearch(["1", "2", "3"]))
      .mockResolvedValueOnce(
        organicPage(["2"], [
          { $kind: "AppEventSearchResult", resultType: "appEvent", lockup: { adamId: "3" } },
        ])
      );
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(lookupFor(["1", "2", "3"]));

    const result = await refreshKeywordOrder({ keyword: "budget", country: "US" });

    expect(result.orderedAppIds).toEqual(["3", "2", "1"]);
  });

  it("never lets a prefix stand in for an empty MZSearch order over a stored one", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch([]));

    await expect(
      refreshKeywordOrder({ keyword: "budget", country: "US", getStoredOrderedAppIds: () => ["1", "2"] })
    ).rejects.toMatchObject({ code: "EMPTY_ORDER" });
    // The search page is not even asked once MZSearch is empty.
    expect(mockedAsoAppleGet).toHaveBeenCalledTimes(1);
  });

  it("does not ask the search page for an empty never-enriched keyword", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch([]));

    const result = await refreshKeywordOrder({ keyword: "zzqx", country: "US" });

    expect(result.orderedAppIds).toEqual([]);
    expect(mockedAsoAppleGet).toHaveBeenCalledTimes(1);
  });

  it("refuses a prefix-only order shallower than the stored order", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce(mzsearch(["1"]))
      .mockResolvedValueOnce(organicPage(["4", "5", "6"]));

    await expect(
      refreshKeywordOrder({
        keyword: "budget",
        country: "US",
        getStoredOrderedAppIds: () => Array.from({ length: 200 }, (_, i) => String(i)),
      })
    ).rejects.toMatchObject({ code: "SHALLOW_ORDER" });
  });

  it("keeps the prefix alone when MZSearch is shorter than it", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce(mzsearch(["1"]))
      .mockResolvedValueOnce(organicPage(["4", "5", "6"]));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(lookupFor(["4", "5", "6"]));

    const result = await refreshKeywordOrder({ keyword: "budget", country: "US" });

    expect(result.orderedAppIds).toEqual(["4", "5", "6"]);
    expect(result.orderSource).toBe("searchpage");
  });

  it("falls back to MZSearch order when the search page fails", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce(mzsearch(["1", "2"]))
      .mockRejectedValueOnce(new Error("403"));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(lookupFor(["1", "2"]));

    const result = await refreshKeywordOrder({ keyword: "budget", country: "US" });

    expect(result.orderedAppIds).toEqual(["1", "2"]);
    expect(result.orderSource).toBe("mzsearch");
  });

  it("makes no search-page request when switched off", async () => {
    process.env.ASO_RANK_SEARCHPAGE_PREFIX = "0";
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch(["1", "2"]));
    mockedFetchItunesLookupAppDocs.mockResolvedValueOnce(lookupFor(["1", "2"]));

    await refreshKeywordOrder({ keyword: "budget", country: "US" });

    expect(mockedAsoAppleGet).toHaveBeenCalledTimes(1);
    delete process.env.ASO_RANK_SEARCHPAGE_PREFIX;
  });

  it("still refuses an empty order over a stored one when both sources are empty", async () => {
    mockedAsoAppleGet.mockResolvedValueOnce(mzsearch([]));

    await expect(
      refreshKeywordOrder({
        keyword: "budget",
        country: "US",
        getStoredOrderedAppIds: () => ["1"],
      })
    ).rejects.toMatchObject({ code: "EMPTY_ORDER" });
  });
});

describe("aso-enrichment-service (batched lookups)", () => {
  const { withObservationRun, __resetRunLookupCacheForTests } =
    jest.requireActual("../../keywords/observation-context") as typeof import("../../keywords/observation-context");

  // Fixture: three keywords whose top 10s overlap heavily.
  const orders: Record<string, string[]> = {
    budget: Array.from({ length: 40 }, (_, i) => String(i + 1)),
    "budget planner": ["3", "1", "2", ...Array.from({ length: 30 }, (_, i) => String(100 + i))],
    money: ["7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17"],
  };
  const ratingCounts: Record<string, number> = {};
  for (let i = 1; i < 200; i += 1) ratingCounts[String(i)] = (i * 7919) % 250000;

  function mzsearchFor(term: string) {
    return {
      data: { pageData: { bubbles: [{ name: "software", results: (orders[term] ?? []).map((id) => ({ id })) }] } },
    } as never;
  }
  function lookupImpl({ appIds }: { appIds: string[] }) {
    return Promise.resolve(
      new Map(
        appIds.map((appId) => [
          appId,
          { appId, country: "US", name: `App ${appId}`, averageUserRating: 4, userRatingCount: ratingCounts[appId] ?? 0 },
        ])
      ) as never
    );
  }

  beforeEach(() => {
    delete process.env.ASO_ENRICHMENT_MODE;
    process.env.ASO_RANK_SEARCHPAGE_PREFIX = "0";
    jest.clearAllMocks();
    __resetRunLookupCacheForTests();
    mockedAsoAppleGet.mockImplementation((async (_url: string, config: { params?: { term?: string } }) =>
      mzsearchFor(config?.params?.term ?? "")) as never);
    mockedFetchItunesLookupAppDocs.mockImplementation(lookupImpl as never);
  });

  afterAll(() => {
    delete process.env.ASO_RANK_SEARCHPAGE_PREFIX;
  });

  it("scores exactly as per-keyword refreshes do, with one merged lookup", async () => {
    const keywords = Object.keys(orders);
    const single = [];
    for (const keyword of keywords) {
      single.push(await refreshKeywordOrder({ keyword, country: "US" }));
    }
    expect(mockedFetchItunesLookupAppDocs).toHaveBeenCalledTimes(3);
    mockedFetchItunesLookupAppDocs.mockClear();

    const batch = await refreshKeywordOrdersBatch({ country: "US", keywords });

    expect(mockedFetchItunesLookupAppDocs).toHaveBeenCalledTimes(1);
    const requested = mockedFetchItunesLookupAppDocs.mock.calls[0][0].appIds;
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested.length).toBeLessThan(30);
    expect(
      batch.map((outcome) =>
        outcome.ok
          ? [outcome.keyword, outcome.value.difficultyScore, outcome.value.orderedAppIds, outcome.value.appCount]
          : [outcome.keyword, "failed"]
      )
    ).toEqual(single.map((r, i) => [keywords[i], r.difficultyScore, r.orderedAppIds, r.appCount]));
  });

  it("fails only the keywords whose top apps were in a failed lookup chunk", async () => {
    // "money"'s top 10 (7..16) are looked up; pretend the request for 9 and
    // 10 failed, while 17 is simply delisted (Apple leaves it out).
    mockedFetchItunesLookupAppDocs.mockImplementation((async (params: {
      appIds: string[];
      onFailedIds?: (ids: string[]) => void;
    }) => {
      params.onFailedIds?.(params.appIds.filter((id) => id === "9" || id === "10"));
      return lookupImpl({
        appIds: params.appIds.filter((id) => !["9", "10", "17"].includes(id)),
      });
    }) as never);

    const batch = await refreshKeywordOrdersBatch({
      country: "US",
      keywords: ["budget planner", "money"],
    });

    expect(batch.map((outcome) => [outcome.keyword, outcome.ok])).toEqual([
      ["budget planner", true],
      ["money", false],
    ]);
    const failed = batch[1] as { ok: false; error: { code?: string } };
    expect(failed.error.code).toBe("INSUFFICIENT_DOCS");
  });

  it("still scores a keyword whose top app is delisted (left out, not failed)", async () => {
    mockedFetchItunesLookupAppDocs.mockImplementation((async (params: { appIds: string[] }) =>
      lookupImpl({ appIds: params.appIds.filter((id) => id !== "3") })) as never);

    const [outcome] = await refreshKeywordOrdersBatch({ country: "US", keywords: ["budget planner"] });

    expect(outcome.ok).toBe(true);
  });

  it("isolates a keyword whose order fails without affecting the rest", async () => {
    const batch = await refreshKeywordOrdersBatch({
      country: "US",
      keywords: ["budget", "nothing-here", "money"],
      getStoredOrderedAppIds: (keyword) => (keyword === "nothing-here" ? ["1"] : null),
    });

    expect(batch.map((outcome) => [outcome.keyword, outcome.ok])).toEqual([
      ["budget", true],
      ["nothing-here", false],
      ["money", true],
    ]);
  });

  it("reuses lookups across batches within one run, per storefront", async () => {
    await withObservationRun(5, async () => {
      await refreshKeywordOrdersBatch({ country: "US", keywords: ["budget"] });
      await refreshKeywordOrdersBatch({ country: "US", keywords: ["budget planner"] });
    });
    // The second batch only needs the ids the first did not already fetch.
    const second = mockedFetchItunesLookupAppDocs.mock.calls[1][0].appIds;
    expect(second).not.toContain("1");
    expect(second).not.toContain("3");

    mockedFetchItunesLookupAppDocs.mockClear();
    await refreshKeywordOrdersBatch({ country: "US", keywords: ["budget"] });
    // Outside a run there is no cache.
    expect(mockedFetchItunesLookupAppDocs.mock.calls[0][0].appIds).toHaveLength(10);
  });
});
