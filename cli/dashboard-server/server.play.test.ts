import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { jest } from "@jest/globals";
import { createAppKeywords, deleteAppKeywords } from "../db/app-keywords";
import { closeDbForTests } from "../db/store";
import {
  addPlayAppKeywords,
  listPlayAppKeywords,
  recordPlayKeywordFailure,
  savePlayKeywordObservation,
} from "../db/play-keywords";
import { listPlayCompetitorApps } from "../db/play-competitors";
import { recordPlaySuggestions } from "../db/play-suggestions";
import { upsertOwnedApps } from "../db/owned-apps";
import { refreshPlayKeywords } from "../services/play/play-keyword-service";
import { createServerRequestHandler } from "./server";

jest.mock("../db/owned-apps", () => ({
  getOwnedAppById: jest.fn(() => null),
  listOwnedApps: jest.fn(() => []),
  listOwnedAppIdsByKind: jest.fn(() => []),
  upsertOwnedApps: jest.fn(),
  upsertOwnedAppSnapshots: jest.fn(),
}));
jest.mock("../db/refresh-runs");
jest.mock("../db/app-keywords", () => ({
  listAllAppKeywords: jest.fn(() => []),
  listByApp: jest.fn(() => []),
  createAppKeywords: jest.fn(),
  deleteAppKeywords: jest.fn(() => 0),
  getAppLastKeywordAddedAtMap: jest.fn(() => new Map()),
  setAppKeywordFavorite: jest.fn(() => true),
}));
jest.mock("../services/keywords/keyword-pipeline-service", () => ({
  keywordPipelineService: {
    normalizeKeywords: jest.fn((input: string[]) =>
      Array.from(new Set(input.map((item) => item.trim().toLowerCase()).filter(Boolean)))
    ),
    runPopularityStage: jest.fn(async () => ({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: [],
      failedKeywords: [],
      filteredOut: [],
    })),
    refreshStartup: jest.fn(async () => []),
  },
}));
jest.mock("../services/play/play-keyword-service", () => ({
  isPlayRefreshRunning: jest.fn(() => false),
  refreshPlayKeywords: jest.fn(async () => null),
  refreshPlayAutocomplete: jest.fn(async () => null),
}));
jest.mock("../services/auth/aso-auth-service", () => ({
  asoAuthService: { reAuthenticate: jest.fn(async () => {}) },
}));
jest.mock("../services/keywords/aso-popularity-service", () => ({
  isAsoAuthReauthRequiredError: jest.fn(() => false),
}));
jest.mock("../services/telemetry/error-reporter", () => ({
  reportBugsnagError: jest.fn(),
}));
jest.mock("../utils/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TEST_DB_PATH = path.join(os.tmpdir(), `aso-server-play-${process.pid}-${Date.now()}.sqlite`);
const OURS = "com.andyshephard.chunks";

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function requestJson(params: {
  method: string;
  path: string;
  body?: unknown;
}): Promise<{ statusCode: number; body: any }> {
  const handler = createServerRequestHandler();
  const payload = params.body ? JSON.stringify(params.body) : "";
  return new Promise((resolve) => {
    const req = new PassThrough() as any;
    req.method = params.method;
    req.url = params.path;
    req.headers = { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
    const res = new PassThrough() as any;
    const chunks: Buffer[] = [];
    let statusCode = 200;
    res.setHeader = () => {};
    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    res.on("finish", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ statusCode, body: raw ? JSON.parse(raw) : null });
    });
    handler(req, res);
    if (payload) req.write(payload);
    req.end();
  });
}

function observe(keyword: string, orderedAppIds: string[], observedAt = "2026-10-30T03:00:00.000Z") {
  savePlayKeywordObservation(
    {
      country: "US",
      keyword,
      difficultyScore: 42,
      difficultyModelVersion: "play-installs-v1",
      resultCount: orderedAppIds.length,
      rankDepth: orderedAppIds.length,
      layout: "list",
      orderedAppIds,
      topApps: orderedAppIds.map((appId) => ({
        appId,
        title: appId,
        developer: null,
        category: null,
        installs: 1000,
        installsBand: "1,000+",
        rating: null,
        ratingCount: null,
        isTopCard: false,
      })),
      observedAt,
    },
    { rosterAppIds: ["com.rival.app"] }
  );
}

