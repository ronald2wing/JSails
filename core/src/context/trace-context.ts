/**
 * W3C Trace Context (`traceparent` and `tracestate`): parsing, formatting, and
 * the span identities a unit of work carries.
 *
 * A {@link TraceContext} names one span: the trace it belongs to, its own span
 * id, the span it continues (local or remote), the trace flags, and the vendor
 * `tracestate` members it passes on. A request either continues an inbound
 * `traceparent` (only when the caller is trusted to state one; the request
 * stage decides) or starts a fresh trace; a job restored from a carrier
 * continues its dispatcher's span as a child.
 *
 * Parsing follows the Trace Context recommendation and its conformance suite
 * (`w3c/trace-context`, `test/test.py`): optional whitespace around a header is
 * ignored; a `traceparent` with version `ff`, upper-case or non-hex digits, an
 * all-zero trace or parent id, or the wrong length is rejected whole; a future
 * version is read for its first four fields when what follows them starts with
 * `-`; a `tracestate` that is malformed anywhere, or names more than 32
 * members, is discarded whole, while empty members are skipped and a repeated
 * key keeps its first value. A `tracestate` is only ever read beside a valid
 * `traceparent`.
 *
 * Ids come from Web Crypto (`globalThis.crypto`), which Node and browsers
 * both provide, so this module imports no builtin.
 */

/**
 * The `sampled` trace flag: the caller may have recorded this trace.
 *
 * @public
 */
export const TRACE_FLAG_SAMPLED = 0x01;

/**
 * The `random` trace flag (Trace Context Level 2): the trace id's right-most
 * seven bytes are random. Propagated as received.
 *
 * @public
 */
export const TRACE_FLAG_RANDOM = 0x02;

/** The flags this implementation understands; every other bit is sent as zero. */
const KNOWN_FLAGS = TRACE_FLAG_SAMPLED | TRACE_FLAG_RANDOM;

/**
 * One `tracestate` list member: a vendor key and its opaque value.
 *
 * @public
 */
export interface TraceStateMember {
  readonly key: string;
  readonly value: string;
}

/**
 * A parsed `traceparent` header.
 *
 * @public
 */
export interface TraceParent {
  /** The header version, 0 for `00`; a future version was read for its known fields only. */
  readonly version: number;
  /** 32 lower-case hex digits, not all zero. */
  readonly traceId: string;
  /** The caller's span id: 16 lower-case hex digits, not all zero. */
  readonly parentId: string;
  /** The trace flags byte as received. */
  readonly flags: number;
}

/**
 * The span a unit of work runs as.
 *
 * @public
 */
export interface TraceContext {
  /** 32 lower-case hex digits, not all zero. */
  readonly traceId: string;
  /** This unit's own span id: 16 lower-case hex digits, not all zero. */
  readonly spanId: string;
  /** The span this one continues, or `undefined` for the root of a trace. */
  readonly parentSpanId: string | undefined;
  /** The trace flags; only {@link TRACE_FLAG_SAMPLED} and {@link TRACE_FLAG_RANDOM} are kept. */
  readonly flags: number;
  /** The vendor members to pass on, in order; empty when there are none. */
  readonly traceState: readonly TraceStateMember[];
}

/**
 * The propagation headers for a span.
 *
 * @public
 */
