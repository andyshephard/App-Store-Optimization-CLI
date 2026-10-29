import {
  createPacedHintFetcher,
  measureAutocomplete,
  parseHintTerms,
  refreshAutocomplete,
} from "./autocomplete-demand-service";
import {
  countTrackedKeywords,
  listKeywordsDueForAutocomplete,
  upsertKeywordAutocomplete,
} from "../../db/aso-keyword-autocomplete";

jest.mock("../../db/aso-keyword-autocomplete", () => ({
  countTrackedKeywords: jest.fn(() => 0),
  listKeywordsDueForAutocomplete: jest.fn(() => []),
  upsertKeywordAutocomplete: jest.fn(),
}));

describe("autocomplete-demand-service", () => {
  it("parses suggestion terms from Apple's plist, in order", () => {
    const body = `<?xml version="1.0"?><plist><dict><key>title</key><string>Suggestions</string>
      <key>hints</key><array>
        <dict><key>term</key><string>stoic</string><key>url</key><string>x</string></dict>
        <dict><key>term</key><string>Stoicism</string><key>url</key><string>y</string></dict>
        <dict><key>term</key><string>fun &amp; facts</string></dict>
      </array></dict></plist>`;
    expect(parseHintTerms(body)).toEqual(["stoic", "stoicism", "fun & facts"]);
  });

  it("returns the fewest letters before the term is suggested, and its rank", async () => {
    const hints = jest.fn(async (prefix: string) =>
      prefix === "stoi" ? ["stoic", "stoic widget", "stoicism"] : ["something else"]
    );
    await expect(measureAutocomplete("Stoicism", "US", hints)).resolves.toEqual({
      lettersNeeded: 4,
      hintRank: 3,
    });
    expect(hints.mock.calls.map((c) => c[0])).toEqual(["st", "sto", "stoi"]);
  });

  it("returns nulls when never suggested, stopping once suggestions run out", async () => {
    const hints = jest.fn(async (prefix: string) => (prefix.length <= 3 ? ["viking"] : []));
    await expect(measureAutocomplete("viking history", "US", hints)).resolves.toEqual({
      lettersNeeded: null,
      hintRank: null,
    });
    expect(hints).toHaveBeenCalledTimes(3);
  });

  it("skips prefixes that end in a space", async () => {
    const hints = jest.fn(async (prefix: string) => (prefix === "fun f" ? ["fun facts"] : ["fun"]));
    await measureAutocomplete("fun facts", "US", hints);
    expect(hints.mock.calls.map((c) => c[0])).not.toContain("fun ");
  });
});

describe("paced, cached autocomplete refresh", () => {
  beforeEach(() => jest.clearAllMocks());

  it("asks each prefix once and pauses before every real request", async () => {
    const sleeps: number[] = [];
    const fetch = jest.fn(async (prefix: string) =>
      prefix === "budg" ? ["budget", "budget planner"] : ["x"]
    );
    const fetcher = createPacedHintFetcher({
      delayMs: 250,
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await measureAutocomplete("budget", "US", fetcher.hints);
    await measureAutocomplete("budget planner", "US", fetcher.hints);

    // bu, bud, budg once each; the second keyword is served from the cache.
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(["bu", "bud", "budg"]);
    expect(fetcher.stats()).toEqual({ requests: 3, cacheHits: 3 });
    // A pause before every request but the first, none for cache hits.
    expect(sleeps).toEqual([250, 250]);
  });

  it("checks about a seventh of the tracked keywords per call", async () => {
    jest.mocked(countTrackedKeywords).mockReturnValue(100);
    jest.mocked(listKeywordsDueForAutocomplete).mockReturnValue(["ab"]);

    const result = await refreshAutocomplete("GB", {
      fetch: async () => [],
      sleep: async () => {},
    });

    expect(jest.mocked(listKeywordsDueForAutocomplete).mock.calls[0][2]).toBe(15);
    expect(result).toMatchObject({ started: true, checked: 1, requests: 1 });
    expect(jest.mocked(upsertKeywordAutocomplete)).toHaveBeenCalledTimes(1);
  });
});
