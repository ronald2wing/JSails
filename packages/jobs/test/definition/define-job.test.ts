/**
 * `defineJob`: a definition exposes its name, queue and `with`; a call is
 * inert; the private spec carries the resolved defaults; malformed
 * definitions are refused value-free. Also `createJobCatalog`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { createJobCatalog } from '../../src/definition/catalog.js';
import {
  defineJob,
  isJobDefinition,
  jobSpec,
  type JobContext,
  type JobFlowPosition,
  type JobMeta,
} from '../../src/definition/define-job.js';
import { isJobName } from '../../src/envelope/job-options.js';
import { JobsErrors, type JobsErrorCode } from '../../src/errors/jobs-errors.js';
import { defineQueues } from '../../src/queues/queue-set.js';

const schema = z.object({ id: z.number() });

/** A `jobs.*` refusal of `code`, whose context, when given, is exactly `context`. */
function refused(code: JobsErrorCode, context?: Readonly<Record<string, string>>) {
  return (error: unknown) =>
    JobsErrors.is(error, code) &&
    (context === undefined || JSON.stringify(error.context) === JSON.stringify(context));
}

describe('defineJob', () => {
  test('a definition exposes its name, its queue and with, and nothing else', () => {
    const Report = defineJob({ name: 'report', schema, handle: () => undefined });
    assert.deepEqual(Object.keys(Report).sort(), ['name', 'queue', 'with']);
    assert.equal(Report.name, 'report');
    assert.equal(Report.queue, 'default');
    assert.ok(Object.isFrozen(Report));
    assert.equal(isJobDefinition(Report), true);
    assert.equal(isJobDefinition({ ...Report }), false);
  });

  test('with returns an inert frozen call and runs nothing', () => {
    let ran = 0;
    const Report = defineJob({
      name: 'report',
      schema,
      handle: () => {
        ran += 1;
      },
    });
    const call = Report.with({ id: 1 }, { delayMs: 5 });
    assert.deepEqual(
      { name: call.name, payload: call.payload, options: call.options },
      { name: 'report', payload: { id: 1 }, options: { delayMs: 5 } },
    );
    assert.equal(call.definition, Report);
    assert.ok(Object.isFrozen(call));
    assert.equal(ran, 0);
  });

  test('a call keeps its own copy of its options', () => {
    const Report = defineJob({ name: 'report', schema, handle: () => undefined });
    const runAt = new Date(1_700_000_000_000);
    const tags = ['a'];
    const options: { delayMs?: number; key?: string; tags: string[]; runAt: Date } = {
      key: 'k',
      tags,
      runAt,
    };
    const call = Report.with({ id: 1 }, options);
    options.key = 'changed';
    options.delayMs = 5;
    tags.push('b');
    runAt.setTime(0);
    assert.deepEqual(call.options, { key: 'k', tags: ['a'], runAt: new Date(1_700_000_000_000) });
    assert.ok(Object.isFrozen(call.options));
    assert.ok(Object.isFrozen(call.options?.tags));
  });

  test('the spec resolves defaults', () => {
    const spec = jobSpec(defineJob({ name: 'report', schema, handle: () => undefined }));
    assert.deepEqual(spec.options, {
      attempts: 3,
      backoff: { type: 'exponential', delayMs: 1_000 },
    });
    assert.equal(spec.queue, 'default');
    assert.equal(spec.keyWindowMs, 86_400_000);
    assert.deepEqual(spec.middleware, []);
    assert.equal(spec.onSkip, 'stop');
    assert.equal(spec.onFinalFailure, 'keep');
    assert.equal(spec.key, undefined);
    assert.equal(spec.onError, undefined);
    assert.equal(spec.overlap, undefined);
  });

  test('the spec keeps the overlap option', () => {
    const fixed = jobSpec(
      defineJob({
        name: 'a',
        schema,
        overlap: { key: 'k', ttlMs: 2_000 },
        handle: () => undefined,
      }),
    );
    assert.deepEqual(fixed.overlap, { key: 'k', ttlMs: 2_000 });
    const key = (payload: { id: number }) => `id:${payload.id}`;
    const computed = jobSpec(
      defineJob({ name: 'b', schema, overlap: { key }, handle: () => undefined }),
    );
    assert.equal(computed.overlap?.key, key);
    assert.deepEqual(
      jobSpec(defineJob({ name: 'c', schema, overlap: true, handle: () => undefined })).overlap,
      {
        key: undefined,
        ttlMs: 300_000,
      },
    );
  });

  test("a handler's meta reads its flow position", () => {
    const meta: JobMeta = {
      dispatchedAt: 0,
      flow: { kind: 'chain', id: 'c', step: 1, remaining: 2 },
    };
    const position: JobFlowPosition | undefined = meta.flow;
    assert.equal(position?.kind, 'chain');
  });

  test('the spec keeps stated options and policy', async () => {
    const middleware = (_context: JobContext, next: () => Promise<void>) => next();
    const seen: unknown[] = [];
    const spec = jobSpec(
      defineJob({
        name: 'mail.send',
        schema,
        queue: 'mail',
        attempts: 5,
        backoff: { type: 'fixed', delayMs: 250 },
        timeoutMs: 10_000,
        priority: 3,
        key: (payload) => `mail:${payload.id}`,
        keyWindowMs: 60_000,
        middleware: [middleware],
        onError: () => 'discard',
        onSkip: 'continue',
        onFinalFailure: 'drop',
        handle(payload) {
          seen.push(payload, this === undefined ? 'no-this' : 'this');
        },
      }),
    );
    assert.deepEqual(spec.options, {
      attempts: 5,
      backoff: { type: 'fixed', delayMs: 250 },
      timeoutMs: 10_000,
      priority: 3,
    });
    assert.equal(spec.queue, 'mail');
    assert.equal(spec.key?.({ id: 7 }), 'mail:7');
    assert.equal(spec.keyWindowMs, 60_000);
    assert.deepEqual(spec.middleware, [middleware]);
    assert.equal(spec.onSkip, 'continue');
    assert.equal(spec.onFinalFailure, 'drop');
    await spec.handle({ id: 1 }, {} as JobContext);
    assert.deepEqual(seen, [{ id: 1 }, 'this']);
  });

  test('job names', () => {
    for (const name of ['report', 'mail.send', 'blog:publish-due', 'a_b', 'A1.b2']) {
      assert.equal(isJobName(name), true, name);
    }
    for (const name of ['', '1report', 'report.', 'a..b', 'a b', 'é', 'x'.repeat(129), 'a/b']) {
      assert.equal(isJobName(name), false, name);
    }
  });

  const rule = (value: string) => ({ rule: value });
  const option = (value: string) => ({ option: value });
  const refusedDefinitions: readonly [
    string,
    JobsErrorCode,
    Record<string, unknown>,
    Readonly<Record<string, string>>,
  ][] = [
    ['an unknown field', 'unknown_option', { retries: 3 }, {}],
    ['a bad name', 'invalid_definition', { name: 'bad name' }, rule('name')],
    ['a reserved name', 'invalid_definition', { name: 'jsails.batch' }, rule('reserved')],
    ['an overlap of false', 'invalid_option', { overlap: false }, option('overlap')],
    ['an overlap TTL under 1 s', 'invalid_option', { overlap: { ttlMs: 999 } }, option('overlap')],
    [
      'an overlap with an extra field',
      'invalid_option',
      { overlap: { scope: 'x' } },
      option('overlap'),
    ],
    ['no schema', 'invalid_definition', { schema: undefined }, rule('schema')],
    [
      'a schema that is not Zod',
      'invalid_definition',
      { schema: { parse: () => 1 } },
      rule('schema'),
    ],
    ['a bad queue', 'invalid_definition', { queue: 'Mail' }, rule('queue')],
    ['no handler', 'invalid_definition', { handle: undefined }, rule('handle')],
    ['zero attempts', 'invalid_option', { attempts: 0 }, option('attempts')],
    ['26 attempts', 'invalid_option', { attempts: 26 }, option('attempts')],
    [
      'a bad backoff',
      'invalid_option',
      { backoff: { type: 'linear', delayMs: 1 } },
      option('backoff'),
    ],
    [
      'a backoff with an extra field',
      'invalid_option',
      { backoff: { type: 'fixed', delayMs: 1, jitter: 1 } },
      option('backoff'),
    ],
    ['a zero timeout', 'invalid_option', { timeoutMs: 0 }, option('timeoutMs')],
    [
      'a timeout above a year',
      'invalid_option',
      { timeoutMs: 366 * 86_400_000 },
      option('timeoutMs'),
    ],
    ['a negative priority', 'invalid_option', { priority: -1 }, option('priority')],
    ['a key that is not a function', 'invalid_option', { key: 'k' }, option('key')],
    ['a zero key window', 'invalid_option', { keyWindowMs: 0 }, option('keyWindowMs')],
    [
      'middleware that is not functions',
      'invalid_option',
      { middleware: ['m'] },
      option('middleware'),
    ],
    ['a bad onSkip', 'invalid_option', { onSkip: 'skip' }, option('onSkip')],
    [
      'a bad onFinalFailure',
      'invalid_option',
      { onFinalFailure: 'archive' },
      option('onFinalFailure'),
    ],
  ];

  for (const [label, code, override, context] of refusedDefinitions) {
    test(`a definition with ${label} is refused with ${code}`, () => {
      const input = { name: 'report', schema, handle: () => undefined, ...override };
      assert.throws(
        () => defineJob(input as Parameters<typeof defineJob>[0]),
        refused(code, context),
      );
    });
  }

  test('a definition that is not an object is refused', () => {
    assert.throws(() => defineJob(null as never), refused('invalid_definition', rule('shape')));
  });

  test('a refusal is invalid when it names an option and internal when it names a rule', () => {
    assert.equal(JobsErrors.codes.invalid_option.kind, 'invalid');
    assert.equal(JobsErrors.codes.invalid_definition.kind, 'internal');
  });

  test('jobSpec refuses a value defineJob did not build', () => {
    assert.throws(
      () => jobSpec({ name: 'x', queue: 'default', with: () => ({}) } as never),
      refused('invalid_definition', { rule: 'not_built' }),
    );
  });
});

