/**
 * Build and decode the job envelope.
 *
 * {@link buildEnvelope} is the only constructor: the producer calls it with a
 * validated call and the framework's own metadata, so a caller can never
 * supply `meta`. Its output always decodes, because it is checked with the
 * decoder before it is returned.
 *
 * {@link decodeEnvelope} is how a worker reads what a transport hands it. It
 * never throws and never trusts a field: an envelope of a newer version is
 * reported as such (the worker releases the job for a newer worker), and
 * anything else that is not exactly a version-{@link JOB_ENVELOPE_VERSION}
 * envelope, including one with an extra field, is malformed. A shape change
 * therefore cannot slip through under the current version number.
 */

import { JsailsError } from 'jsails/support';

import {
  JOB_ENVELOPE_VERSION,
  type JobEnvelope,
  type JobEnvelopeMeta,
  type JobFlowMembership,
  type JobOverlap,
} from '../contract/index.js';
import { validDuration, validJobOptions, validKey, validTags } from './job-options.js';
import { isPlainJson } from './plain-json.js';

export type JobEnvelopeErrorCode = 'payload_not_json' | 'context_not_json' | 'invalid_envelope';

/** Raised by {@link buildEnvelope}. Value-free: it never echoes the payload. */
export class JobEnvelopeError extends JsailsError {
  constructor(
    readonly code: JobEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Everything an envelope is built from. */
export interface EnvelopeParts {
  readonly name: string;
  /** The schema input, already validated; it must be plain JSON. */
  readonly payload: unknown;
  readonly options: JobEnvelope['options'];
  readonly key?: { readonly value: string; readonly windowMs: number };
  readonly tags?: readonly string[];
  readonly context?: unknown;
  readonly overlap?: JobOverlap;
  readonly flow?: JobFlowMembership;
  readonly runAt?: number;
  readonly dispatchedAt: number;
}

/** What {@link decodeEnvelope} found. */
export type DecodedEnvelope =
  | { readonly ok: true; readonly envelope: JobEnvelope }
  | { readonly ok: false; readonly reason: 'newer_version' | 'malformed' };

const ENVELOPE_KEYS = new Set(['v', 'name', 'payload', 'options', 'meta']);
const META_KEYS = new Set([
  'key',
  'keyWindowMs',
  'tags',
  'context',
  'overlap',
  'flow',
  'runAt',
  'dispatchedAt',
]);

const MALFORMED: DecodedEnvelope = Object.freeze({ ok: false, reason: 'malformed' });

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function epoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function decodeOverlap(value: unknown): JobOverlap | undefined {
  if (!isRecord(value) || !exactKeys(value, ['key', 'ttlMs'])) return undefined;
  const key = validKey(value.key);
  const ttlMs = validDuration(value.ttlMs);
  return key === undefined || ttlMs === undefined ? undefined : Object.freeze({ key, ttlMs });
}

function decodeFlow(value: unknown): JobFlowMembership | undefined {
  if (!isRecord(value)) return undefined;
  const id = validKey(value.id);
  if (id === undefined) return undefined;
  if (value.kind === 'chain') {
    const hasCatch = 'catchFired' in value;
    if (
      !exactKeys(value, hasCatch ? ['kind', 'id', 'step', 'catchFired'] : ['kind', 'id', 'step'])
    ) {
      return undefined;
    }
    const step = nonNegativeInteger(value.step);
    if (step === undefined) return undefined;
    if (hasCatch && typeof value.catchFired !== 'boolean') return undefined;
    return Object.freeze(
      hasCatch
        ? { kind: 'chain', id, step, catchFired: value.catchFired as boolean }
        : { kind: 'chain', id, step },
    );
  }
  if (value.kind === 'batch') {
    if (!exactKeys(value, ['kind', 'id', 'index'])) return undefined;
    const index = nonNegativeInteger(value.index);
    return index === undefined ? undefined : Object.freeze({ kind: 'batch', id, index });
  }
  return undefined;
}

function decodeMeta(value: unknown): JobEnvelopeMeta | undefined {
  if (!isRecord(value) || !onlyKeys(value, META_KEYS)) return undefined;
  const meta: { -readonly [K in keyof JobEnvelopeMeta]: JobEnvelopeMeta[K] } = {
    dispatchedAt: 0,
  };
  const dispatchedAt = epoch(value.dispatchedAt);
  if (dispatchedAt === undefined) return undefined;
  meta.dispatchedAt = dispatchedAt;
  if ('key' in value !== 'keyWindowMs' in value) return undefined;
  if ('key' in value) {
    const key = validKey(value.key);
    const keyWindowMs = validDuration(value.keyWindowMs);
    if (key === undefined || keyWindowMs === undefined) return undefined;
    meta.key = key;
    meta.keyWindowMs = keyWindowMs;
  }
  if ('tags' in value) {
    const tags = validTags(value.tags);
    if (tags === undefined) return undefined;
    meta.tags = tags;
  }
  if ('context' in value) {
    if (!isPlainJson(value.context)) return undefined;
    meta.context = value.context;
  }
  if ('overlap' in value) {
    const overlap = decodeOverlap(value.overlap);
    if (overlap === undefined) return undefined;
    meta.overlap = overlap;
  }
  if ('flow' in value) {
    const flow = decodeFlow(value.flow);
    if (flow === undefined) return undefined;
    meta.flow = flow;
  }
  if ('runAt' in value) {
    const runAt = epoch(value.runAt);
    if (runAt === undefined) return undefined;
    meta.runAt = runAt;
  }
  return Object.freeze(meta);
}

/** Read a stored envelope. Never throws. */
export function decodeEnvelope(value: unknown): DecodedEnvelope {
  if (!isRecord(value)) return MALFORMED;
  const version = value.v;
  if (
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > JOB_ENVELOPE_VERSION
  ) {
    return Object.freeze({ ok: false, reason: 'newer_version' });
  }
  if (version !== JOB_ENVELOPE_VERSION || !exactKeys(value, [...ENVELOPE_KEYS])) return MALFORMED;
  const name = value.name;
  if (typeof name !== 'string' || name.length === 0) return MALFORMED;
  if (!isPlainJson(value.payload)) return MALFORMED;
  const options = validJobOptions(value.options);
  if (!options.ok) return MALFORMED;
  const meta = decodeMeta(value.meta);
  if (meta === undefined) return MALFORMED;
  const envelope: JobEnvelope = {
    v: JOB_ENVELOPE_VERSION,
    name,
    payload: value.payload,
    options: options.options,
    meta,
  };
  return Object.freeze({ ok: true, envelope: Object.freeze(envelope) });
}

/** A copy that shares nothing with the caller's value, so a later mutation cannot reach the envelope. */
function jsonCopy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * Build an envelope from validated parts.
 *
 * @throws {JobEnvelopeError} `payload_not_json` or `context_not_json` when a
 *   value would not survive serialization; `invalid_envelope` when any other
 *   part is out of bounds.
 */
export function buildEnvelope(parts: EnvelopeParts): JobEnvelope {
  if (!isPlainJson(parts.payload)) {
    throw new JobEnvelopeError(
      'payload_not_json',
      'a job payload must be plain JSON: objects, arrays, strings, finite numbers, booleans and null',
    );
  }
  if (parts.context !== undefined && !isPlainJson(parts.context)) {
    throw new JobEnvelopeError(
      'context_not_json',
      'a serialized execution context must be plain JSON',
    );
  }
  const meta: Record<string, unknown> = {};
  if (parts.key !== undefined) {
    meta.key = parts.key.value;
    meta.keyWindowMs = parts.key.windowMs;
  }
  if (parts.tags !== undefined && parts.tags.length > 0) meta.tags = [...parts.tags];
  if (parts.context !== undefined) meta.context = jsonCopy(parts.context);
  if (parts.overlap !== undefined) meta.overlap = { ...parts.overlap };
  if (parts.flow !== undefined) meta.flow = { ...parts.flow };
  if (parts.runAt !== undefined) meta.runAt = parts.runAt;
  meta.dispatchedAt = parts.dispatchedAt;
  const decoded = decodeEnvelope({
    v: JOB_ENVELOPE_VERSION,
    name: parts.name,
    payload: jsonCopy(parts.payload),
    options: { ...parts.options },
    meta,
  });
  if (!decoded.ok) {
    throw new JobEnvelopeError('invalid_envelope', 'the job envelope parts are out of bounds');
  }
  return decoded.envelope;
}
