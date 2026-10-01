/**
 * The untrusted-input boundary: {@link parseUserInput} turns what a browser
 * submitted into one user message.
 *
 * History (assistant turns, tool calls, tool results, approvals) is
 * server-held and trusted; a browser contributes only new user content. This
 * parser therefore accepts nothing but text, image, and file parts, drops
 * prompt-cache flags (breakpoints are capped per request, so a client could
 * otherwise make every request fail), enforces part, text, and byte limits,
 * checks every base64 payload against its declared media type by magic bytes,
 * and refuses URL sources unless the app passes an `allowUrl` predicate. A
 * failure is `AiError('invalid_input')` with a static `reason`.
 */

import { AiError } from '../errors/ai-error.js';
import { isPlainObject } from './json-value.js';
import { base64DecodedLength, isBase64, parseMediaUrl, sniffMatches } from './media.js';
import {
  AI_FILE_MEDIA_TYPES,
  AI_IMAGE_MEDIA_TYPES,
  type AiFileMediaType,
  type AiImageMediaType,
  type AiMediaSource,
  type AiMessage,
  type AiUserPart,
} from './types.js';

/** Limits {@link parseUserInput} enforces. */
export interface AiUserInputLimits {
  /** Most parts in one input (default 16). */
  readonly maxParts?: number;
  /** Most characters across all text parts (default 100 000). */
  readonly maxTextChars?: number;
  /** Most decoded bytes across all base64 media (default 20 MiB; Claude caps a request at 32 MB). */
  readonly maxMediaBytes?: number;
  /** Media types accepted (default: the four image types, PDF, and plain text). */
  readonly mediaTypes?: readonly (AiImageMediaType | AiFileMediaType)[];
  /** Admits an `https:` URL source; without it every URL source is refused. */
  readonly allowUrl?: (url: URL) => boolean;
}

/** Why {@link parseUserInput} refused an input. */
export type AiUserInputRejection =
  | 'shape'
  | 'empty'
  | 'too_many_parts'
  | 'part_type'
  | 'text_too_long'
  | 'media_type'
  | 'media_source'
  | 'media_too_large'
  | 'media_mismatch'
  | 'url_not_allowed';

declare const USER_INPUT: unique symbol;

/** A user message made by {@link parseUserInput}: the only message `run` accepts as `input`. */
export type AiUserInput = AiMessage & { readonly [USER_INPUT]: true };

/** Every message {@link parseUserInput} made; a frozen message can never change after. */
const parsedInputs = new WeakSet<object>();

/** Whether `value` is a message {@link parseUserInput} made. */
export function isParsedUserInput(value: unknown): value is AiUserInput {
  return typeof value === 'object' && value !== null && parsedInputs.has(value);
}

const DEFAULT_MAX_PARTS = 16;
const DEFAULT_MAX_TEXT_CHARS = 100_000;
const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function reject(reason: AiUserInputRejection): AiError {
  return new AiError('invalid_input', 'the input is invalid', { context: { reason } });
}

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AiError('invalid_options', 'an input limit must be a non-negative safe integer');
  }
  return value;
}

interface Budget {
  textChars: number;
  mediaBytes: number;
}

interface ResolvedLimits {
  readonly maxParts: number;
  readonly maxTextChars: number;
  readonly maxMediaBytes: number;
  readonly mediaTypes: readonly string[];
  readonly allowUrl: ((url: URL) => boolean) | undefined;
}

