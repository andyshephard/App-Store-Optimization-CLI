import {
  formatPlayPlacements,
  mergeStoreKeywords,
  playPlacements,
  playRankFor,
  readStoredShowPlayCompetitors,
  shortPlayAppName,
  writeStoredShowPlayCompetitors,
  type PlayApp,
  readStoredStoreMode,
  sharedCountries,
  sortMergedRows,
  storeKeywordKey,
  toIosSide,
  toPlaySide,
  writeStoredStoreMode,
  type PlayKeywordItem,
  type StoreSide,
} from "./store-merge";

function side(keyword: string, overrides: Partial<StoreSide> = {}): StoreSide {
  return {
    keyword,
    popularity: null,
    popularityChange: null,
    suggestionRank: null,
    popularityPending: false,
    rank: null,
    rankChange: null,
    status: "ok",
    ...overrides,
  };
}

function playItem(overrides: Partial<PlayKeywordItem>): PlayKeywordItem {
  return {
    keyword: "microlearning",
    normalizedKeyword: "microlearning",
    country: "US",
    appId: "com.andyshephard.chunks",
    autocompleteLetters: 6,
    autocompleteRank: 3,
    autocompleteCheckedAt: "2026-10-30T00:00:00.000Z",
    difficultyScore: 36,
    resultCount: 30,
    rankDepth: 30,
    layout: "list",
    rank: 6,
    previousRank: 7,
    rankChange: -1,
    addedAt: null,
    updatedAt: "2026-10-30T00:00:00.000Z",
    keywordStatus: "ok",
    failure: null,
    ...overrides,
  };
}

describe("storeKeywordKey", () => {
  it("joins on case-insensitive, whitespace-collapsed text", () => {
    expect(storeKeywordKey("  Bite  Sized Learning ")).toBe("bite sized learning");
  });
});

describe("toIosSide / toPlaySide", () => {
  it("reads the selected app's position and popularity trend", () => {
    const ios = toIosSide(
      {
        keyword: "stoicism",
        popularity: 40,
        previousPopularity: 35,
        positions: [
          { appId: "other", previousPosition: 1, currentPosition: 1 },
          { appId: "6692632196", previousPosition: 12, currentPosition: 9 },
        ],
      },
      "6692632196"
    );
    expect(ios).toMatchObject({ popularity: 40, popularityChange: 5, rank: 9, rankChange: -3 });
  });

  it("treats Apple's 0 popularity as no data and a missing position as unranked", () => {
    const ios = toIosSide({ keyword: "x", popularity: 0, positions: [] }, "6692632196");
    expect(ios).toMatchObject({ popularity: null, popularityChange: null, rank: null, rankChange: null });
  });

  it("uses autocomplete letters as Play popularity", () => {
    expect(toPlaySide(playItem({}))).toMatchObject({
      popularity: 6,
      suggestionRank: 3,
      rank: 6,
      rankChange: -1,
    });
  });
});

describe("mergeStoreKeywords", () => {
  it("makes one row per keyword and leaves the untracked store empty", () => {
    const rows = mergeStoreKeywords(
      [side("Microlearning", { rank: 24 }), side("stoicism")],
      [side("microlearning", { rank: 6 }), side("audio stories")]
    );
    expect(rows.map((row) => row.key)).toEqual(["microlearning", "stoicism", "audio stories"]);
    expect(rows[0]).toMatchObject({
      keyword: "Microlearning",
      ios: { rank: 24 },
      play: { rank: 6 },
    });
    expect(rows[1].play).toBeNull();
    expect(rows[2].ios).toBeNull();
  });

  it("keeps the first row for a store when it repeats a keyword", () => {
    const rows = mergeStoreKeywords([side("a", { rank: 1 }), side("A ", { rank: 2 })], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].ios?.rank).toBe(1);
  });
});

