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

import { Buffer } from 'node:buffer';

import {
  JOB_ENVELOPE_VERSION,
  type JobEnvelope,
  type JobEnvelopeMeta,
  type JobFlowMembership,
  type JobFlowStep,
  type JobOverlap,
} from '../contract/index.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { isFlowId, MAX_CHAIN_STEPS } from '../flows/flow-limits.js';
import { isQueueName } from '../queues/queue-set.js';
import {
  isJobName,
  validDuration,
  validJobOptions,
  validKey,
  validOverlapTtl,
  validTags,
} from './job-options.js';
import { isPlainJson } from './plain-json.js';

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
  const ttlMs = validOverlapTtl(value.ttlMs);
  return key === undefined || ttlMs === undefined ? undefined : Object.freeze({ key, ttlMs });
}

const STEP_KEYS = ['queue', 'name', 'payload', 'options'] as const;
const CALLBACK_FLOWS: ReadonlySet<unknown> = new Set(['chain', 'batch']);
const CALLBACK_NAMES: ReadonlySet<unknown> = new Set(['then', 'catch', 'finally']);

/** The keys `value` has: exactly `required`, plus any of `optional`. */
function keysOf(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return exactKeys(value, [...required, ...optional.filter((key) => key in value)]);
}

/**
 * Read one stored flow member. Never throws: `undefined` for anything that is
 * not exactly a {@link JobFlowStep} whose queue, name, payload, options, tags
 * and overlap are each in bounds.
 */
export function decodeFlowStep(value: unknown): JobFlowStep | undefined {
  if (!isRecord(value) || !keysOf(value, STEP_KEYS, ['tags', 'overlap'])) return undefined;
  const { queue, name, payload } = value;
  if (!isQueueName(queue) || !isJobName(name) || !isPlainJson(payload)) return undefined;
  const options = validJobOptions(value.options);
  if (!options.ok) return undefined;
  const step: { -readonly [K in keyof JobFlowStep]: JobFlowStep[K] } = {
    queue,
    name,
    payload,
    options: options.options,
  };
  if ('tags' in value) {
    const tags = validTags(value.tags);
    if (tags === undefined || tags.length === 0) return undefined;
    step.tags = tags;
  }
  if ('overlap' in value) {
    const overlap = decodeOverlap(value.overlap);
    if (overlap === undefined) return undefined;
    step.overlap = overlap;
  }
  return Object.freeze(step);
}

function decodeChain(value: Record<string, unknown>, id: string): JobFlowMembership | undefined {
  if (!keysOf(value, ['kind', 'id', 'step', 'next'], ['catch', 'catchFired'])) return undefined;
  const step = nonNegativeInteger(value.step);
  if (step === undefined || !Array.isArray(value.next)) return undefined;
  const raw = value.next as unknown[];
  if (step + 1 + raw.length > MAX_CHAIN_STEPS) return undefined;
  const next: JobFlowStep[] = [];
  for (const entry of raw) {
    const decoded = decodeFlowStep(entry);
    if (decoded === undefined) return undefined;
    next.push(decoded);
  }
  const caught = 'catch' in value ? decodeFlowStep(value.catch) : undefined;
  if ('catch' in value && caught === undefined) return undefined;
  if ('catchFired' in value && value.catchFired !== true) return undefined;
  return Object.freeze({
    kind: 'chain',
    id,
    step,
    next: Object.freeze(next),
    ...(caught === undefined ? {} : { catch: caught }),
    ...('catchFired' in value ? { catchFired: true as const } : {}),
  });
}

function decodeFlow(value: unknown): JobFlowMembership | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  if (!isFlowId(id)) return undefined;
  switch (value.kind) {
    case 'chain':
      return decodeChain(value, id);
    case 'batch': {
      if (!exactKeys(value, ['kind', 'id', 'index'])) return undefined;
      const index = nonNegativeInteger(value.index);
      return index === undefined ? undefined : Object.freeze({ kind: 'batch', id, index });
    }
    case 'callback': {
      if (!exactKeys(value, ['kind', 'flow', 'id', 'callback'])) return undefined;
      const { flow, callback } = value;
      if (!CALLBACK_FLOWS.has(flow) || !CALLBACK_NAMES.has(callback)) return undefined;
      return Object.freeze({
        kind: 'callback',
        flow: flow as 'chain' | 'batch',
        id,
        callback: callback as 'then' | 'catch' | 'finally',
      });
    }
    default:
      return undefined;
  }
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

/** The size of `envelope` as a transport stores it: UTF-8 bytes of its JSON. */
export function encodedSize(envelope: JobEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

/**
 * Build an envelope from validated parts.
 *
 * @throws `jobs.payload_not_json` or `jobs.context_not_json` when a value
 *   would not survive serialization; `jobs.invalid_envelope` when any other
 *   part is out of bounds. Value-free: nothing of the payload is echoed.
 */
export function buildEnvelope(parts: EnvelopeParts): JobEnvelope {
  if (!isPlainJson(parts.payload)) {
    throw new JobsErrors.Error('payload_not_json');
  }
  if (parts.context !== undefined && !isPlainJson(parts.context)) {
    throw new JobsErrors.Error('context_not_json');
  }
  const meta: Record<string, unknown> = {};
  if (parts.key !== undefined) {
    meta.key = parts.key.value;
    meta.keyWindowMs = parts.key.windowMs;
  }
  if (parts.tags !== undefined && parts.tags.length > 0) meta.tags = [...parts.tags];
  if (parts.context !== undefined) meta.context = jsonCopy(parts.context);
  if (parts.overlap !== undefined) meta.overlap = { ...parts.overlap };
  if (parts.flow !== undefined) meta.flow = jsonCopy(parts.flow);
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
    throw new JobsErrors.Error('invalid_envelope');
  }
  return decoded.envelope;
}
