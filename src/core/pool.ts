/**
 * `runPool(items, limit, worker, signal)`: runs `worker` over `items` with at most `limit` calls in flight,
 * starting them in item order (OCR pages, extraction batches, …).
 *
 * - Once `signal` aborts, no further item starts; calls already running are left to observe the signal themselves.
 * - A worker that throws stops new items from starting; the pool waits for the running ones to settle, then
 *   rejects with the first error. Workers that want "keep going after a failure" catch their own errors.
 *
 * ```ts
 * await runPool(pages, 3, async (page) => { results.set(page.key, await read(page)); }, run.signal);
 * ```
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const lane = async (): Promise<void> => {
    while (next < items.length && failure === null && !signal?.aborted) {
      const index = next++;
      try {
        await worker(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  if (failure !== null) throw (failure as { error: unknown }).error;
}
