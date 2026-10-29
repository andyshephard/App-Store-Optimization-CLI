import { AsyncLocalStorage } from "async_hooks";

/**
 * Carries the background refresh run id down to the observation writer
 * without threading it through every pipeline signature. A foreground
 * dashboard action running at the same time has no store, so its
 * observations get run_id null rather than the crawl's id.
 */
const storage = new AsyncLocalStorage<{ runId: number | null }>();

export function withObservationRun<T>(
  runId: number | null,
  operation: () => Promise<T>
): Promise<T> {
  return storage.run({ runId }, operation);
}

export function currentObservationRunId(): number | null {
  return storage.getStore()?.runId ?? null;
}