export interface TraceHeaders {
  readonly traceparent: string;
  /** Absent when the span carries no `tracestate` members. */
  readonly tracestate?: string;
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;
const HEX_BYTE = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
/** The length of a version-00 `traceparent`, and the known prefix of any later version. */
const TRACEPARENT_LENGTH = 55;
const MAX_TRACESTATE_MEMBERS = 32;
const TRACESTATE_KEY = /^[a-z0-9][a-z0-9_\-*/@]{0,255}$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const NO_STATE: readonly TraceStateMember[] = Object.freeze([]);

/** Trim the optional whitespace (spaces and horizontal tabs) HTTP allows around a value. */
function trimOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start += 1;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

/**
 * Parse a `traceparent` header value, or `undefined` when it is absent or
 * invalid (the caller then starts a new trace and ignores `tracestate`).
 *
 * @public
 */
export function parseTraceparent(header: string | null | undefined): TraceParent | undefined {
  if (header === null || header === undefined) return undefined;
  const value = trimOws(header);
  if (value.length < TRACEPARENT_LENGTH) return undefined;
  const version = value.slice(0, 2);
  if (!HEX_BYTE.test(version) || version === 'ff') return undefined;
  if (value[2] !== '-' || value[35] !== '-' || value[52] !== '-') return undefined;
  if (version === '00') {
    if (value.length !== TRACEPARENT_LENGTH) return undefined;
  } else if (value.length > TRACEPARENT_LENGTH && value[TRACEPARENT_LENGTH] !== '-') {
    return undefined;
  }
  const traceId = value.slice(3, 35);
  const parentId = value.slice(36, 52);
  const flags = value.slice(53, 55);
  if (!HEX_TRACE_ID.test(traceId) || traceId === ZERO_TRACE_ID) return undefined;
  if (!HEX_SPAN_ID.test(parentId) || parentId === ZERO_SPAN_ID) return undefined;
  if (!HEX_BYTE.test(flags)) return undefined;
  return Object.freeze({
    version: Number.parseInt(version, 16),
    traceId,
    parentId,
    flags: Number.parseInt(flags, 16),
  });
}

/**
 * Parse a `tracestate` header value (several headers joined with `,`, as the
 * Fetch `Headers` object joins them). Returns the members in order, an empty
 * list for an empty or whitespace-only header, and `undefined` when the value
 * is malformed and must be discarded whole.
 *
 * @public
 */
export function parseTracestate(
  header: string | null | undefined,
): readonly TraceStateMember[] | undefined {
  if (header === null || header === undefined) return NO_STATE;
  const members: TraceStateMember[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const raw of header.split(',')) {
    const member = trimOws(raw);
    if (member === '') continue;
    count += 1;
    if (count > MAX_TRACESTATE_MEMBERS) return undefined;
    const equals = member.indexOf('=');
    if (equals <= 0) return undefined;
    const key = member.slice(0, equals);
    const value = member.slice(equals + 1);
    if (!TRACESTATE_KEY.test(key) || !TRACESTATE_VALUE.test(value)) return undefined;
    // The recommendation lets a receiver drop a repeated key it did not write;
    // keeping the first keeps the left-most (most recent) vendor's entry.
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(Object.freeze({ key, value }));
  }
  return members.length === 0 ? NO_STATE : Object.freeze(members);
}

/**
 * The `traceparent` value naming `trace`'s own span as the parent of the next
 * hop. Always version `00`.
 *
 * @public
 */
export function formatTraceparent(trace: TraceContext): string {
  const flags = (trace.flags & KNOWN_FLAGS).toString(16).padStart(2, '0');
  return `00-${trace.traceId}-${trace.spanId}-${flags}`;
}

/**
 * The `tracestate` value for `members`, or `undefined` when there are none
 * (an empty `tracestate` header is accepted but should not be sent).
 *
 * @public
 */
export function formatTracestate(members: readonly TraceStateMember[]): string | undefined {
  if (members.length === 0) return undefined;
  return members.map((member) => `${member.key}=${member.value}`).join(',');
}

/**
 * The headers that propagate `trace` to the next hop.
 *
 * @public
 */
export function traceHeaders(trace: TraceContext): TraceHeaders {
  const traceparent = formatTraceparent(trace);
  const tracestate = formatTracestate(trace.traceState);
  return tracestate === undefined
    ? Object.freeze({ traceparent })
    : Object.freeze({ traceparent, tracestate });
}

/**
 * Whether the caller of `trace` asked for it to be recorded.
 *
 * @public
 */
export function isTraceSampled(trace: TraceContext): boolean {
  return (trace.flags & TRACE_FLAG_SAMPLED) !== 0;
}

/** `bytes` random bytes as lower-case hex, never all zero. */
function randomHex(bytes: number): string {
  for (;;) {
    const buffer = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
    if (buffer.some((byte) => byte !== 0)) {
      return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }
}

/**
 * A new trace: fresh trace and span ids, no parent, no flags, no state.
 *
 * @public
 */
export function createRootTrace(): TraceContext {
  return Object.freeze({
    traceId: randomHex(16),
    spanId: randomHex(8),
    parentSpanId: undefined,
    flags: 0,
    traceState: NO_STATE,
  });
}

/**
 * A new span in `parent`'s trace, continuing it: same trace id, flags, and
 * state, a fresh span id, and `parent.spanId` as its parent.
 *
 * @public
 */
export function childTrace(parent: TraceContext): TraceContext {
  return Object.freeze({
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.spanId,
    flags: parent.flags & KNOWN_FLAGS,
    traceState: parent.traceState,
  });
}

/**
 * A new span continuing a remote caller's span: the caller's trace id and
 * flags, a fresh span id, and the caller's span as the parent.
 *
 * @public
 */
export function continueTrace(
  parent: TraceParent,
  traceState: readonly TraceStateMember[] = NO_STATE,
): TraceContext {
  return Object.freeze({
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.parentId,
    flags: parent.flags & KNOWN_FLAGS,
    traceState,
  });
}

/**
 * The span for work that received `traceparent` and `tracestate`: a child of
 * the caller's span when `traceparent` is valid (with `tracestate` kept when it
 * is valid too), otherwise a new trace. The caller decides whether the sender
 * may state a trace at all; an untrusted sender's headers are never passed.
 *
 * @public
 */
export function traceFromHeaders(headers: { get(name: string): string | null }): TraceContext {
  const parent = parseTraceparent(headers.get('traceparent'));
  if (parent === undefined) return createRootTrace();
  return continueTrace(parent, parseTracestate(headers.get('tracestate')) ?? NO_STATE);
}
