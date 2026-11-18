import type { Row } from "./columns";
import { csvLine } from "./format";
import type { Format } from "./params";

/**
 * The response body: a CSV header then one line per row, or one JSON object
 * per line. One row per pull, so the stream's backpressure keeps memory flat;
 * a client that goes away stops the reads.
 */
export function exportBody(
  source: AsyncIterable<Row>,
  columns: readonly string[],
  format: Format,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  let header = format === "csv";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (header) {
        header = false;
        controller.enqueue(encoder.encode(csvLine(columns)));
        return;
      }
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(
        encoder.encode(
          format === "csv"
            ? csvLine(columns.map((column) => next.value[column] ?? null))
            : `${JSON.stringify(next.value)}\n`,
        ),
      );
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