describe("sortMergedRows", () => {
  const rows = mergeStoreKeywords(
    [side("b", { rank: 5, popularity: 20 }), side("a", { rank: 2, popularity: 60 }), side("c")],
    [side("c", { rank: 1, popularity: 3 }), side("a", { popularity: 8 }), side("d", { rank: 9 })]
  );
  const keys = (key: Parameters<typeof sortMergedRows>[1], dir: "asc" | "desc") =>
    sortMergedRows(rows, key, dir).map((row) => row.key);

  it("sorts by keyword", () => {
    expect(keys("keyword", "asc")).toEqual(["a", "b", "c", "d"]);
    expect(keys("keyword", "desc")).toEqual(["d", "c", "b", "a"]);
  });

  it("keeps not-tracked and unranked rows last in both directions", () => {
    expect(keys("iosRank", "asc")).toEqual(["a", "b", "c", "d"]);
    expect(keys("iosRank", "desc")).toEqual(["b", "a", "c", "d"]);
    expect(keys("playRank", "asc")).toEqual(["c", "d", "a", "b"]);
    expect(keys("playRank", "desc")).toEqual(["d", "c", "a", "b"]);
  });

  it("sorts popularity per store", () => {
    expect(keys("iosPopularity", "desc")).toEqual(["a", "b", "c", "d"]);
    // Fewer letters is more popular.
    expect(keys("playPopularity", "asc")).toEqual(["c", "a", "b", "d"]);
  });

  it("does not mutate its input", () => {
    const before = rows.map((row) => row.key);
    sortMergedRows(rows, "playRank", "asc");
    expect(rows.map((row) => row.key)).toEqual(before);
  });
});

describe("sharedCountries", () => {
  it("keeps App Store order and only countries both stores enable", () => {
    expect(sharedCountries(["US", "GB", "DE"], ["GB", "US", "AU"])).toEqual(["US", "GB"]);
  });
});

describe("store mode storage", () => {
  it("falls back to the App Store when storage is unavailable", () => {
    // The node test environment has no localStorage: every access throws.
    expect(readStoredStoreMode()).toBe("ios");
    expect(() => writeStoredStoreMode("both")).not.toThrow();
  });
});

describe("Play competitors", () => {
  const app = (id: string, name: string | null, kind: PlayApp["kind"] = "competitor"): PlayApp => ({
    id,
    name,
    developer: null,
    iconUrl: null,
    kind,
    source: kind === "owned" ? "ASO_PLAY_APP_ID" : "dashboard",
    removable: kind !== "owned",
    addedAt: null,
  });
  const OURS = "com.andyshephard.chunks";
  const apps = [
    app(OURS, "Chunks Microlearning", "owned"),
    app("com.learnpaladin", "Paladin: Learn Anything"),
    app("com.nibble.lesson", "Nibble - Daily Lessons"),
    app("com.deepstash", null),
  ];
  const item = playItem({
    rank: 6,
    competitorRanks: { "com.learnpaladin": 3, "com.nibble.lesson": 7, "com.deepstash": null },
  });

  it("shortens titles at the first colon or dash, else uses the package", () => {
    expect(shortPlayAppName(apps[1])).toBe("Paladin");
    expect(shortPlayAppName(apps[2])).toBe("Nibble");
    expect(shortPlayAppName({ id: "com.x", name: "Self-Help | Daily" })).toBe("Self-Help");
    expect(shortPlayAppName(apps[3])).toBe("deepstash");
    expect(shortPlayAppName({ id: "a.b", name: "A very long title without any separator" })).toBe(
      "A very long title witho…"
    );
  });

  it("reads our rank or a competitor's", () => {
    expect(playRankFor(item, OURS)).toBe(6);
    expect(playRankFor(item, "com.learnpaladin")).toBe(3);
    expect(playRankFor(item, "com.deepstash")).toBeNull();
    // Added after this list was read: unknown, shown as not ranked.
    expect(playRankFor(item, "com.brand.new")).toBeNull();
  });

  it("lists the other ranking apps best first, including ours for a competitor", () => {
    expect(formatPlayPlacements(playPlacements(item, apps, OURS))).toBe("Paladin 3 · Nibble 7");
    expect(formatPlayPlacements(playPlacements(item, apps, "com.nibble.lesson"))).toBe(
      "Paladin 3 · Chunks Microlearning 6"
    );
    expect(playPlacements(playItem({ rank: null, competitorRanks: {} }), apps, OURS)).toEqual([]);
  });

  it("gives a competitor's Play side its rank and no change", () => {
    expect(toPlaySide(item, "com.learnpaladin")).toMatchObject({ rank: 3, rankChange: null });
    expect(toPlaySide(item, OURS)).toMatchObject({ rank: 6, rankChange: -1 });
  });

  it("shows the Competitors column when storage is unavailable", () => {
    // No localStorage in the node environment (the jsdom tests cover storing it).
    expect(() => writeStoredShowPlayCompetitors(false)).not.toThrow();
    expect(readStoredShowPlayCompetitors()).toBe(true);
  });
});