describe('createJobCatalog', () => {
  const queues = defineQueues({ mail: {} });

  test('indexes definitions by name in declaration order', () => {
    const A = defineJob({ name: 'a', schema, handle: () => undefined });
    const B = defineJob({ name: 'b', schema, queue: 'mail', handle: () => undefined });
    const catalog = createJobCatalog({ queues, definitions: [A, B] });
    assert.equal(catalog.get('a'), A);
    assert.equal(catalog.get('b'), B);
    assert.equal(catalog.get('c'), undefined);
    assert.deepEqual(catalog.definitions, [A, B]);
    assert.equal(catalog.queues, queues);
  });

  test('refuses two definitions with one name', () => {
    const one = defineJob({ name: 'a', schema, handle: () => undefined });
    const two = defineJob({ name: 'a', schema, handle: () => undefined });
    assert.throws(
      () => createJobCatalog({ queues, definitions: [one, two] }),
      refused('duplicate_job'),
    );
  });

  test('refuses a definition on an undeclared queue, naming the declared names only', () => {
    const job = defineJob({ name: 'a', schema, queue: 'reports', handle: () => undefined });
    assert.throws(
      () => createJobCatalog({ queues, definitions: [job] as never }),
      refused('undeclared_queue', { job: 'a', queue: 'reports' }),
    );
  });

  test('refuses a value defineJob did not build', () => {
    assert.throws(
      () =>
        createJobCatalog({
          queues,
          definitions: [{ name: 'a', queue: 'default', with: () => ({}) } as never],
        }),
      refused('invalid_definition', { rule: 'not_built' }),
    );
  });
});
