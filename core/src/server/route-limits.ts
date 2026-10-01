/**
 * Route limits: what a route declares about its request body and its
 * deadlines, and the bounds every declaration is checked against.
 *
 * Bodies: the caps, and the {@link BodySpec} a route states its body with.
 * Every request body is read through the request's body budget
 * (`body-budget.ts`), whose limit is the cap of the route the request
 * reaches: its declared `body.maxBytes`, `0` for `{ kind: 'none' }`, or the
 * app-wide `maxBodyBytes` (1 MiB by default) when the route declares
 * nothing. A declaration is a positive integer no larger than
 * {@link MAX_ROUTE_BODY_BYTES}, validated when it is declared, so a typo
 * cannot lift the cap without limit. A multipart body also declares its
 * parts ({@link MultipartSpec}: part count, field and file caps, the file
 * fields and their media types, the idle bound), each limit checked against
 * the body's cap. The checked copy states every limit the reader
 * (`multipart.ts`) enforces, defaults included, in one canonical form (file
 * fields by name, media types sorted and distinct), so the route table and
 * its snapshot show them all, and two declarations with the same effect read
 * the same.
 *
 * Deadlines: a route's `timeoutMs` (else `server.handlerTimeoutMs`,
 * {@link DEFAULT_HANDLER_TIMEOUT_MS}) and a streamed answer's
 * `stream.timeoutMs` (`deadline.ts` enforces both), each an integer up to the
 * largest delay a Node timer honours.
 *
 * Free of the HTTP pipeline on purpose: the app config loader resolves the
 * defaults, and the registrar and `defineApi` validate a declaration, without
 * loading the router. Browser-safe.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Default request-body cap when `maxBodyBytes` is omitted. */
export const DEFAULT_MAX_BODY_BYTES: number = 1024 * 1024; // 1 MiB

/**
 * The largest body cap a route may declare: 100 MiB. A declared length above
 * it is answered 413 before routing.
 *
 * @public
 */
export const MAX_ROUTE_BODY_BYTES: number = 100 * 1024 * 1024;

/** Stable code carried by a {@link BodyLimitError}. */
export type BodyLimitErrorCode = 'invalid_body_limit';

/** Raised for a malformed body-limit declaration. Value-free: never echoes the value. */
export class BodyLimitError extends JsailsError {
  readonly code: BodyLimitErrorCode = 'invalid_body_limit';
}

/**
 * Validate a body cap: a positive integer no larger than
 * {@link MAX_ROUTE_BODY_BYTES}. `label` names the declaration in the error.
 */
export function validateBodyLimit(value: unknown, label = 'maxBodyBytes'): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_ROUTE_BODY_BYTES
  ) {
    throw new BodyLimitError(
      `${label} must be a positive integer of at most ${MAX_ROUTE_BODY_BYTES} bytes`,
    );
  }
  return value;
}

/**
 * The kind of body a route reads: JSON (`ctx.body.json`), a small form
 * (`ctx.body.form`: urlencoded or multipart, held in memory), raw bytes
 * (`ctx.body.bytes`, `ctx.body.stream`), or a streamed multipart body
 * (`ctx.body.multipart`: its parts in wire order, each file a stream).
 *
 * @public
 */
export type BodyKind = 'json' | 'form' | 'raw' | 'multipart';

/**
 * One file field of a {@link MultipartSpec}: the most bytes one file in it
 * may have, how many files it may carry (default 1), and, when given, the
 * media types it accepts (`image/png`, or a whole type as `image/*`),
 * matched against the type the client claims for the part.
 *
 * @public
 */
export interface MultipartFileSpec {
  readonly maxBytes: number;
  readonly maxCount?: number;
  readonly contentTypes?: readonly string[];
}

/**
 * The parts a multipart body may carry: at most `maxParts` parts in all,
 * each text field at most `maxFieldBytes` bytes, each part's header block at
 * most `maxHeaderBytes` (default 8 KiB), files only in the fields `files`
 * names, and no more than `idleMs` (default 30 s) between two chunks of the
 * body while a reader waits for one.
 *
 * @public
 */
export interface MultipartSpec {
  readonly maxParts: number;
  readonly maxFieldBytes: number;
  readonly maxHeaderBytes?: number;
  readonly files: Readonly<Record<string, MultipartFileSpec>>;
  readonly idleMs?: number;
}

