/**
 * Declared queues: `default` is always present, each queue keeps its own
 * concurrency and retention, durations parse, out-of-bounds declarations are
 * refused value-free, and the namespace joins app and environment.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_QUEUE,
  DEFAULT_RETENTION,
  defineQueues,
  jobsNamespace,
  parseDuration,
  QueueConfigError,
} from '../../src/queues/queue-set.js';

function refused(code: string) {
  return (error: unknown) => error instanceof QueueConfigError && error.code === code;
}

describe('defineQueues', () => {
  test('an empty declaration has the default queue with the defaults', () => {
    const queues = defineQueues({});
    assert.deepEqual(queues.names, [DEFAULT_QUEUE]);
    assert.deepEqual(queues.declarations, [
      { name: 'default', concurrency: 1, retention: DEFAULT_RETENTION },
    ]);
    assert.equal(queues.has('default'), true);
    assert.equal(queues.has('mail'), false);
    assert.equal(queues.get('mail'), undefined);
  });

  test('each queue keeps its own concurrency and retention; default comes first', () => {
    const queues = defineQueues({
      mail: { concurrency: 5, retention: { failed: { age: '30d', count: 10 } } },
      default: { concurrency: 2 },
    });
    assert.deepEqual(queues.names, ['default', 'mail']);
    assert.deepEqual(queues.get('mail'), {
      name: 'mail',
      concurrency: 5,
      retention: {
        completed: DEFAULT_RETENTION.completed,
        failed: { ageMs: 30 * 86_400_000, count: 10 },
      },
    });
    assert.equal(queues.get('default')?.concurrency, 2);
    assert.ok(Object.isFrozen(queues.get('mail')));
  });

  test('durations parse from milliseconds and unit strings', () => {
    assert.equal(parseDuration(0), 0);
    assert.equal(parseDuration(1500), 1500);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('15m'), 900_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('7d'), 604_800_000);
    for (const bad of ['7', '1.5h', '-1s', '7w', ' 7d', -1, 1.5, Number.NaN, null]) {
      assert.equal(parseDuration(bad), undefined, String(bad));
    }
  });

  const refusedDeclarations: readonly [string, unknown][] = [
    ['an upper-case name', { Mail: {} }],
    ['a name with a colon', { 'a:b': {} }],
    ['a name starting with a digit', { '1mail': {} }],
    ['zero concurrency', { mail: { concurrency: 0 } }],
    ['fractional concurrency', { mail: { concurrency: 1.5 } }],
    ['excessive concurrency', { mail: { concurrency: 1001 } }],
    ['an unknown queue field', { mail: { workers: 2 } }],
    ['an unknown retention field', { mail: { retention: { stalled: {} } } }],
    ['an unknown rule field', { mail: { retention: { failed: { size: 1 } } } }],
    ['a negative count', { mail: { retention: { failed: { count: -1 } } } }],
    ['a bad age', { mail: { retention: { completed: { age: 'forever' } } } }],
    ['an age above a year', { mail: { retention: { completed: { age: '366d' } } } }],
    ['a non-object declaration', { mail: 3 }],
  ];

  for (const [label, declaration] of refusedDeclarations) {
    test(`a declaration with ${label} is refused`, () => {
      assert.throws(
        () => defineQueues(declaration as Parameters<typeof defineQueues>[0]),
        refused('invalid_queue'),
      );
    });
  }

  test('a refusal does not echo the offending name', () => {
    assert.throws(
      () => defineQueues({ 'Secret-Queue': {} }),
      (error: unknown) => error instanceof QueueConfigError && !error.message.includes('Secret'),
    );
  });
});

describe('jobsNamespace', () => {
  test('joins app and environment', () => {
    assert.equal(jobsNamespace('shop', 'production'), 'shop:production');
    assert.equal(jobsNamespace('my_app.v2', 'staging-eu'), 'my_app.v2:staging-eu');
  });

  test('refuses a part that could break the namespace', () => {
    for (const [app, environment] of [
      ['', 'production'],
      ['shop', ''],
      ['a:b', 'production'],
      ['shop', 'prod uction'],
      ['@scope/app', 'production'],
      ['x'.repeat(65), 'production'],
    ] as const) {
      assert.throws(() => jobsNamespace(app, environment), refused('invalid_namespace'));
    }
  });
});
