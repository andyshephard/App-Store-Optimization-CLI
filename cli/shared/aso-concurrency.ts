/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * Every fan-out to Apple should go through this rather than a bare
 * `Promise.all`: Apple throttles per storefront per client, so the size of a
 * burst matters more than the total number of requests.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const bounded = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(bounded, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}
