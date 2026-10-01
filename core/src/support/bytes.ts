/**
 * Byte helpers behind the support namespaces: concatenation, size formatting,
 * and bounded reads of web streams.
 *
 * Browser-safe — no Node builtins, no DOM globals.
 * Nothing here is re-exported from the package entry (`src/index.ts`).
 */

/** Concatenate a list of byte chunks into a single Uint8Array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Read a byte stream to completion, calling `onOverflow` (which must throw)
 * as soon as more than `maxBytes` have arrived so a hostile body is never
 * buffered past the cap. A `null` stream (a request without a body) reads as
 * empty. The reader lock is released on every exit.
 */
export async function readStreamBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onOverflow: () => never,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        onOverflow();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks);
}

/**
 * Wrap a byte stream so it fails with `makeOverflowError()` and cancels the
 * source as soon as more than `maxBytes` have passed through, letting a
 * streaming consumer (a multipart parser, a file store) enforce a cap without
 * buffering the body first.
 */
export function boundStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  makeOverflowError: () => Error,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        controller.error(makeOverflowError());
        await reader.cancel().catch(() => undefined);
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason);
    },
  });
}

const DECIMAL_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] as const;
const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'] as const;

interface FormatBytesOptions {
  readonly binary?: boolean;
}

/** Format a byte count with decimal or binary units. */
export function formatBytes(value: number, options?: FormatBytesOptions): string {
  const base = options?.binary === true ? 1024 : 1000;
  const units = options?.binary === true ? BINARY_UNITS : DECIMAL_UNITS;
  const sign = value < 0 ? '-' : '';
  let amount = Math.abs(value);
  let unitIndex = 0;

  while (amount >= base && unitIndex < units.length - 1) {
    amount /= base;
    unitIndex += 1;
  }

  const formatted = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(amount);
  return `${sign}${formatted} ${units[unitIndex] ?? units[0]}`;
}
