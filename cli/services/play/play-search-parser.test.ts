import * as fs from "fs";
import * as path from "path";
import {
  extractPlayDataBlocks,
  parseInstallBand,
  parsePlaySearchPage,
  PlayContractError,
} from "./play-search-parser";

// Real search pages from play.google.com (US, en, 2026-10-30), trimmed to the
// ds:4 block with long strings and images cut.
function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "__fixtures__", `play-search-${name}.html`), "utf8");
}

/** Rebuilds a page around an edited ds:4 block. */
function pageWith(data: unknown): string {
  return `<html><body><script class="ds:4">AF_initDataCallback({key: 'ds:4', hash: '7', data:${JSON.stringify(
    data
  )}, sideChannel: {}});</script></body></html>`;
}

function ds4(name: string): any {
  return extractPlayDataBlocks(fixture(name)).get("ds:4");
}

function rangeToken(from: number, to: number): string {
  return Buffer.from(`\u0012search_results_cluster_apps_range_${from}_${to}\u0010`, "latin1").toString(
    "base64"
  );
}

function expectContractError(html: string, signal: string): void {
  try {
    parsePlaySearchPage(html, "test");
  } catch (error) {
    expect(error).toBeInstanceOf(PlayContractError);
    expect((error as PlayContractError).signal).toBe(signal);
    expect((error as PlayContractError).code).toBe("PLAY_CONTRACT_CHANGED");
    return;
  }
  throw new Error("expected a PlayContractError");
}

describe("parsePlaySearchPage", () => {
  it("reads the plain 30-result list, with Chunks first for 'chunks'", () => {
    const result = parsePlaySearchPage(fixture("chunks"), "chunks");
    expect(result.layout).toBe("list");
    expect(result.apps).toHaveLength(30);
    expect(result.excludedClusterApps).toBe(0);
    expect(result.apps[0]).toEqual({
      appId: "com.andyshephard.chunks",
      title: "Chunks Microlearning",
      developer: "Andrew Shephard",
      category: "Education",
      installs: 5000,
      installsBand: "5,000+",
      rating: expect.any(Number),
      ratingCount: null,
      free: true,
      isTopCard: false,
    });
    expect(result.apps[1].appId).toBe("com.chunks.chunks");
    // No rating on an app without enough reviews.
    expect(result.apps[1].rating).toBeNull();
  });

  it("ranks Chunks inside the microlearning list", () => {
    const result = parsePlaySearchPage(fixture("microlearning"), "microlearning");
    const ids = result.apps.map((app) => app.appId);
    expect(ids).toHaveLength(30);
    expect(ids[0]).toBe("com.app.smartyme");
    expect(ids.indexOf("com.andyshephard.chunks") + 1).toBeGreaterThan(0);
  });

  it("puts a top-result card at rank 1 ahead of the 1-20 range ('stoic')", () => {
    const result = parsePlaySearchPage(fixture("stoic"), "stoic");
    expect(result.layout).toBe("top-card");
    expect(result.apps).toHaveLength(20);
    expect(result.apps[0]).toMatchObject({
      appId: "com.stoicroutine.stoic",
      title: "stoic. journal & mental health",
      developer: "Stoic app inc.",
      category: "Health & Fitness",
      installs: 100000,
      installsBand: "100,000+",
      ratingCount: 3494,
      isTopCard: true,
    });
    expect(result.apps[1]).toMatchObject({ appId: "stoameditation.stoa", isTopCard: false });
  });

  it("accepts a short list as the complete ranking ('audio stories', 11 results)", () => {
    const result = parsePlaySearchPage(fixture("audio-stories"), "audio stories");
    expect(result.layout).toBe("list");
    expect(result.apps).toHaveLength(11);
    expect(result.apps[0].appId).toBe("com.audible.application");
  });

  it("returns an empty ranking for a no-results page", () => {
    expect(parsePlaySearchPage(fixture("zzqxjvkwqpz"), "zzqxjvkwqpz")).toEqual({
      layout: "empty",
      apps: [],
      excludedClusterApps: 0,
    });
  });

  it("leaves unlabelled clusters (similar apps) out of the ranking", () => {
    const data = ds4("chunks");
    const organic = data[0][1][0];
    const cluster = JSON.parse(JSON.stringify(organic));
    cluster[3] = [Buffer.from("similar_apps_cluster", "latin1").toString("base64")];
    cluster[22][0] = cluster[22][0].slice(0, 5);
    data[0][1].push(cluster);
    const result = parsePlaySearchPage(pageWith(data), "chunks");
    expect(result.apps).toHaveLength(30);
    expect(result.excludedClusterApps).toBe(5);
  });

  it("joins consecutive ranges in order", () => {
    const data = ds4("chunks");
    const organic = data[0][1][0];
    const second = JSON.parse(JSON.stringify(organic));
    organic[3] = [rangeToken(0, 10)];
    organic[22][0] = organic[22][0].slice(0, 10);
    second[3] = [rangeToken(10, 15)];
    second[22][0] = second[22][0].slice(10, 15);
    data[0][1].push(second);
    const result = parsePlaySearchPage(pageWith(data), "chunks");
    expect(result.apps).toHaveLength(15);
    expect(result.apps[10].appId).toBe(ds4("chunks")[0][1][0][22][0][10][0][0][0]);
  });

  it("is a contract failure when the range label disagrees with the items", () => {
    const data = ds4("chunks");
    data[0][1][0][22][0] = data[0][1][0][22][0].slice(0, 12);
    expectContractError(pageWith(data), "range_mismatch");
  });

  it("is a contract failure when a 1-based range has no top card before it", () => {
    const data = ds4("stoic");
    data[0][1].shift();
    expectContractError(pageWith(data), "range_mismatch");
  });

  it("is a contract failure when only unlabelled clusters are present", () => {
    const data = ds4("chunks");
    data[0][1][0][3] = null;
    expectContractError(pageWith(data), "only_unlabelled_clusters");
  });

  it("is a contract failure when an item has lost its package id", () => {
    const data = ds4("chunks");
    data[0][1][0][22][0][3][0][0] = null;
    expectContractError(pageWith(data), "item_shape");
  });

  it("is a contract failure for a page without result data", () => {
    expectContractError("<html><body>consent wall</body></html>", "no_result_sections");
  });
});

describe("parseInstallBand", () => {
  it.each([
    ["5,000+", 5000],
    ["50+", 50],
    ["1,000,000+", 1_000_000],
    ["100K+", 100_000],
    ["1M+", 1_000_000],
    ["1.5M+", 1_500_000],
    ["5B+", 5_000_000_000],
  ])("%s -> %d", (band, expected) => {
    expect(parseInstallBand(band)).toBe(expected);
  });

  it("returns null for anything else", () => {
    expect(parseInstallBand("")).toBeNull();
    expect(parseInstallBand(null)).toBeNull();
    expect(parseInstallBand("lots")).toBeNull();
  });
});