/**
 * What a route states about its request body: none at all (any byte is
 * refused with 413), or the kind it reads and the most bytes it accepts (at
 * most {@link MAX_ROUTE_BODY_BYTES}), and for a multipart body the parts it
 * accepts. A route without one accepts up to the app-wide `maxBodyBytes`
 * and declares no kind.
 *
 * @public
 */
export type BodySpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'json' | 'form' | 'raw'; readonly maxBytes: number }
  | { readonly kind: 'multipart'; readonly maxBytes: number; readonly parts: MultipartSpec };

/** The most parts a multipart declaration may allow. */
export const MAX_MULTIPART_PARTS = 1000;

/** A part's header block when `maxHeaderBytes` is omitted: 8 KiB. */
export const DEFAULT_MULTIPART_HEADER_BYTES: number = 8 * 1024;

/** The bounds of a declared `maxHeaderBytes`. */
const MIN_MULTIPART_HEADER_BYTES = 256;
const MAX_MULTIPART_HEADER_BYTES = 64 * 1024;

/** The idle bound of a multipart body when `idleMs` is omitted: 30 seconds. */
export const DEFAULT_MULTIPART_IDLE_MS = 30_000;

/** How many files a file field may carry when `maxCount` is omitted. */
export const DEFAULT_MULTIPART_FILE_COUNT = 1;

const BODY_KINDS: ReadonlySet<string> = new Set<string>(['json', 'form', 'raw']);

/** An RFC 9110 token, lowercased: the characters of a media type's type and subtype. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/**
 * `value` as a frozen {@link BodySpec}, or `undefined` when it is not one:
 * an object with a known `kind` and, unless `none`, a `maxBytes` that
 * {@link validateBodyLimit} accepts, for a multipart body `parts` a valid
 * {@link MultipartSpec} within that cap, and no other member. A multipart
 * spec comes back canonical: every default stated, file fields in name
 * order, each field's media types lowercased, sorted and distinct.
 */
export function checkBodySpec(value: unknown): BodySpec | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { kind, maxBytes } = value as { kind?: unknown; maxBytes?: unknown };
  const keys = Object.keys(value);
  if (kind === 'none') {
    return keys.length === 1 ? Object.freeze({ kind: 'none' }) : undefined;
  }
  if (!isIntegerIn(maxBytes, 1, MAX_ROUTE_BODY_BYTES)) return undefined;
  if (kind === 'multipart') {
    if (keys.length !== 3) return undefined;
    const parts = checkMultipartSpec((value as { parts?: unknown }).parts, maxBytes);
    return parts === undefined ? undefined : Object.freeze({ kind, maxBytes, parts });
  }
  if (typeof kind !== 'string' || !BODY_KINDS.has(kind) || keys.length !== 2) return undefined;
  return Object.freeze({ kind: kind as 'json' | 'form' | 'raw', maxBytes });
}

/** Whether `value` is an integer from `min` to `max`. */
function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether `value` is a plain object: an object literal, or one without a prototype. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether `object` has no member outside `allowed`. */
function hasOnly(object: object, allowed: readonly string[]): boolean {
  return Object.keys(object).every((key) => allowed.includes(key));
}

/**
 * `value` as a deep-frozen, canonical {@link MultipartSpec} for a body of at
 * most `maxBytes`, or `undefined`: no limit exceeds the body's cap, every
 * count is a positive integer, and `files` is a plain object of file fields.
 * The copy states `maxHeaderBytes` and `idleMs` (their defaults when
 * omitted) and lists its file fields in name order. Its `files` has no
 * prototype, so a part named `__proto__` or `toString` is never mistaken for
 * a declared field.
 */
