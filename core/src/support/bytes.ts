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
 * empty.
 *
 * Any exit before the end of the stream cancels it: releasing the lock alone
 * would leave a network body's socket open, and its sender still writing,
 * until the connection times out.
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
  let finished = false;
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
    finished = true;
  } finally {
    if (!finished) {
      // A cancel failure must not replace the error that ended the read.
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return concatBytes(chunks);
}

/** Options for {@link boundStream}. */
export interface BoundStreamOptions {
  /**
   * The bound, read each time a chunk is counted, so the cap can change while
   * the stream is open (a request body's limit is set by the route it reaches).
   */
  readonly maxBytes: number | (() => number);
  /** The error the stream fails with once the bound is exceeded. */
  readonly overflow: () => Error;
  /** Called once, when the consumer first asks for a chunk. */
  readonly onFirstPull?: () => void;
  /** Called for every chunk read from the source with the running total. */
  readonly onChunk?: (total: number) => void;
  /** Called once when the source ends: `true` when it was read to its end. */
  readonly onSettle?: (complete: boolean) => void;
}

/**
 * Wrap a byte stream so it fails with `overflow()` and cancels the source as
 * soon as more than `maxBytes` have passed through, letting a streaming
 * consumer (a multipart parser, a file store, a request body) enforce a cap
 * without buffering the body first.
 *
 * Lazy: nothing is read from the source until the consumer asks for a chunk
 * (`highWaterMark: 0`), so wrapping a request body reads none of it.
 */
export function boundStream(
  stream: ReadableStream<Uint8Array>,
  options: BoundStreamOptions,
): ReadableStream<Uint8Array> {
  const { overflow, onFirstPull, onChunk, onSettle } = options;
  const limit =
    typeof options.maxBytes === 'function' ? options.maxBytes : constant(options.maxBytes);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let total = 0;
  let settled = false;
  const settle = (complete: boolean): void => {
    if (settled) return;
    settled = true;
    onSettle?.(complete);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        if (reader === undefined) {
          onFirstPull?.();
          reader = stream.getReader();
        }
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (error) {
          settle(false);
          controller.error(error);
          return;
        }
        if (step.done) {
          settle(true);
          controller.close();
          return;
        }
        total += step.value.byteLength;
        onChunk?.(total);
        if (total > limit()) {
          settle(false);
          controller.error(overflow());
          // The overflow error above is what the consumer sees; a failing cancel
          // adds nothing.
          await reader.cancel().catch(() => undefined);
          return;
        }
        controller.enqueue(step.value);
      },
      async cancel(reason): Promise<void> {
        settle(false);
        await (reader ?? stream).cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** A getter for a fixed value. */
function constant(value: number): () => number {
  return () => value;
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
