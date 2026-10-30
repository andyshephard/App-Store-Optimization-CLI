import * as fs from "fs";
import * as path from "path";
import { calculatePlayDifficulty, detectPlayTitleMatch, playAppStrength } from "./play-difficulty";
import { parsePlaySearchPage, type PlaySearchApp } from "./play-search-parser";

function app(overrides: Partial<PlaySearchApp>): PlaySearchApp {
  return {
    appId: "com.example.app",
    title: "Example",
    developer: null,
    category: null,
    installs: null,
    installsBand: null,
    rating: null,
    ratingCount: null,
    free: true,
    isTopCard: false,
    iconUrl: null,
    ...overrides,
  };
}

describe("play difficulty", () => {
  it("detects title matches", () => {
    expect(detectPlayTitleMatch("Micro Learning Daily", "micro learning")).toBe("titleExactPhrase");
    expect(detectPlayTitleMatch("Learning, micro style", "micro learning")).toBe("titleAllWords");
    expect(detectPlayTitleMatch("Headway", "micro learning")).toBe("none");
    // Whole words only.
    expect(detectPlayTitleMatch("Microlearning", "micro")).toBe("none");
  });

  it("scores stronger apps higher", () => {
    const weak = playAppStrength(app({ installs: 500, rating: 3 }), "history");
    const strong = playAppStrength(app({ installs: 10_000_000, rating: 4.8, title: "History" }), "history");
    expect(strong).toBeGreaterThan(weak);
    expect(playAppStrength(app({ installs: 99 }), "x")).toBe(0);
    expect(playAppStrength(app({ installs: 1e9, rating: 5, title: "x" }), "x")).toBe(1);
  });

  it("stays within 5-100 and counts empty slots as easy", () => {
    expect(calculatePlayDifficulty([], "anything")).toBe(5);
    const giants = Array.from({ length: 10 }, () => app({ installs: 1e9, rating: 5, title: "x" }));
    expect(calculatePlayDifficulty(giants, "x")).toBe(100);
    expect(calculatePlayDifficulty(giants.slice(0, 3), "x")).toBeLessThan(
      calculatePlayDifficulty(giants, "x")
    );
  });

  it("rates a crowded generic term above a niche brand term", () => {
    const page = (name: string) =>
      fs.readFileSync(path.join(__dirname, "__fixtures__", `play-search-${name}.html`), "utf8");
    const microlearning = calculatePlayDifficulty(
      parsePlaySearchPage(page("microlearning"), "microlearning").apps,
      "microlearning"
    );
    const chunks = calculatePlayDifficulty(parsePlaySearchPage(page("chunks"), "chunks").apps, "chunks");
    expect(microlearning).toBeGreaterThan(chunks);
  });
});