function checkMultipartSpec(value: unknown, maxBytes: number): MultipartSpec | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!hasOnly(value, ['maxParts', 'maxFieldBytes', 'maxHeaderBytes', 'files', 'idleMs'])) {
    return undefined;
  }
  const { maxParts, maxFieldBytes, maxHeaderBytes, files, idleMs } = value;
  if (!isIntegerIn(maxParts, 1, MAX_MULTIPART_PARTS)) return undefined;
  if (!isIntegerIn(maxFieldBytes, 1, maxBytes)) return undefined;
  if (
    maxHeaderBytes !== undefined &&
    !isIntegerIn(maxHeaderBytes, MIN_MULTIPART_HEADER_BYTES, MAX_MULTIPART_HEADER_BYTES)
  ) {
    return undefined;
  }
  if (idleMs !== undefined && !isIntegerIn(idleMs, 1, MAX_TIMEOUT_MS)) return undefined;
  if (!isPlainObject(files)) return undefined;
  const fields = Object.create(null) as Record<string, MultipartFileSpec>;
  for (const name of Object.keys(files).sort(byCodeUnits)) {
    const checked = name === '' ? undefined : checkFileSpec(files[name], maxBytes, maxParts);
    if (checked === undefined) return undefined;
    fields[name] = checked;
  }
  return Object.freeze({
    maxParts,
    maxFieldBytes,
    maxHeaderBytes: maxHeaderBytes ?? DEFAULT_MULTIPART_HEADER_BYTES,
    files: Object.freeze(fields),
    idleMs: idleMs ?? DEFAULT_MULTIPART_IDLE_MS,
  });
}

/** Order two strings by UTF-16 code unit, the same in every locale. */
function byCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * `value` as a frozen {@link MultipartFileSpec} that states `maxCount` (its
 * default when omitted) and, when given, its media types lowercased, sorted
 * and distinct; or `undefined`.
 */
function checkFileSpec(
  value: unknown,
  maxBytes: number,
  maxParts: number,
): MultipartFileSpec | undefined {
  if (!isPlainObject(value) || !hasOnly(value, ['maxBytes', 'maxCount', 'contentTypes'])) {
    return undefined;
  }
  const { maxBytes: fileBytes, maxCount, contentTypes } = value;
  if (!isIntegerIn(fileBytes, 1, maxBytes)) return undefined;
  if (maxCount !== undefined && !isIntegerIn(maxCount, 1, maxParts)) return undefined;
  const count = maxCount ?? DEFAULT_MULTIPART_FILE_COUNT;
  if (contentTypes === undefined) return Object.freeze({ maxBytes: fileBytes, maxCount: count });
  if (!Array.isArray(contentTypes) || contentTypes.length === 0) return undefined;
  const types = new Set<string>();
  for (const entry of contentTypes as readonly unknown[]) {
    const type = typeof entry === 'string' ? entry.toLowerCase() : undefined;
    if (type === undefined || !isMediaRange(type)) return undefined;
    types.add(type);
  }
  return Object.freeze({
    maxBytes: fileBytes,
    maxCount: count,
    contentTypes: Object.freeze([...types].sort(byCodeUnits)),
  });
}

/** Whether lowercased `value` is `type/subtype` or `type/*`. */
function isMediaRange(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const type = value.slice(0, slash);
  const subtype = value.slice(slash + 1);
  return type !== '*' && TOKEN.test(type) && (subtype === '*' || TOKEN.test(subtype));
}

/**
 * Whether the media type `type` (lowercased, without parameters) is one
 * `ranges` (a checked {@link MultipartFileSpec}'s `contentTypes`) accepts.
 */
export function acceptsMediaType(ranges: readonly string[], type: string): boolean {
  const slash = type.indexOf('/');
  const whole = slash === -1 ? undefined : `${type.slice(0, slash)}/*`;
  return ranges.some((range) => range === type || range === whole);
}

/** The limit a route's `body` sets: its `maxBytes`, `0` for `none`, else `fallback`. */
export function bodyLimitOf(spec: BodySpec | undefined, fallback: number): number {
  if (spec === undefined) return fallback;
  return spec.kind === 'none' ? 0 : spec.maxBytes;
}

/** The default handler deadline, `server.handlerTimeoutMs`: 30 seconds. */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/** The largest timer delay Node honours; a larger one fires after 1 ms. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Whether `value` is a deadline in milliseconds: an integer from 0 (no
 * deadline) up to {@link MAX_TIMEOUT_MS}.
 */
export function isTimeoutMs(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS
  );
}

/**
 * `value` as a stream declaration (`{ timeoutMs }`, a positive idle bound),
 * or `undefined` when it is not one.
 */
export function checkStreamSpec(value: unknown): { readonly timeoutMs: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { timeoutMs } = value as { timeoutMs?: unknown };
  if (Object.keys(value).length !== 1 || !isTimeoutMs(timeoutMs) || timeoutMs === 0) {
    return undefined;
  }
  return Object.freeze({ timeoutMs });
}
