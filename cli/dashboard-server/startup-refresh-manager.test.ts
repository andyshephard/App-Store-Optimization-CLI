import {
  createStartupRefreshManager,
  selectKeywordRefreshCandidates,
  type KeywordRefreshItem,
} from "./startup-refresh-manager";
import type { StoredAppKeyword, StoredAsoKeyword } from "../db";

function buildKeyword(
  overrides: Partial<StoredAsoKeyword>
): StoredAsoKeyword {
  return {
    keyword: "term",
    normalizedKeyword: "term",
    country: "US",
    popularity: 10,
    difficultyScore: 20,
    minDifficultyScore: 5,
    isBrandKeyword: null,
    appCount: 10,
    keywordMatch: "titleExactPhrase",
    orderedAppIds: ["app-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    orderExpiresAt: "2099-01-01T00:00:00.000Z",
    popularityExpiresAt: "2099-01-30T00:00:00.000Z",
    ...overrides,
  };
}

function buildAssociation(
  overrides: Partial<StoredAppKeyword>
): StoredAppKeyword {
  return {
    appId: "app-1",
    keyword: "term",
    country: "US",
    isFavorite: false,
    previousPosition: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function waitForManagerToFinish(
  manager: ReturnType<typeof createStartupRefreshManager>
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const state = manager.getState();
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "stopped"
    ) {
      return;
    }
    await Promise.resolve();
  }
}

describe("startup-refresh-manager", () => {
  it("does not select research-only keywords for order-stale refresh", () => {
    const now = Date.parse("2026-03-07T00:00:00.000Z");
    const selected = selectKeywordRefreshCandidates({
      keywords: [
        buildKeyword({
          keyword: "order-stale",
          normalizedKeyword: "order-stale",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({ keyword: "fresh", normalizedKeyword: "fresh" }),
        buildKeyword({
          keyword: "difficulty-missing",
          normalizedKeyword: "difficulty-missing",
          difficultyScore: null,
          minDifficultyScore: null,
          appCount: null,
          keywordMatch: null,
        }),
        buildKeyword({
          keyword: "popularity-stale",
          normalizedKeyword: "popularity-stale",
          popularityExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "research-order-stale",
          normalizedKeyword: "research-order-stale",
          popularity: 30,
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "research-popularity-stale",
          normalizedKeyword: "research-popularity-stale",
          popularity: 31,
          popularityExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "research-difficulty-missing",
          normalizedKeyword: "research-difficulty-missing",
          popularity: 32,
          difficultyScore: null,
          minDifficultyScore: null,
          appCount: null,
          keywordMatch: null,
        }),
        buildKeyword({
          keyword: "no-popularity",
          normalizedKeyword: "no-popularity",
          popularity: Number.NaN,
        }),
      ],
      appKeywords: [
        buildAssociation({ appId: "app-1", keyword: "order-stale" }),
        buildAssociation({ appId: "app-1", keyword: "fresh" }),
        buildAssociation({ appId: "app-1", keyword: "difficulty-missing" }),
        buildAssociation({ appId: "app-1", keyword: "popularity-stale" }),
        buildAssociation({
          appId: "research:ideas",
          keyword: "research-order-stale",
        }),
        buildAssociation({
          appId: "research:ideas",
          keyword: "research-popularity-stale",
        }),
        buildAssociation({
          appId: "research:ideas",
          keyword: "research-difficulty-missing",
        }),
        buildAssociation({ appId: "app-1", keyword: "no-popularity" }),
      ],
      associatedAppIds: new Set(["app-1", "research:ideas"]),
      orderRelevantAppIds: new Set(["app-1"]),
      nowMs: now,
    });

    expect(selected).toEqual<KeywordRefreshItem[]>([
      { keyword: "order-stale", popularity: 10 },
      { keyword: "difficulty-missing", popularity: 10 },
      { keyword: "popularity-stale", popularity: 10 },
      { keyword: "research-popularity-stale", popularity: 31 },
      { keyword: "research-difficulty-missing", popularity: 32 },
    ]);
  });

  it("retries failed batch once and records successful counters", async () => {
    let now = Date.parse("2026-03-07T00:00:00.000Z");
    const enrichCalls: KeywordRefreshItem[][] = [];
    const errors: unknown[] = [];

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k2",
          normalizedKeyword: "k2",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k3",
          normalizedKeyword: "k3",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "k1", appId: "app-1" }),
        buildAssociation({ keyword: "k2", appId: "app-1" }),
        buildAssociation({ keyword: "k3", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (_country, items) => {
        enrichCalls.push(items);
        if (enrichCalls.length === 1) {
          throw Object.assign(new Error("transient network failure"), {
            code: "ECONNRESET",
          });
        }
      },
      isForegroundBusy: () => false,
      reportError: (error) => {
        errors.push(error);
      },
      nowMs: () => now,
      sleep: async () => {},
      keywordBatchSize: 2,
    });

    manager.start();
    now += 1000;
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("completed");
    expect(state.counters.eligibleKeywordCount).toBe(3);
    expect(state.counters.refreshedKeywordCount).toBe(3);
    expect(state.counters.failedKeywordCount).toBe(0);
    expect(state.requiresReauthentication).toBe(false);
    expect(enrichCalls).toHaveLength(3);
    expect(errors).toHaveLength(0);
  });

  it("refreshes every storefront returned by listRefreshCountries", async () => {
    const enrichCalls: Array<{ country: string; keywords: string[] }> = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");
    const keywordsByCountry: Record<string, string[]> = {
      US: ["us-1", "us-2"],
      GB: ["gb-1"],
    };

    const manager = createStartupRefreshManager({
      country: "US",
      listRefreshCountries: () => ["US", "gb", "US"],
      listKeywords: (country) =>
        (keywordsByCountry[country] ?? []).map((keyword) =>
          buildKeyword({
            keyword,
            normalizedKeyword: keyword,
            country,
            orderExpiresAt: "2026-03-06T00:00:00.000Z",
          })
        ),
      listAppKeywords: (country) =>
        (keywordsByCountry[country] ?? []).map((keyword) =>
          buildAssociation({ keyword, country, appId: "app-1" })
        ),
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (country, items) => {
        enrichCalls.push({
          country,
          keywords: items.map((item) => item.keyword),
        });
      },
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("completed");
    // "gb" is normalized and the duplicate "US" is dropped.
    expect(enrichCalls).toEqual([
      { country: "US", keywords: ["us-1", "us-2"] },
      { country: "GB", keywords: ["gb-1"] },
    ]);
    expect(state.counters.eligibleKeywordCount).toBe(3);
    expect(state.counters.refreshedKeywordCount).toBe(3);
  });

  it("keeps refreshing later storefronts without the popularity stage once reauthentication is required", async () => {
    const enrichCalls: string[] = [];
    const skipPopularityFlags: boolean[] = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");

    const manager = createStartupRefreshManager({
      country: "US",
      listRefreshCountries: () => ["US", "GB"],
      listKeywords: (country) => [
        buildKeyword({
          keyword: `${country.toLowerCase()}-1`,
          normalizedKeyword: `${country.toLowerCase()}-1`,
          country,
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: (country) => [
        buildAssociation({
          keyword: `${country.toLowerCase()}-1`,
          country,
          appId: "app-1",
        }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (country, _items, options) => {
        enrichCalls.push(country);
        skipPopularityFlags.push(options.skipPopularity);
        // Only the popularity stage needs the Apple session, so once it is
        // known dead the caller must stop asking for it - and must not throw
        // for the ranking-only work that needs no session.
        if (!options.skipPopularity) throw new Error("reauth required");
        return [];
      },
      isForegroundBusy: () => false,
      isAuthReauthRequiredError: (error) =>
        error instanceof Error && error.message === "reauth required",
      nowMs: () => now,
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    // GB is still crawled: rank and difficulty come from the public search
    // page, so abandoning it would discard data that was there for the taking.
    expect(enrichCalls).toEqual(["US", "GB"]);
    expect(skipPopularityFlags).toEqual([false, true]);
    expect(manager.getState().requiresReauthentication).toBe(true);
  });

  it("skips fresh keywords normally but takes everything when forced", async () => {
    const now = Date.parse("2026-03-10T00:00:00.000Z");
    // One stale, one still well inside its freshness window.
    const keywords = [
      buildKeyword({
        keyword: "stale",
        normalizedKeyword: "stale",
        orderExpiresAt: "2026-03-06T00:00:00.000Z",
      }),
      buildKeyword({
        keyword: "fresh",
        normalizedKeyword: "fresh",
        orderExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ];
    const appKeywords = [
      buildAssociation({ keyword: "stale", appId: "app-1" }),
      buildAssociation({ keyword: "fresh", appId: "app-1" }),
    ];

    const normal = selectKeywordRefreshCandidates({
      keywords,
      appKeywords,
      associatedAppIds: new Set(["app-1"]),
      orderRelevantAppIds: new Set(["app-1"]),
      nowMs: now,
    });
    expect(normal.map((item) => item.keyword)).toEqual(["stale"]);

    const forced = selectKeywordRefreshCandidates({
      keywords,
      appKeywords,
      associatedAppIds: new Set(["app-1"]),
      orderRelevantAppIds: new Set(["app-1"]),
      nowMs: now,
      force: true,
    });
    expect(forced.map((item) => item.keyword)).toEqual(["stale", "fresh"]);
  });

  it("tells the pipeline a run is forced, so it re-crawls instead of using the cache", async () => {
    const seen: Array<{ force: boolean }> = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "fresh",
          normalizedKeyword: "fresh",
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "fresh", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (_country, _items, options) => {
        seen.push(options);
      },
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async () => {},
    });

    manager.start({ force: true });
    await waitForManagerToFinish(manager);

    expect(seen).toEqual([{ force: true, skipPopularity: false }]);
  });

  it("passes force through from start() to the crawl", async () => {
    const enriched: string[] = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "fresh",
          normalizedKeyword: "fresh",
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "fresh", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (_country, items) => {
        enriched.push(...items.map((item) => item.keyword));
      },
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async () => {},
    });

    manager.start({ force: true });
    await waitForManagerToFinish(manager);

    expect(enriched).toEqual(["fresh"]);
  });

  it("paces between storefronts and between batches", async () => {
    const sleeps: number[] = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");
    const byCountry: Record<string, string[]> = {
      US: ["us-1", "us-2", "us-3"],
      GB: ["gb-1"],
      DE: ["de-1"],
    };

    const manager = createStartupRefreshManager({
      country: "US",
      listRefreshCountries: () => ["US", "GB", "DE"],
      listKeywords: (country) =>
        (byCountry[country] ?? []).map((keyword) =>
          buildKeyword({
            keyword,
            normalizedKeyword: keyword,
            country,
            orderExpiresAt: "2026-03-06T00:00:00.000Z",
          })
        ),
      listAppKeywords: (country) =>
        (byCountry[country] ?? []).map((keyword) =>
          buildAssociation({ keyword, country, appId: "app-1" })
        ),
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {},
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      keywordBatchSize: 1,
      interCountryDelayMs: 180000,
      interBatchDelayMs: 5000,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    // Two gaps for three storefronts - never before the first or after the last.
    expect(sleeps.filter((ms) => ms === 180000)).toHaveLength(2);
    // US has three single-keyword batches, so two gaps; GB and DE have one each.
    expect(sleeps.filter((ms) => ms === 5000)).toHaveLength(2);
    expect(manager.getState().status).toBe("completed");
  });

  it("does not pace when the delays are left at their defaults", async () => {
    const sleeps: number[] = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");

    const manager = createStartupRefreshManager({
      country: "US",
      listRefreshCountries: () => ["US", "GB"],
      listKeywords: (country) => [
        buildKeyword({
          keyword: `${country.toLowerCase()}-1`,
          normalizedKeyword: `${country.toLowerCase()}-1`,
          country,
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: (country) => [
        buildAssociation({
          keyword: `${country.toLowerCase()}-1`,
          country,
          appId: "app-1",
        }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {},
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    expect(sleeps).toHaveLength(0);
  });

  it("abandons a storefront once enough consecutive keywords fail", async () => {
    const attempted: string[] = [];
    const now = Date.parse("2026-03-10T00:00:00.000Z");
    const usKeywords = ["k1", "k2", "k3", "k4", "k5"];
    const byCountry: Record<string, string[]> = { US: usKeywords, GB: ["gb-1"] };

    const manager = createStartupRefreshManager({
      country: "US",
      listRefreshCountries: () => ["US", "GB"],
      listKeywords: (country) =>
        (byCountry[country] ?? []).map((keyword) =>
          buildKeyword({
            keyword,
            normalizedKeyword: keyword,
            country,
            orderExpiresAt: "2026-03-06T00:00:00.000Z",
          })
        ),
      listAppKeywords: (country) =>
        (byCountry[country] ?? []).map((keyword) =>
          buildAssociation({ keyword, country, appId: "app-1" })
        ),
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (country, items) => {
        attempted.push(`${country}:${items.map((i) => i.keyword).join(",")}`);
        if (country === "US") {
          throw new Error("All keywords failed (1): k:INSUFFICIENT_DOCS(503)");
        }
      },
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async () => {},
      keywordBatchSize: 1,
      abandonCountryAfterFailedKeywords: 2,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    // Stops after two failures rather than burning all five keywords...
    expect(attempted.filter((entry) => entry.startsWith("US:"))).toHaveLength(2);
    // ...and moves on to the next storefront rather than aborting the run.
    expect(attempted).toContain("GB:gb-1");
    expect(manager.getState().counters.skippedCountries).toEqual(["US"]);
  });

  it("stops refresh at the next batch boundary", async () => {
    const enrichCalls: KeywordRefreshItem[][] = [];
    let releaseBatch = () => {};
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    let manager!: ReturnType<typeof createStartupRefreshManager>;
    manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k2",
          normalizedKeyword: "k2",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "k1", appId: "app-1" }),
        buildAssociation({ keyword: "k2", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (_country, items) => {
        enrichCalls.push(items);
        await batchGate;
      },
      isForegroundBusy: () => false,
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 1,
    });

    manager.start();
    await Promise.resolve();
    manager.stop();
    releaseBatch();
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("stopped");
    expect(state.stopRequested).toBe(false);
    expect(state.counters.eligibleKeywordCount).toBe(2);
    expect(state.counters.refreshedKeywordCount).toBe(1);
    expect(enrichCalls).toHaveLength(1);
  });

  it("keeps auth-required failures failed when stop is requested", async () => {
    const authError = new Error(
      "Apple Search Ads session expired. Reauthentication is required."
    );
    let rejectBatch!: (error: Error) => void;
    const batchGate = new Promise<void>((_resolve, reject) => {
      rejectBatch = reject;
    });

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [buildAssociation({ keyword: "k1", appId: "app-1" })],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        await batchGate;
      },
      isForegroundBusy: () => false,
      isAuthReauthRequiredError: (error) => error === authError,
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 1,
    });

    manager.start();
    await Promise.resolve();
    manager.stop();
    rejectBatch(authError);
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("failed");
    expect(state.requiresReauthentication).toBe(true);
    expect(state.stopRequested).toBe(false);
    expect(state.counters.failedKeywordCount).toBe(1);
  });

  it("marks batch failed when retry also fails", async () => {
    const errors: unknown[] = [];

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [buildAssociation({ keyword: "k1", appId: "app-1" })],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        throw Object.assign(new Error("always fails transiently"), {
          code: "ETIMEDOUT",
        });
      },
      isForegroundBusy: () => false,
      reportError: (error) => {
        errors.push(error);
      },
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("failed");
    expect(state.counters.refreshedKeywordCount).toBe(0);
    expect(state.counters.failedKeywordCount).toBe(1);
    expect(state.requiresReauthentication).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("does not retry deterministic non-transient batch failures", async () => {
    let enrichCalls = 0;

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [buildAssociation({ keyword: "k1", appId: "app-1" })],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        enrichCalls += 1;
        throw new Error("deterministic failure");
      },
      isForegroundBusy: () => false,
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("failed");
    expect(state.counters.refreshedKeywordCount).toBe(0);
    expect(state.counters.failedKeywordCount).toBe(1);
    expect(enrichCalls).toBe(1);
  });

  it("marks auth-required failures and allows restart after failure", async () => {
    let attempt = 0;

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [buildAssociation({ keyword: "k1", appId: "app-1" })],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error(
            "Apple Search Ads session expired. Reauthentication is required."
          );
        }
      },
      isForegroundBusy: () => false,
      isAuthReauthRequiredError: (error) =>
        error instanceof Error &&
        error.message.includes("Reauthentication is required"),
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 25,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "failed",
        requiresReauthentication: true,
      })
    );

    await Promise.resolve();
    manager.start();
    await waitForManagerToFinish(manager);

    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "completed",
        requiresReauthentication: false,
      })
    );
    expect(attempt).toBe(2);
  });

  it("stops startup refresh after first auth-required batch failure", async () => {
    let attempt = 0;

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k2",
          normalizedKeyword: "k2",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k3",
          normalizedKeyword: "k3",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "k1", appId: "app-1" }),
        buildAssociation({ keyword: "k2", appId: "app-1" }),
        buildAssociation({ keyword: "k3", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async (_country, items, options) => {
        attempt += 1;
        if (!options.skipPopularity) {
          throw new Error(
            "Apple Search Ads session expired. Reauthentication is required."
          );
        }
        return items;
      },
      isForegroundBusy: () => false,
      isAuthReauthRequiredError: (error) =>
        error instanceof Error &&
        error.message.includes("Reauthentication is required"),
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 1,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    // The first batch establishes that the session is gone. The other two are
    // still attempted, without the popularity stage, because the ranking crawl
    // they need does not touch the Apple account at all. The run is still
    // reported as failed so the operator is told to log in.
    const state = manager.getState();
    expect(state.status).toBe("failed");
    expect(state.requiresReauthentication).toBe(true);
    expect(state.counters.eligibleKeywordCount).toBe(3);
    expect(state.counters.refreshedKeywordCount).toBe(2);
    expect(state.counters.failedKeywordCount).toBe(1);
    expect(attempt).toBe(3);
  });

  it("does not retry exhausted all-keywords-failed batches", async () => {
    let enrichCalls = 0;

    const manager = createStartupRefreshManager({
      country: "US",
      listKeywords: () => [
        buildKeyword({
          keyword: "k1",
          normalizedKeyword: "k1",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k2",
          normalizedKeyword: "k2",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
        buildKeyword({
          keyword: "k3",
          normalizedKeyword: "k3",
          orderExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      ],
      listAppKeywords: () => [
        buildAssociation({ keyword: "k1", appId: "app-1" }),
        buildAssociation({ keyword: "k2", appId: "app-1" }),
        buildAssociation({ keyword: "k3", appId: "app-1" }),
      ],
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      enrichKeywords: async () => {
        enrichCalls += 1;
        throw new Error("All keywords failed (1): k1:INSUFFICIENT_DOCS(503)");
      },
      isForegroundBusy: () => false,
      nowMs: () => Date.parse("2026-03-07T00:00:00.000Z"),
      sleep: async () => {},
      keywordBatchSize: 1,
    });

    manager.start();
    await waitForManagerToFinish(manager);

    const state = manager.getState();
    expect(state.status).toBe("failed");
    expect(state.counters.eligibleKeywordCount).toBe(3);
    expect(state.counters.refreshedKeywordCount).toBe(0);
    expect(state.counters.failedKeywordCount).toBe(3);
    expect(enrichCalls).toBe(3);
  });

  describe("per-keyword outcomes", () => {
    const now = Date.parse("2026-03-10T00:00:00.000Z");
    const byCountry: Record<string, string[]> = {
      US: ["u1", "u2", "u3"],
      GB: ["g1", "g2"],
    };
    const baseDeps = {
      country: "US",
      listRefreshCountries: () => ["US", "GB"],
      listKeywords: (country: string) =>
        (byCountry[country] ?? []).map((keyword) =>
          buildKeyword({
            keyword,
            normalizedKeyword: keyword,
            country,
            orderExpiresAt: "2026-03-06T00:00:00.000Z",
          })
        ),
      listAppKeywords: (country: string) =>
        (byCountry[country] ?? []).map((keyword) =>
          buildAssociation({ keyword, country, appId: "app-1" })
        ),
      listAssociatedAppIds: () => new Set(["app-1"]),
      listOrderRelevantAppIds: () => new Set(["app-1"]),
      isForegroundBusy: () => false,
      nowMs: () => now,
      sleep: async () => {},
      readMemoryUsage: () => ({ rss: 0, heapUsed: 0 }),
    };

    it("counts ranking and popularity failures per storefront instead of calling them refreshed", async () => {
      const manager = createStartupRefreshManager({
        ...baseDeps,
        enrichKeywords: async (country, items) => {
          if (country === "US") {
            return {
              items: [{ keyword: items[0].keyword }],
              failedKeywords: items
                .slice(1)
                .map((item) => ({ keyword: item.keyword, reasonCode: "EMPTY_ORDER" })),
              popularityFailures: [{ keyword: "u1", reasonCode: "HTTP_500" }],
            };
          }
          return { items, failedKeywords: [] };
        },
      });

      manager.start({ force: true, trigger: "scheduled" });
      await waitForManagerToFinish(manager);

      const state = manager.getState();
      // Partial failures are counted, but the run still completed.
      expect(state.status).toBe("completed");
      expect(state.trigger).toBe("scheduled");
      expect(state.counters).toMatchObject({
        eligibleKeywordCount: 5,
        refreshedKeywordCount: 3,
        failedKeywordCount: 2,
        popularityFailedKeywordCount: 1,
      });
      expect(state.counters.storefronts).toEqual([
        expect.objectContaining({
          country: "US",
          eligible: 3,
          refreshed: 1,
          failed: 2,
          skipped: 0,
          popularityFailed: 1,
          failureReasons: { EMPTY_ORDER: 2, "popularity:HTTP_500": 1 },
        }),
        expect.objectContaining({ country: "GB", refreshed: 2, failed: 0 }),
      ]);
    });

    it("feeds a batch whose keywords all failed into the abandon logic", async () => {
      const attempted: string[] = [];
      const manager = createStartupRefreshManager({
        ...baseDeps,
        keywordBatchSize: 1,
        abandonCountryAfterFailedKeywords: 2,
        enrichKeywords: async (country, items) => {
          attempted.push(`${country}:${items[0].keyword}`);
          if (country === "US") {
            return {
              items: [],
              failedKeywords: [{ keyword: items[0].keyword, reasonCode: "HTTP_403" }],
            };
          }
          return { items, failedKeywords: [] };
        },
      });

      manager.start({ force: true });
      await waitForManagerToFinish(manager);

      const state = manager.getState();
      expect(attempted.filter((entry) => entry.startsWith("US:"))).toHaveLength(2);
      expect(state.counters.skippedCountries).toEqual(["US"]);
      expect(state.counters.storefronts[0]).toMatchObject({
        country: "US",
        failed: 2,
        skipped: 1,
        abandoned: true,
      });
      // A storefront that failed wholesale must not read as "completed".
      expect(state.status).toBe("failed");
      expect(state.lastError).toMatch(/All keywords failed/);
    });

    it("treats a popularity session failure as reauth but keeps the ranking work", async () => {
      const reauth = Object.assign(new Error("session expired"), {
        code: "ASO_AUTH_REAUTH_REQUIRED",
      });
      const onReauthenticationRequired = jest.fn();
      const skipFlags: boolean[] = [];
      const manager = createStartupRefreshManager({
        ...baseDeps,
        isAuthReauthRequiredError: (error) =>
          (error as { code?: string })?.code === "ASO_AUTH_REAUTH_REQUIRED",
        onReauthenticationRequired,
        enrichKeywords: async (_country, items, options) => {
          skipFlags.push(options.skipPopularity);
          return {
            items,
            failedKeywords: [],
            reauthError: options.skipPopularity ? null : reauth,
          };
        },
      });

      manager.start({ force: true });
      await waitForManagerToFinish(manager);

      const state = manager.getState();
      expect(state.requiresReauthentication).toBe(true);
      expect(state.counters.refreshedKeywordCount).toBe(5);
      expect(onReauthenticationRequired).toHaveBeenCalledTimes(1);
      expect(skipFlags).toEqual([false, true]);
    });

    it("records the run and each storefront through the recorder", async () => {
      const calls: string[] = [];
      const manager = createStartupRefreshManager({
        ...baseDeps,
        enrichKeywords: async (_country, items) => ({ items, failedKeywords: [] }),
        recorder: {
          start: ({ trigger }) => {
            calls.push(`start:${trigger}`);
            return 7;
          },
          saveStorefront: (runId, sf) => calls.push(`sf:${runId}:${sf.country}:${sf.refreshed}`),
          finish: (runId, finished) => calls.push(`finish:${runId}:${finished.status}`),
        },
      });

      manager.start({ trigger: "catch-up", force: true });
      await waitForManagerToFinish(manager);
      await Promise.resolve();

      expect(manager.getState().runId).toBe(7);
      expect(calls).toEqual([
        "start:catch-up",
        "sf:7:US:3",
        "sf:7:GB:2",
        "finish:7:completed",
      ]);
    });
  });

  describe("storefront concurrency and request metrics", () => {
    it("refreshes storefronts in parallel workers and records requests per host", async () => {
      const active: string[] = [];
      let maxActive = 0;
      let counters = { mzsearch: { requests: 10, status429: 0, status403: 0, status5xx: 0, throttles: 0 } };
      let now = Date.parse("2026-03-10T00:00:00.000Z");
      const releases: Array<() => void> = [];
      const manager = createStartupRefreshManager({
        country: "US",
        listRefreshCountries: () => ["US", "GB", "DE"],
        listKeywords: (country) => [
          buildKeyword({ keyword: `${country}-k`, normalizedKeyword: `${country}-k`, country, orderExpiresAt: "2026-03-06T00:00:00.000Z" }),
        ],
        listAppKeywords: (country) => [buildAssociation({ keyword: `${country}-k`, country })],
        listAssociatedAppIds: () => new Set(["app-1"]),
        listOrderRelevantAppIds: () => new Set(["app-1"]),
        isForegroundBusy: () => false,
        nowMs: () => now,
        sleep: async () => {},
        readMemoryUsage: () => ({ rss: 0, heapUsed: 0 }),
        storefrontConcurrency: 2,
        readRequestCounters: () => counters,
        readRateSnapshot: () => ({ mzsearch: { capPerMin: 30 } }),
        enrichKeywords: async (country, items) => {
          active.push(country);
          maxActive = Math.max(maxActive, active.length);
          await new Promise<void>((resolve) => releases.push(resolve));
          active.splice(active.indexOf(country), 1);
          return { items, failedKeywords: [] };
        },
      });

      manager.start({ force: true });
      for (let i = 0; i < 20 && releases.length < 2; i += 1) await Promise.resolve();
      expect(maxActive).toBe(2);
      counters = { mzsearch: { requests: 40, status429: 1, status403: 0, status5xx: 0, throttles: 1 } };
      now += 3 * 60_000;
      while (manager.getState().status === "running") {
        releases.shift()?.();
        await new Promise((resolve) => setImmediate(resolve));
      }

      const state = manager.getState();
      expect(state.counters.refreshedKeywordCount).toBe(3);
      expect(state.counters.requests).toEqual({
        durationMs: 180_000,
        byHost: {
          mzsearch: { requests: 30, status429: 1, status403: 0, status5xx: 0, throttles: 1, perMin: 10 },
        },
        rates: { mzsearch: { capPerMin: 30 } },
      });
    });

    it("records the run's iTunes lookup cache hits with the request metrics", async () => {
      let hits = 100;
      const manager = createStartupRefreshManager({
        country: "US",
        listKeywords: () => [
          buildKeyword({ keyword: "k", normalizedKeyword: "k", orderExpiresAt: "2026-03-06T00:00:00.000Z" }),
        ],
        listAppKeywords: () => [buildAssociation({ keyword: "k" })],
        listAssociatedAppIds: () => new Set(["app-1"]),
        listOrderRelevantAppIds: () => new Set(["app-1"]),
        isForegroundBusy: () => false,
        sleep: async () => {},
        readMemoryUsage: () => ({ rss: 0, heapUsed: 0 }),
        readRequestCounters: () => ({}),
        readLookupCacheHits: () => hits,
        enrichKeywords: async (_country, items) => {
          hits += 42;
          return { items, failedKeywords: [] };
        },
      });

      manager.start({ force: true });
      await waitForManagerToFinish(manager);

      expect(manager.getState().counters.requests?.lookupCacheHits).toBe(42);
    });
  });
});
