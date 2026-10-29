import { AsyncLocalStorage } from "async_hooks";

/**
 * Carries the background refresh run id down to the observation writer
 * without threading it through every pipeline signature. A foreground
 * dashboard action running at the same time has no store, so its
 * observations get run_id null rather than the crawl's id.
 */
type RunContext = {
  runId: number | null;
  lookupCache: RunLookupCache | null;
};

const storage = new AsyncLocalStorage<RunContext>();

/**
 * iTunes lookup docs already fetched in this background run, keyed by
 * (country, appId). Only one storefront is held at a time - a run walks
 * storefronts in order - so memory stays bounded to one storefront's top
 * apps. Rating counts do not move meaningfully within a run.
 */
class RunLookupCache {
  private country: string | null = null;
  private readonly docs = new Map<string, unknown>();
  static readonly MAX_ENTRIES = 5000;

  forCountry<T>(country: string): Map<string, T> {
    const normalized = country.toUpperCase();
    if (this.country !== normalized) {
      this.docs.clear();
      this.country = normalized;
    }
    if (this.docs.size > RunLookupCache.MAX_ENTRIES) this.docs.clear();
    return this.docs as Map<string, T>;
  }
}

let runCache: { runId: number | null; cache: RunLookupCache } | null = null;

function lookupCacheForRun(runId: number | null): RunLookupCache | null {
  if (runId == null) return null;
  if (runCache?.runId !== runId) {
    runCache = { runId, cache: new RunLookupCache() };
  }
  return runCache.cache;
}

export function withObservationRun<T>(
  runId: number | null,
  operation: () => Promise<T>
): Promise<T> {
  return storage.run({ runId, lookupCache: lookupCacheForRun(runId) }, operation);
}

export function currentObservationRunId(): number | null {
  return storage.getStore()?.runId ?? null;
}

/** The run's lookup cache for this storefront, or null outside a background run. */
export function currentRunLookupCache<T>(country: string): Map<string, T> | null {
  return storage.getStore()?.lookupCache?.forCountry<T>(country) ?? null;
}

export function __resetRunLookupCacheForTests(): void {
  runCache = null;
}
