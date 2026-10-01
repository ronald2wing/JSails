/**
 * Tool result serialization and truncation.
 *
 * A string result is sent verbatim. Any other value is sent as JSON: bigints
 * become decimal strings and `Date`s use their ISO form, while values JSON
 * would silently mangle (a cycle, a `Map` or `Set`, a function, a symbol, a
 * non-finite number, a regular expression, an error, a promise) make the
 * whole result invalid instead of reaching the model as `{}` or
 * `[object Object]`. Text is cut on a code-point boundary, never inside a
 * surrogate pair, and the cut is marked.
 *
 * Images count too: a result is bounded by decoded media bytes and by image
 * count as well as by text characters, so a tool (or an MCP server) cannot
 * push unbounded media into memory, the next request, and the transcript.
 */

import { base64DecodedLength } from '../content/media.js';
import type { AiToolOutput, AiToolOutputItem } from '../content/types.js';

/** Appended to text that was cut. */
export const TRUNCATION_MARKER = '\n[output truncated]';

/** The default cap on the decoded bytes of all images in one tool result (20 MiB). */
export const DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES: number = 20 * 1024 * 1024;

/** The default cap on the number of images in one tool result. */
export const DEFAULT_MAX_TOOL_RESULT_IMAGES = 16;

/** The bounds {@link limitToolOutput} applies to one result. */
export interface AiToolOutputLimits {
  /** Most text characters across the result. */
  readonly maxChars: number;
  /** Most decoded bytes across its base64 images (default 20 MiB). */
  readonly maxMediaBytes?: number;
  /** Most images, base64 or URL (default 16). */
  readonly maxImages?: number;
}

/** The outcome of {@link serializeToolValue}. */
export type ToolValueText = { readonly ok: true; readonly text: string } | { readonly ok: false };

const LOSSY_TYPES: readonly (abstract new (...args: never[]) => unknown)[] = [
  Map,
  Set,
  WeakMap,
  WeakSet,
  RegExp,
  Error,
  Promise,
];

class UnserializableValue extends Error {}

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') throw new UnserializableValue();
  if (typeof value === 'number' && !Number.isFinite(value)) throw new UnserializableValue();
  if (typeof value === 'object' && value !== null) {
    for (const type of LOSSY_TYPES) if (value instanceof type) throw new UnserializableValue();
  }
  return value;
}

/** Serialize a tool's return value to the text the model receives. */
export function serializeToolValue(value: unknown): ToolValueText {
  if (typeof value === 'string') return { ok: true, text: value };
  if (value === undefined) return { ok: true, text: '' };
  try {
    const text = JSON.stringify(value, replacer);
    return typeof text === 'string' ? { ok: true, text } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The largest index ≤ `end` that does not split a surrogate pair in `text`. */
function codePointBoundary(text: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= text.length) return text.length;
  const before = text.charCodeAt(end - 1);
  return before >= 0xd800 && before <= 0xdbff ? end - 1 : end;
}

/**
 * Cut `text` to at most `maxChars` UTF-16 units, marker included, on a
 * code-point boundary. Text that fits is returned as it is.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(0, codePointBoundary(text, maxChars));
  return (
    text.slice(0, codePointBoundary(text, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
  );
}

/**
 * Limit a tool output. A string is cut to `maxChars`. For an item list, the
 * text budget spans all text items and the media budgets span all images; the
 * text item that crosses its budget is cut, an image that crosses either
 * media budget is dropped and replaced by the truncation marker, and every
 * later item is dropped.
 */
export function limitToolOutput(output: AiToolOutput, limits: AiToolOutputLimits): AiToolOutput {
  const maxChars = limits.maxChars;
  if (typeof output === 'string') return truncateText(output, maxChars);
  const maxMediaBytes = limits.maxMediaBytes ?? DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES;
  const maxImages = limits.maxImages ?? DEFAULT_MAX_TOOL_RESULT_IMAGES;
  const items: AiToolOutputItem[] = [];
  let remaining = maxChars;
  let mediaBytes = 0;
  let images = 0;
  for (const item of output) {
    if (item.type === 'image') {
      images += 1;
      if (item.source.kind === 'base64') mediaBytes += base64DecodedLength(item.source.data);
      if (images > maxImages || mediaBytes > maxMediaBytes) {
        items.push(Object.freeze({ type: 'text', text: TRUNCATION_MARKER.trimStart() }));
        break;
      }
      items.push(item);
      continue;
    }
    if (item.text.length <= remaining) {
      items.push(item);
      remaining -= item.text.length;
      continue;
    }
    const text = truncateText(item.text, remaining);
    if (text.length > 0) items.push(Object.freeze({ type: 'text', text }));
    break;
  }
  return Object.freeze(items);
}
