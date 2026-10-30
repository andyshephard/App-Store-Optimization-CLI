import { PlayContractError } from "./play-search-parser";

/**
 * Google Play search suggestions (the store's autocomplete), from the
 * `IJ4APc` batchexecute RPC. The response is `)]}'` followed by lines of
 * JSON; the `[["wrb.fr","IJ4APc","<json string>",...]]` line carries the
 * payload as a JSON string whose `[0][0]` is the suggestion list (up to 5),
 * each `[term, ...]`. A prefix with no suggestions answers `[[null, ...]]`.
 */

export const PLAY_SUGGEST_RPC_ID = "IJ4APc";

/** The form body for one suggestion request. */
export function buildPlaySuggestBody(prefix: string): string {
  const inner = JSON.stringify([[null, [prefix], [10], [2], 4]]);
  const request = JSON.stringify([[[PLAY_SUGGEST_RPC_ID, inner]]]);
  return `f.req=${encodeURIComponent(request)}`;
}

/** Suggested terms in Play's order, lower-cased; [] when Play suggests nothing. */
export function parsePlaySuggestResponse(body: string, prefix: string): string[] {
  for (const line of body.split("\n")) {
    if (!line.startsWith('[["wrb.fr"')) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      break;
    }
    const entry = Array.isArray(envelope) ? envelope[0] : undefined;
    if (!Array.isArray(entry) || entry[1] !== PLAY_SUGGEST_RPC_ID) break;
    const payload = entry[2];
    if (payload == null) return [];
    if (typeof payload !== "string") break;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      break;
    }
    const list = Array.isArray(data) && Array.isArray(data[0]) ? data[0][0] : undefined;
    if (list == null) return [];
    if (!Array.isArray(list)) break;
    return list
      .map((suggestion) => (Array.isArray(suggestion) ? suggestion[0] : undefined))
      .filter((term): term is string => typeof term === "string")
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
  }
  throw new PlayContractError(
    "suggest_envelope",
    `Play suggestions for "${prefix}": no ${PLAY_SUGGEST_RPC_ID} wrb.fr payload in the response`
  );
}
