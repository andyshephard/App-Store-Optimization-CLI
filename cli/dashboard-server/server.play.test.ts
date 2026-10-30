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
});
