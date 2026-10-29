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
 * (country, appId). Only the few most recently used storefronts are held
 * (a run walks storefronts in order, a few at a time with
 * ASO_STOREFRONT_CONCURRENCY), so memory stays bounded. Rating counts do not
 * move meaningfully within a run.
 */
class RunLookupCache {
  private readonly byCountry = new Map<string, Map<string, unknown>>();
  static readonly MAX_COUNTRIES = 4;
  static readonly MAX_ENTRIES_PER_COUNTRY = 5000;

  forCountry<T>(country: string): Map<string, T> {
    const normalized = country.toUpperCase();
    let docs = this.byCountry.get(normalized);
    if (docs) {
      // Mark as most recently used.
      this.byCountry.delete(normalized);
    } else {
      docs = new Map<string, unknown>();
    }
    this.byCountry.set(normalized, docs);
    while (this.byCountry.size > RunLookupCache.MAX_COUNTRIES) {
      const oldest = this.byCountry.keys().next().value as string;
      this.byCountry.delete(oldest);
    }
    if (docs.size > RunLookupCache.MAX_ENTRIES_PER_COUNTRY) docs.clear();
    return docs as Map<string, T>;
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

let lookupCacheHitTotal = 0;

/** Counts app ids served from the run's lookup cache instead of Apple. */
export function recordLookupCacheHits(count: number): void {
  if (count > 0) lookupCacheHitTotal += count;
}

/**
 * Lookup cache hits since the process started; a run diffs it like the
 * per-host request counters.
 */
export function lookupCacheHitCount(): number {
  return lookupCacheHitTotal;
}

export function __resetRunLookupCacheForTests(): void {
  runCache = null;
  lookupCacheHitTotal = 0;
}
