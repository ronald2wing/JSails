/**
 * The envelope wire shape is pinned per version. Every process that reads a
 * queue relies on it, so a change to the shape that keeps
 * `JOB_ENVELOPE_VERSION` fails here; bumping the version and recording the new
 * shape under it is the deliberate act a shape change requires.
 *
 * Two layers hold it: the field tables below are typed against the contract,
 * so adding or removing a field in the types stops the test build, and the
 * recorded shape is compared with what the builder emits and the decoder
 * accepts.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  JOB_ENVELOPE_VERSION,
  type JobBackoff,
  type JobEnvelope,
  type JobEnvelopeMeta,
  type JobFlowMembership,
  type JobOptions,
  type JobOverlap,
} from '../../src/contract/index.js';
import { buildEnvelope, decodeEnvelope } from '../../src/envelope/codec.js';

type Fields<T> = { readonly [K in keyof Required<T>]: true };
type Union<T> = T extends unknown ? keyof T : never;

const ENVELOPE_FIELDS: Fields<JobEnvelope> = {
  v: true,
  name: true,
  payload: true,
  options: true,
  meta: true,
};
const OPTION_FIELDS: Fields<JobOptions> = {
  attempts: true,
  backoff: true,
  timeoutMs: true,
  priority: true,
};
const BACKOFF_FIELDS: Fields<JobBackoff> = { type: true, delayMs: true };
const OVERLAP_FIELDS: Fields<JobOverlap> = { key: true, ttlMs: true };
const FLOW_FIELDS: { readonly [K in Union<JobFlowMembership>]: true } = {
  kind: true,
  id: true,
  step: true,
  catchFired: true,
  index: true,
};
const META_FIELDS: Fields<JobEnvelopeMeta> = {
  key: true,
  keyWindowMs: true,
  tags: true,
  context: true,
  overlap: true,
  flow: true,
  runAt: true,
  dispatchedAt: true,
};

/**
 * The recorded shape of each version: every leaf path with its JSON type.
 * `payload` and `meta.context` are opaque JSON. Add an entry when bumping
 * `JOB_ENVELOPE_VERSION`; never edit a recorded one.
 */
const RECORDED_SHAPES: Readonly<Record<number, readonly string[]>> = {
  1: [
    'meta.context: json',
    'meta.dispatchedAt: number',
    'meta.flow.catchFired: boolean',
    'meta.flow.id: string',
    'meta.flow.index: number',
    'meta.flow.kind: string',
    'meta.flow.step: number',
    'meta.key: string',
    'meta.keyWindowMs: number',
    'meta.overlap.key: string',
    'meta.overlap.ttlMs: number',
    'meta.runAt: number',
    'meta.tags[]: string',
    'name: string',
    'options.attempts: number',
    'options.backoff.delayMs: number',
    'options.backoff.type: string',
    'options.priority: number',
    'options.timeoutMs: number',
    'payload: json',
    'v: number',
  ],
};

const OPAQUE = new Set(['payload', 'meta.context']);

function leafPaths(value: unknown, path: string, out: Set<string>): void {
  if (OPAQUE.has(path)) {
    out.add(`${path}: json`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) leafPaths(entry, `${path}[]`, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      leafPaths(entry, path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  out.add(`${path}: ${typeof value}`);
}

/** Envelopes that between them set every field. */
function maximalEnvelopes(): JobEnvelope[] {
  const common = {
    name: 'report',
    payload: { id: 1 },
    options: { attempts: 3, backoff: { type: 'fixed', delayMs: 10 }, timeoutMs: 5, priority: 1 },
    key: { value: 'k', windowMs: 1_000 },
    tags: ['t'],
    context: { trace: 'x' },
    overlap: { key: 'o', ttlMs: 10 },
    runAt: 10,
    dispatchedAt: 1,
  } as const;
  return [
    buildEnvelope({ ...common, flow: { kind: 'chain', id: 'c', step: 0, catchFired: false } }),
    buildEnvelope({ ...common, flow: { kind: 'batch', id: 'b', index: 0 } }),
  ];
}

function shapeOf(envelopes: readonly JobEnvelope[]): string[] {
  const out = new Set<string>();
  for (const envelope of envelopes) leafPaths(JSON.parse(JSON.stringify(envelope)), '', out);
  return [...out].sort();
}

describe('envelope wire shape', () => {
  test('the shape matches the one recorded for JOB_ENVELOPE_VERSION', () => {
    const recorded = RECORDED_SHAPES[JOB_ENVELOPE_VERSION];
    assert.ok(
      recorded !== undefined,
      `no shape is recorded for envelope version ${JOB_ENVELOPE_VERSION}; record it in RECORDED_SHAPES`,
    );
    assert.deepEqual(
      shapeOf(maximalEnvelopes()),
      recorded,
      'the envelope shape changed without a new JOB_ENVELOPE_VERSION: bump the version and record the new shape',
    );
  });

  test('the maximal envelopes set every field the contract declares', () => {
    const [chain, batch] = maximalEnvelopes();
    assert.deepEqual(Object.keys(chain!).sort(), Object.keys(ENVELOPE_FIELDS).sort());
    assert.deepEqual(Object.keys(chain!.options).sort(), Object.keys(OPTION_FIELDS).sort());
    assert.deepEqual(
      Object.keys(chain!.options.backoff!).sort(),
      Object.keys(BACKOFF_FIELDS).sort(),
    );
    assert.deepEqual(Object.keys(chain!.meta).sort(), Object.keys(META_FIELDS).sort());
    assert.deepEqual(Object.keys(chain!.meta.overlap!).sort(), Object.keys(OVERLAP_FIELDS).sort());
    assert.deepEqual(
      [...new Set([...Object.keys(chain!.meta.flow!), ...Object.keys(batch!.meta.flow!)])].sort(),
      Object.keys(FLOW_FIELDS).sort(),
    );
  });

  test('every recorded field is accepted by the decoder, and nothing beside it', () => {
    for (const envelope of maximalEnvelopes()) {
      const stored = JSON.parse(JSON.stringify(envelope)) as Record<
        string,
        Record<string, unknown>
      >;
      assert.ok(decodeEnvelope(stored).ok);
      for (const target of [
        stored,
        stored.options!,
        stored.meta!,
        stored.meta!.flow as Record<string, unknown>,
      ]) {
        target.extraField = 1;
        assert.deepEqual(decodeEnvelope(stored), { ok: false, reason: 'malformed' });
        delete target.extraField;
      }
    }
  });
});
