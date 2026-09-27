import { measureAutocomplete, parseHintTerms } from "./autocomplete-demand-service";

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
