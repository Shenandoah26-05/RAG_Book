/**
 * Runs `task` for every item with at most `limit` running at once, and gives the results in the
 * order of the items. When one task throws, no new task is started, the ones already running are
 * allowed to finish, and the first error is thrown.
 *
 * It is a small pool of workers that each take the next item until none is left: no queue library,
 * and the limit is exact because a worker only takes an item when it has finished its last one.
 */
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // one object, because the workers change it while the loops below read it
  const state: { next: number; failed: boolean; error?: unknown } = { next: 0, failed: false };

  // only the first error is kept: the others usually come from the same cause
  const fail = (error: unknown): void => {
    if (state.failed) return;
    state.failed = true;
    state.error = error;
  };

  const worker = async (): Promise<void> => {
    while (!state.failed && state.next < items.length) {
      const index = state.next;
      state.next += 1;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (error) {
        fail(error);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (state.failed) throw state.error;
  return results;
}