describe("Google Play on the keyword API (platform=android)", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
    process.env.ASO_PLAY_COUNTRIES = "US,GB";
    process.env.ASO_PLAY_ROSTER_APP_IDS = "com.rival.app";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
    delete process.env.ASO_PLAY_COUNTRIES;
    delete process.env.ASO_PLAY_ROSTER_APP_IDS;
    delete process.env.ASO_PLAY_APP_ID;
  });

  it("lists Play keywords with ranks, competitor ranks and status", async () => {
    addPlayAppKeywords(OURS, ["microlearning", "chunks", "new term"], "US");
    observe("microlearning", ["com.app.smartyme", "com.rival.app", OURS]);
    observe("chunks", ["x.y", OURS]);
    observe("chunks", [OURS, "x.y"], "2026-10-31T03:00:00.000Z");
    recordPlayKeywordFailure({
      country: "US",
      keyword: "new term",
      stage: "search",
      reasonCode: "HTTP_429",
      message: "Too Many Requests",
      statusCode: 429,
    });

    const response = await requestJson({
      method: "GET",
      path: `/api/aso/keywords?platform=android&country=US&appId=${OURS}&sortBy=rank`,
    });

    expect(response.statusCode).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({
      platform: "android",
      totalCount: 3,
      associatedCount: 3,
      failedCount: 1,
      pendingCount: 0,
      hasNextPage: false,
    });
    expect(data.items.map((item: any) => [item.keyword, item.rank])).toEqual([
      ["chunks", 1],
      ["microlearning", 3],
      ["new term", null],
    ]);
    expect(data.items[0]).toMatchObject({
      platform: "android",
      country: "US",
      appId: OURS,
      popularity: null,
      previousRank: 2,
      rankChange: -1,
      difficultyScore: 42,
      appCount: 2,
      rankDepth: 2,
      orderedAppIds: [OURS, "x.y"],
      competitorRanks: { "com.rival.app": null },
      keywordStatus: "ok",
      positions: [{ appId: OURS, previousPosition: 2, currentPosition: 1 }],
    });
    expect(data.items[0].topApps).toBeUndefined();
    expect(data.items[1].competitorRanks).toEqual({ "com.rival.app": 2 });
    expect(data.items[2]).toMatchObject({
      keywordStatus: "failed",
      failure: { stage: "search", reasonCode: "HTTP_429", statusCode: 429, retryable: true },
    });
  });

  it("includes top apps on request and falls back to ASO_PLAY_APP_ID", async () => {
    process.env.ASO_PLAY_APP_ID = OURS;
    addPlayAppKeywords(OURS, ["chunks"], "US");
    observe("chunks", [OURS]);
    const response = await requestJson({
      method: "GET",
      path: "/api/aso/keywords?platform=android&includeTopApps=1",
    });
    delete process.env.ASO_PLAY_APP_ID;
    expect(response.body.data.items[0].topApps).toEqual([expect.objectContaining({ appId: OURS })]);
  });

  it("names the Play package on /api/aso/storefronts only when Play is configured", async () => {
    const unconfigured = await requestJson({ method: "GET", path: "/api/aso/storefronts" });
    expect(unconfigured.body.data).not.toHaveProperty("playAppId");
    process.env.ASO_PLAY_APP_ID = OURS;
    const configured = await requestJson({ method: "GET", path: "/api/aso/storefronts" });
    delete process.env.ASO_PLAY_APP_ID;
    expect(configured.body.data.playAppId).toBe(OURS);
  });

  it("keeps the App Store response when no platform is given", async () => {
    addPlayAppKeywords(OURS, ["chunks"], "US");
    observe("chunks", [OURS]);
    const response = await requestJson({ method: "GET", path: `/api/aso/keywords?appId=${OURS}` });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.items).toEqual([]);
    expect(response.body.data.platform).toBeUndefined();
  });

  it("rejects an unknown platform and a Play country that is not enabled", async () => {
    const bad = await requestJson({ method: "GET", path: "/api/aso/keywords?platform=windows&appId=x" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.errorCode).toBe("INVALID_REQUEST");

    const au = await requestJson({ method: "GET", path: `/api/aso/keywords?platform=android&country=AU&appId=${OURS}` });
    expect(au.statusCode).toBe(400);
    expect(au.body.errorCode).toBe("COUNTRY_NOT_ENABLED");
  });

  it("adds Play keywords through POST with platform in the body, and crawls only the new ones", async () => {
    addPlayAppKeywords(OURS, ["chunks"], "GB");
    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords",
      body: { platform: "android", appId: OURS, country: "GB", keywords: ["Chunks", "micro learning"] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body.data).toMatchObject({ platform: "android", addedCount: 1, refreshStarted: true });
    expect(listPlayAppKeywords({ appId: OURS, country: "GB" }).map((r) => r.keyword)).toEqual([
      "chunks",
      "micro learning",
    ]);
    expect(jest.mocked(refreshPlayKeywords)).toHaveBeenCalledWith({
      countries: ["GB"],
      keywords: ["micro learning"],
      force: true,
    });
    expect(jest.mocked(createAppKeywords)).not.toHaveBeenCalled();
  });

  it("defers the crawl when asked, with platform in the query string", async () => {
    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords?platform=android",
      body: { appId: OURS, country: "US", keywords: ["history"], defer: true },
    });
    expect(response.body.data).toMatchObject({ addedCount: 1, deferred: true, refreshStarted: false });
    expect(jest.mocked(refreshPlayKeywords)).not.toHaveBeenCalled();
  });

  it("still sends a body without platform to the App Store handler", async () => {
    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords",
      body: { appId: "123", country: "US", keywords: ["history"], defer: true },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body.data).toMatchObject({ deferred: true, pendingCount: 1 });
    expect(jest.mocked(createAppKeywords)).toHaveBeenCalledWith("123", ["history"], "US");
    expect(listPlayAppKeywords()).toEqual([]);
  });

  it("rejects invalid package names and over-long keywords", async () => {
    const badApp = await requestJson({
      method: "GET",
      path: "/api/aso/keywords?platform=android&country=US&appId=not%20a%20package",
    });
    expect(badApp.statusCode).toBe(400);
    expect(badApp.body.errorCode).toBe("INVALID_REQUEST");

    const badCompetitor = await requestJson({
      method: "GET",
      path: `/api/aso/keywords?platform=android&country=US&appId=${OURS}&competitors=a.b,%3Cscript%3E`,
    });
    expect(badCompetitor.statusCode).toBe(400);

    const longKeyword = await requestJson({
      method: "POST",
      path: "/api/aso/keywords",
      body: { platform: "android", appId: OURS, country: "US", keywords: ["x".repeat(101)] },
    });
    expect(longKeyword.statusCode).toBe(400);
    expect(listPlayAppKeywords()).toEqual([]);
  });

  it("removes Play keywords through DELETE", async () => {
    addPlayAppKeywords(OURS, ["a", "b"], "US");
    const response = await requestJson({
      method: "DELETE",
      path: "/api/aso/keywords",
      body: { platform: "android", appId: OURS, country: "US", keywords: ["a"] },
    });
    expect(response.body.data).toEqual({ platform: "android", removedCount: 1 });
    expect(listPlayAppKeywords().map((r) => r.keyword)).toEqual(["b"]);
    expect(jest.mocked(deleteAppKeywords)).not.toHaveBeenCalled();
  });

  it("serves Play position history, autocomplete and countries", async () => {
    addPlayAppKeywords(OURS, ["chunks"], "US");
    observe("chunks", ["x.y", OURS], "2026-10-29T03:00:00.000Z");
    observe("chunks", [OURS], "2026-10-30T03:00:00.000Z");

    const history = await requestJson({
      method: "GET",
      path: `/api/aso/position-history?platform=android&since=2026-10-01&appIds=${OURS}`,
    });
    expect(history.body.data.items).toEqual([
      { appId: OURS, keyword: "chunks", country: "US", date: "2026-10-29", position: 2 },
      { appId: OURS, keyword: "chunks", country: "US", date: "2026-10-30", position: 1 },
    ]);

    const autocomplete = await requestJson({ method: "GET", path: "/api/aso/autocomplete?platform=android&country=GB" });
    expect(autocomplete.body.data).toEqual({ platform: "android", country: "GB", running: false, items: [] });

    const storefronts = await requestJson({ method: "GET", path: "/api/aso/storefronts" });
    expect(storefronts.body.data.playCountries.map((c: any) => c.country)).toEqual(["US", "GB"]);
  });
  it("serves Play suggestions not already tracked on their own path", async () => {
    addPlayAppKeywords(OURS, ["microlearning"], "US");
    const seenAt = new Date().toISOString();
    recordPlaySuggestions({
      country: "US",
      prefix: "microl",
      seed: "microlearning",
      suggestions: ["microlife blood pressure app", "microlearning", "microlab"],
      seenAt,
    });

    const ideas = await requestJson({ method: "GET", path: "/api/aso/play-suggestions?country=US" });
    expect(ideas.statusCode).toBe(200);
    expect(ideas.body.data).toMatchObject({ platform: "android", country: "US", days: 14, totalCount: 2 });
    expect(ideas.body.data.items).toEqual([
      {
        keyword: "microlife blood pressure app",
        country: "US",
        prefix: "microl",
        letters: 6,
        position: 1,
        seed: "microlearning",
        prefixCount: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        tracked: false,
      },
      expect.objectContaining({ keyword: "microlab", position: 3 }),
    ]);

    const all = await requestJson({
      method: "GET",
      path: "/api/aso/play-suggestions?country=US&includeTracked=1&days=500",
    });
    expect(all.body.data.days).toBe(90);
    expect(all.body.data.items.map((i: any) => [i.keyword, i.tracked])).toEqual([
      ["microlife blood pressure app", false],
      ["microlearning", true],
      ["microlab", false],
    ]);

    const gb = await requestJson({ method: "GET", path: "/api/aso/play-suggestions?country=GB" });
    expect(gb.body.data.items).toEqual([]);

    const notEnabled = await requestJson({ method: "GET", path: "/api/aso/play-suggestions?country=DE" });
    expect([notEnabled.statusCode, notEnabled.body.errorCode]).toEqual([400, "COUNTRY_NOT_ENABLED"]);

    // The App Store's keyword ideas keep their own path and handler.
    const appStore = await requestJson({ method: "GET", path: "/api/aso/suggestions?country=US" });
    expect(appStore.body.errorCode).toBe("ADS_API_NOT_CONFIGURED");
  });

  describe("Play apps on /api/apps (platform=android)", () => {
    const top = (appId: string, title: string, iconUrl?: string | null) => ({
      appId,
      title,
      developer: `${title} Inc.`,
      category: null,
      installs: 1000,
      installsBand: "1,000+",
      rating: null,
      ratingCount: null,
      isTopCard: false,
      ...(iconUrl === undefined ? {} : { iconUrl }),
    });

    beforeEach(() => {
      process.env.ASO_PLAY_APP_ID = OURS;
    });

    afterEach(() => {
      delete process.env.ASO_PLAY_APP_ID;
    });

    it("lists our app and the roster, named from stored search results", async () => {
      addPlayAppKeywords(OURS, ["microlearning", "chunks"], "US");
      // An older crawl without icons, then a newer one with them.
      savePlayKeywordObservation({
        country: "US",
        keyword: "chunks",
        difficultyScore: 10,
        difficultyModelVersion: "play-installs-v1",
        resultCount: 2,
        rankDepth: 2,
        layout: "list",
        orderedAppIds: [OURS, "com.rival.app"],
        topApps: [top(OURS, "Chunks Old Title"), top("com.rival.app", "Rival: Old")],
        observedAt: "2026-10-29T03:00:00.000Z",
      });
      savePlayKeywordObservation({
        country: "US",
        keyword: "microlearning",
        difficultyScore: 10,
        difficultyModelVersion: "play-installs-v1",
        resultCount: 2,
        rankDepth: 2,
        layout: "list",
        orderedAppIds: ["com.rival.app", OURS],
        topApps: [
          top("com.rival.app", "Rival: Learn", "https://play-lh.googleusercontent.com/rival"),
          top(OURS, "Chunks Microlearning", null),
        ],
        observedAt: "2026-10-30T03:00:00.000Z",
      });
      await requestJson({
        method: "POST",
        path: "/api/apps",
        body: { platform: "android", appId: "com.learnpaladin" },
      });

      const response = await requestJson({ method: "GET", path: "/api/apps?platform=android" });
      expect(response.statusCode).toBe(200);
      expect(response.body.data.platform).toBe("android");
      expect(response.body.data.items).toEqual([
        {
          id: OURS,
          name: "Chunks Microlearning",
          developer: "Chunks Microlearning Inc.",
          iconUrl: null,
          kind: "owned",
          source: "ASO_PLAY_APP_ID",
          removable: false,
          addedAt: null,
        },
        {
          id: "com.rival.app",
          name: "Rival: Learn",
          developer: "Rival: Learn Inc.",
          iconUrl: "https://play-lh.googleusercontent.com/rival",
          kind: "competitor",
          source: "ASO_PLAY_ROSTER_APP_IDS",
          removable: false,
          addedAt: null,
        },
        {
          id: "com.learnpaladin",
          name: null,
          developer: null,
          iconUrl: null,
          kind: "competitor",
          source: "dashboard",
          removable: true,
          addedAt: expect.any(String),
        },
      ]);
    });

    it("adds a competitor whose ranks come back on the keyword list", async () => {
      addPlayAppKeywords(OURS, ["microlearning"], "US");
      observe("microlearning", ["com.deepstash", "com.rival.app", OURS]);

      const added = await requestJson({
        method: "POST",
        path: "/api/apps",
        body: { platform: "android", appId: " com.deepstash " },
      });
      expect(added.statusCode).toBe(201);
      expect(added.body.data).toEqual({
        platform: "android",
        id: "com.deepstash",
        name: "com.deepstash",
        added: true,
      });
      const again = await requestJson({
        method: "POST",
        path: "/api/apps",
        body: { platform: "android", appId: "com.deepstash" },
      });
      expect(again.body.data.added).toBe(false);
      // Already on the roster through the environment: nothing stored.
      const fromEnv = await requestJson({
        method: "POST",
        path: "/api/apps",
        body: { platform: "android", appId: "com.rival.app" },
      });
      expect(fromEnv.body.data.added).toBe(false);
      expect(listPlayCompetitorApps().map((app) => app.appId)).toEqual(["com.deepstash"]);

      const keywords = await requestJson({ method: "GET", path: "/api/aso/keywords?platform=android&country=US" });
      expect(keywords.body.data.items[0].competitorRanks).toEqual({
        "com.rival.app": 2,
        "com.deepstash": 1,
      });
      expect(jest.mocked(upsertOwnedApps)).not.toHaveBeenCalled();
    });

    it("rejects anything but another app's package name", async () => {
      for (const appId of ["", "nodots", "1com.example", "com.example app", `com.${"a".repeat(200)}`, OURS]) {
        const response = await requestJson({
          method: "POST",
          path: "/api/apps",
          body: { platform: "android", appId },
        });
        expect(response.statusCode).toBe(400);
        expect(response.body.errorCode ?? response.body.error?.code).toBe("INVALID_REQUEST");
      }
      expect(listPlayCompetitorApps()).toEqual([]);
    });

    it("removes a stored competitor but not one from the environment", async () => {
      await requestJson({ method: "POST", path: "/api/apps", body: { platform: "android", appId: "com.deepstash" } });

      const removed = await requestJson({
        method: "DELETE",
        path: "/api/apps",
        body: { platform: "android", appId: "com.deepstash" },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.body.data).toEqual({ platform: "android", id: "com.deepstash" });
      expect(listPlayCompetitorApps()).toEqual([]);

      const fromEnv = await requestJson({
        method: "DELETE",
        path: "/api/apps",
        body: { platform: "android", appId: "com.rival.app" },
      });
      expect(fromEnv.statusCode).toBe(400);
      const unknown = await requestJson({
        method: "DELETE",
        path: "/api/apps",
        body: { platform: "android", appId: "com.unknown.app" },
      });
      expect(unknown.statusCode).toBe(404);
    });

    it("still adds App Store research apps through the same route", async () => {
      const response = await requestJson({
        method: "POST",
        path: "/api/apps",
        body: { type: "research", name: "Ideas" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.body.data).toEqual({ id: "research:ideas", name: "Ideas" });
      expect(listPlayCompetitorApps()).toEqual([]);
    });
  });
});
