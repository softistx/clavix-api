/** Rows read per round trip when an export walks a log: memory stays flat whatever the log's size. */
export const EXPORT_BATCH = 500;

/**
 * Walks a cursor-paged read to its end (or `limit` rows), one batch at a time,
 * so a caller holds one batch whatever the log's size.
 */
export async function* drain<T>(
  read: (
    after: string | null,
    size: number,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
  limit: number,
): AsyncGenerator<T> {
  let after: string | null = null;
  let left = limit;
  while (left > 0) {
    const page = await read(after, Math.min(EXPORT_BATCH, left));
    for (const item of page.items) yield item;
    left -= page.items.length;
    if (page.nextCursor === null || page.items.length === 0) return;
    after = page.nextCursor;
  }
}
