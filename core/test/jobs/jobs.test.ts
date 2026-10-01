/** Tests for the jobs core: the default prefix, the registry, job option validation, and the neutral runtime over a fake adapter. */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { defaultQueuePrefix } from '../../src/jobs/connection.js';
import {
  createJobRegistry,
  defineJob,
  JobPayloadError,
  validatePayload,
  type JobDefinition,
} from '../../src/jobs/registry.js';
import { JobOptionsError, validateJobOptions } from '../../src/jobs/queue.js';

/**
 * Shared job-policy unit tests that never touch Redis: connection role options,
 * registry validation, and the bounded dispatch-option allowlist. The neutral
 * runtime and the built-in BullMQ adapter are exercised separately in
 * `runtime.test.ts` and `bullmq-adapter.test.ts`.
 */

describe('defaultQueuePrefix', () => {
  it('names the app, sanitized for a Valkey key, and the mode', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'jsails-prefix-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/shop app' }));
    assert.equal(defaultQueuePrefix(root, { NODE_ENV: 'production' }), 'acme-shop-app:production');
    assert.equal(
      defaultQueuePrefix(root, { NODE_ENV: 'development' }),
      'acme-shop-app:development',
    );
    // Any other value, unset included, is production: the mode a plugin's
    // setup sees, so a web process and a runtime config key one queue alike.
    assert.equal(defaultQueuePrefix(root, {}), 'acme-shop-app:production');
    assert.equal(defaultQueuePrefix(root, { NODE_ENV: 'staging' }), 'acme-shop-app:production');
  });

  it('skips a nameless nested package.json, so every start point of one app agrees', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'jsails-prefix-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'shop' }));
    const nested = join(root, 'config');
    await mkdir(nested);
    await writeFile(join(nested, 'package.json'), JSON.stringify({ type: 'module' }));
    const broken = join(root, 'jobs');
    await mkdir(broken);
    await writeFile(join(broken, 'package.json'), '{ not json');
    const env = { NODE_ENV: 'test' };

    assert.equal(defaultQueuePrefix(nested, env), 'shop:test');
    assert.equal(defaultQueuePrefix(broken, env), 'shop:test');
    assert.equal(defaultQueuePrefix(nested, env), defaultQueuePrefix(root, env));
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('defineJob infers the handler payload type from the schema', () => {
    const job = defineJob(z.object({ n: z.number() }), async (data) => {
      // Compile-time check: data is typed; asserted at runtime for safety.
      assert.equal(typeof data.n, 'number');
    });
    assert.equal(typeof job.handler, 'function');
  });

  it('defineJob accepts one object and infers the handler payload', () => {
    const job = defineJob({
      name: 'typed',
      schema: z.object({ n: z.number() }),
      async handler(data) {
        assert.equal(typeof data.n, 'number');
      },
      onError: { retryOn: () => true },
    });
    assert.equal(job.name, 'typed');
    assert.equal(typeof job.handler, 'function');
    assert.equal(typeof job.policy?.retryOn, 'function');
  });

  it('createJobRegistry accepts a plain object with a matching name', () => {
    const plain: JobDefinition = {
      name: 'plain',
      schema: z.object({}),
      handler: async () => {},
    };
    const registry = createJobRegistry({ plain });
    assert.equal(registry.plain.name, 'plain');
  });

  it('createJobRegistry rejects a definition whose name differs from its key', () => {
    assert.throws(
      () =>
        createJobRegistry({
          actual: {
            name: 'other',
            schema: z.object({}),
            handler: async () => {},
          },
        }),
      /different name/,
    );
  });

  it('createJobRegistry rejects a missing handler', () => {
    const broken = {
      broken: { schema: z.object({}), handler: undefined },
    } as unknown as Record<string, JobDefinition>;
    assert.throws(() => createJobRegistry(broken), /must define a schema and a handler/);
  });

  it('redacts unrecognized payload field names from validation errors', () => {
    const schema = z.object({ to: z.string() }).strict();
    const sensitiveKey = 'super-secret-api-key';

    assert.throws(
      () => validatePayload(schema, 'sendEmail', { to: 'a@b.co', [sensitiveKey]: 'leak' }),
      (error: unknown) => {
        assert.ok(error instanceof JobPayloadError);
        assert.ok(
          !error.message.includes(sensitiveKey),
          'error must not echo the payload-provided field name',
        );
        assert.match(error.message, /unknown field/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// dispatch option allowlist
// ---------------------------------------------------------------------------

describe('validateJobOptions', () => {
  it('rejects unbounded attempts', () => {
    assert.throws(() => validateJobOptions({ attempts: 1000000 }), JobOptionsError);
    assert.throws(() => validateJobOptions({ attempts: 0 }), JobOptionsError);
    assert.throws(() => validateJobOptions({ attempts: 1.5 }), JobOptionsError);
  });

  it('rejects dangerous backoff shapes', () => {
    assert.throws(() => validateJobOptions({ backoff: { type: 'custom' } }), JobOptionsError);
    assert.throws(
      () => validateJobOptions({ backoff: { type: 'fixed', delay: -1 } }),
      JobOptionsError,
    );
  });

  it('passes allowlisted options through', () => {
    const result = validateJobOptions({
      attempts: 3,
      backoff: { type: 'fixed', delay: 100 },
      delay: 10,
    });
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.backoff, { type: 'fixed', delay: 100 });
    assert.equal(result.delay, 10);
  });
});
