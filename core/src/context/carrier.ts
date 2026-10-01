/**
 * The context carrier: an execution context as plain JSON, for a job envelope
 * or another process.
 *
 * {@link serializeContext} writes the span as `traceparent` and `tracestate`,
 * the request id, and every value whose key was declared with a `propagate`
 * codec, by key name. {@link restoreContext} reads one back into a new context
 * whose span is a child of the carried one, so a job runs as its own span in
 * its dispatcher's trace. Values of keys without a codec (the application
 * scope, a component frame, anything live) never enter a carrier.
 *
 * A carrier read back from a queue is input: its shape, version, span, request
 * id, and every value are validated, and a failure names only the field or the
 * key at fault. A carried key this process has not declared (a plugin the
 * worker does not load) is skipped. A `tracestate` that fails to parse is
 * dropped, as the Trace Context recommendation requires, without failing the
 * restore.
 */

import { ContextErrors } from './context-errors.js';
import {
  contextEntries,
  contextKeyRecord,
  createExecutionContext,
  currentContext,
  isRequestId,
  type ContextEntry,
  type ExecutionContext,
} from './execution-context.js';
import {
  continueTrace,
  formatTraceparent,
  formatTracestate,
  parseTraceparent,
  parseTracestate,
} from './trace-context.js';

/**
 * The carrier wire version. Bumped on any change to {@link ContextCarrier}'s shape.
 *
 * @public
 */
export const CONTEXT_CARRIER_VERSION = 1;

/** The longest carried value text; a codec's output is a compact id or tag, never a document. */
const MAX_VALUE_LENGTH = 1024;

/**
 * An execution context as plain JSON.
 *
 * @public
 */
export interface ContextCarrier {
  readonly v: typeof CONTEXT_CARRIER_VERSION;
  /** The carried span, as the parent of the restored one. */
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly requestId?: string;
  /** Encoded values by key name; absent when no propagated key is set. */
  readonly values?: Readonly<Record<string, string>>;
}

const CARRIER_FIELDS: ReadonlySet<string> = new Set([
  'v',
  'traceparent',
  'tracestate',
  'requestId',
  'values',
]);

/**
 * `context` (the current context by default) as a carrier, or `undefined`
 * when there is no context.
 *
 * @throws `context.unencodable_value` when a codec returns text that is empty,
 *   longer than 1024 characters, or not a string.
 * @public
 */
export function serializeContext(
  context: ExecutionContext | undefined = currentContext(),
): ContextCarrier | undefined {
  if (context === undefined) return undefined;
  let values: Record<string, string> | undefined;
  for (const [key, value] of contextEntries(context)) {
    if (!key.propagated) continue;
    const codec = contextKeyRecord(key.name)?.codec;
    if (codec === undefined) continue;
    const text = codec.encode(value);
    if (text === undefined) continue;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_VALUE_LENGTH) {
      throw new ContextErrors.Error('unencodable_value', { key: key.name });
    }
    values ??= {};
    values[key.name] = text;
  }
  const tracestate = formatTracestate(context.trace.traceState);
  return Object.freeze({
    v: CONTEXT_CARRIER_VERSION,
    traceparent: formatTraceparent(context.trace),
    ...(tracestate === undefined ? {} : { tracestate }),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    ...(values === undefined ? {} : { values: Object.freeze(values) }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function malformed(field: 'shape' | 'traceparent' | 'requestId' | 'values'): Error {
  return new ContextErrors.Error('invalid_carrier', { field });
}

function restoreValues(raw: unknown): ContextEntry<unknown>[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) throw malformed('values');
  const entries: ContextEntry<unknown>[] = [];
  for (const [name, text] of Object.entries(raw)) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_VALUE_LENGTH) {
      throw malformed('values');
    }
    const record = contextKeyRecord(name);
    // A key this process never declared, or declared without a codec, has no
    // reader here; its value stays with the process that understands it.
    if (record?.codec === undefined) continue;
    const value = record.codec.decode(text);
    if (value === undefined) throw new ContextErrors.Error('invalid_value', { key: name });
    entries.push([record.key, value]);
  }
  return entries;
}

/**
 * A new execution context from a carrier: a child span of the carried one,
 * the carried request id, and every carried value whose key this process
 * declares with a codec.
 *
 * @throws `context.unsupported_carrier` for a carrier of another version, and
 *   `context.invalid_carrier` or `context.invalid_value` for a malformed one.
 * @public
 */
export function restoreContext(carrier: unknown): ExecutionContext {
  if (!isPlainObject(carrier)) throw malformed('shape');
  if (carrier.v !== CONTEXT_CARRIER_VERSION) {
    if (typeof carrier.v === 'number' && Number.isInteger(carrier.v)) {
      throw new ContextErrors.Error('unsupported_carrier');
    }
    throw malformed('shape');
  }
  for (const field of Object.keys(carrier)) {
    if (!CARRIER_FIELDS.has(field)) throw malformed('shape');
  }
  const parent =
    typeof carrier.traceparent === 'string' ? parseTraceparent(carrier.traceparent) : undefined;
  if (parent === undefined) throw malformed('traceparent');
  const traceState =
    typeof carrier.tracestate === 'string' ? parseTracestate(carrier.tracestate) : undefined;
  const { requestId } = carrier;
  if (requestId !== undefined && !isRequestId(requestId)) throw malformed('requestId');
  return createExecutionContext({
    trace: continueTrace(parent, traceState),
    ...(requestId === undefined ? {} : { requestId }),
    values: restoreValues(carrier.values),
  });
}