function readSource(
  value: unknown,
  mediaType: AiImageMediaType | AiFileMediaType | undefined,
  limits: ResolvedLimits,
  budget: Budget,
): AiMediaSource {
  if (!isPlainObject(value)) throw reject('media_source');
  if (value.kind === 'base64') {
    const declared = value.mediaType;
    if (typeof declared !== 'string' || !limits.mediaTypes.includes(declared)) {
      throw reject('media_type');
    }
    if (mediaType !== undefined && declared !== mediaType) throw reject('media_type');
    if (typeof value.data !== 'string' || !isBase64(value.data)) throw reject('media_source');
    budget.mediaBytes += base64DecodedLength(value.data);
    if (budget.mediaBytes > limits.maxMediaBytes) throw reject('media_too_large');
    if (!sniffMatches(value.data, declared as AiImageMediaType | AiFileMediaType)) {
      throw reject('media_mismatch');
    }
    return Object.freeze({ kind: 'base64', mediaType: declared, data: value.data });
  }
  if (value.kind === 'url') {
    if (typeof value.url !== 'string') throw reject('media_source');
    const url = parseMediaUrl(value.url, ['https:']);
    if (url === undefined) throw reject('media_source');
    if (limits.allowUrl === undefined || limits.allowUrl(url) !== true) {
      throw reject('url_not_allowed');
    }
    return Object.freeze({ kind: 'url', url: url.href });
  }
  throw reject('media_source');
}

function readText(text: unknown, limits: ResolvedLimits, budget: Budget): AiUserPart {
  if (typeof text !== 'string' || text.trim().length === 0) throw reject('empty');
  budget.textChars += text.length;
  if (budget.textChars > limits.maxTextChars) throw reject('text_too_long');
  return Object.freeze({ type: 'text', text });
}

function readPart(value: unknown, limits: ResolvedLimits, budget: Budget): AiUserPart {
  if (!isPlainObject(value)) throw reject('shape');
  switch (value.type) {
    case 'text':
      return readText(value.text, limits, budget);
    case 'image': {
      const source = readSource(value.source, undefined, limits, budget);
      if (
        source.kind === 'base64' &&
        !AI_IMAGE_MEDIA_TYPES.includes(source.mediaType as AiImageMediaType)
      ) {
        throw reject('media_type');
      }
      return Object.freeze({ type: 'image', source });
    }
    case 'file': {
      const mediaType = value.mediaType;
      if (
        typeof mediaType !== 'string' ||
        !AI_FILE_MEDIA_TYPES.includes(mediaType as AiFileMediaType) ||
        !limits.mediaTypes.includes(mediaType)
      ) {
        throw reject('media_type');
      }
      const source = readSource(value.source, mediaType as AiFileMediaType, limits, budget);
      const title = value.title;
      if (title !== undefined && (typeof title !== 'string' || title.length > 512)) {
        throw reject('shape');
      }
      return Object.freeze({
        type: 'file',
        mediaType: mediaType as AiFileMediaType,
        source,
        ...(title === undefined ? {} : { title }),
      });
    }
    default:
      throw reject('part_type');
  }
}

/**
 * Parse untrusted input (a string, or an array of text, image, and file
 * parts) into one frozen user message. Tool results, reasoning, tool calls,
 * system text, and cache flags can never enter through this boundary.
 */
export function parseUserInput(value: unknown, limits: AiUserInputLimits = {}): AiUserInput {
  const resolved: ResolvedLimits = {
    maxParts: limit(limits.maxParts, DEFAULT_MAX_PARTS),
    maxTextChars: limit(limits.maxTextChars, DEFAULT_MAX_TEXT_CHARS),
    maxMediaBytes: limit(limits.maxMediaBytes, DEFAULT_MAX_MEDIA_BYTES),
    mediaTypes: limits.mediaTypes ?? [...AI_IMAGE_MEDIA_TYPES, ...AI_FILE_MEDIA_TYPES],
    allowUrl: limits.allowUrl,
  };
  const budget: Budget = { textChars: 0, mediaBytes: 0 };
  let parts: AiUserPart[];
  if (typeof value === 'string') {
    parts = [readText(value, resolved, budget)];
  } else if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    if (items.length === 0) throw reject('empty');
    if (items.length > resolved.maxParts) throw reject('too_many_parts');
    parts = items.map((item) => readPart(item, resolved, budget));
  } else {
    throw reject('shape');
  }
  const message: AiMessage = Object.freeze({ role: 'user', parts: Object.freeze(parts) });
  parsedInputs.add(message);
  return message as AiUserInput;
}
