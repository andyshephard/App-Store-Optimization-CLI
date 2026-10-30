import * as fs from "fs";
import * as path from "path";
import { PlayContractError } from "./play-search-parser";
import { buildPlaySuggestBody, parsePlaySuggestResponse } from "./play-suggest-parser";

// Real IJ4APc responses (US, en, 2026-10-30).
function fixture(prefix: string): string {
  return fs.readFileSync(path.join(__dirname, "__fixtures__", `play-suggest-${prefix}.txt`), "utf8");
}

describe("parsePlaySuggestResponse", () => {
  it("returns Play's suggestions in order", () => {
    expect(parsePlaySuggestResponse(fixture("microl"), "microl")).toEqual([
      "microlife blood pressure app",
      "microlife connected health app",
      "microlearning",
      "microlab",
      "microlife connected health plus",
    ]);
  });

  it("returns [] when Play suggests nothing (the spike crashed here)", () => {
    expect(parsePlaySuggestResponse(fixture("zzqxjvkw"), "zzqxjvkw")).toEqual([]);
  });

  it("is a contract failure for batchexecute's error envelope, not 'no suggestions'", () => {
    for (const body of [
      `)]}'\n\n[["wrb.fr","IJ4APc",null,null,null,[3],"generic"]]`,
      `)]}'\n\n[["wrb.fr","IJ4APc",null,null,null,null,"generic"]]`,
    ]) {
      try {
        parsePlaySuggestResponse(body, "x");
        throw new Error("expected a PlayContractError");
      } catch (error) {
        expect(error).toBeInstanceOf(PlayContractError);
        expect((error as PlayContractError).signal).toBe("suggest_rpc_error");
      }
    }
  });

  it("is a contract failure when the RPC envelope is missing", () => {
    expect(() => parsePlaySuggestResponse(")]}'\n\n[[\"er\",null]]", "ab")).toThrow(PlayContractError);
    expect(() => parsePlaySuggestResponse("<html>error</html>", "ab")).toThrow(PlayContractError);
  });
});

describe("buildPlaySuggestBody", () => {
  it("encodes the IJ4APc request for a prefix", () => {
    const body = buildPlaySuggestBody('mi "x"');
    expect(body.startsWith("f.req=")).toBe(true);
    const request = JSON.parse(decodeURIComponent(body.slice("f.req=".length)));
    expect(request[0][0][0]).toBe("IJ4APc");
    expect(JSON.parse(request[0][0][1])).toEqual([[null, ['mi "x"'], [10], [2], 4]]);
  });
});
