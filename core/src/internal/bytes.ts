/**
 * Internal byte helpers: concatenation and size formatting.
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
