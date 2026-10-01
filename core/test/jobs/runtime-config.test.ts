/**
 * Tests for the `extensions` field on the runtime config: structural
 * validation (reuses `validateExtensionEntries`) and integration into
 * the resolved config shape. No adapter factories are invoked and no
 * handlers are executed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryFailedJobHistory } from '../../src/jobs/failed-job-history.js';
import { validateRuntimeConfig, RuntimeConfigError } from '../../src/jobs/runtime-config.js';
import type { JobsRuntimeAdapter } from '../../src/jobs/runtime.js';
import { MapLeaseStore } from '../cache/map-cache-store.js';

// ---------------------------------------------------------------------------
// minimal fake adapter (no URL needed)
// ---------------------------------------------------------------------------

function fakeAdapter(): JobsRuntimeAdapter {
  return {
    name: 'fake',
    createProducer: () => ({
      dispatch: async () => undefined,
      close: async () => undefined,
    }),
    createWorker: () => ({ close: async () => undefined }),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry: { ping: { schema: {}, handler: async () => {} } },
    adapter: fakeAdapter(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extensions validation
// ---------------------------------------------------------------------------

describe('validateRuntimeConfig overlapLeases', () => {
  it('passes a lease store through by identity', () => {
    const leases = new MapLeaseStore();
    const result = validateRuntimeConfig(makeConfig({ overlapLeases: leases }), {});
    assert.equal(result.overlapLeases, leases);
  });

  it('rejects a malformed lease store', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ overlapLeases: {} }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.match(err.message, /overlapLeases/);
        return true;
      },
    );
  });
});

describe('validateRuntimeConfig failedJobs', () => {
  it('is absent unless configured, and passes a history through by identity', () => {
    assert.equal(validateRuntimeConfig(makeConfig(), {}).failedJobs, undefined);
    const history = new InMemoryFailedJobHistory();
    assert.equal(
      validateRuntimeConfig(makeConfig({ failedJobs: history }), {}).failedJobs,
      history,
    );
  });

  it('rejects a value that is not a failed-job history', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ failedJobs: { record() {} } }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.equal(err.code, 'invalid_config');
        assert.match(err.message, /failedJobs/);
        return true;
      },
    );
  });
});

describe('validateRuntimeConfig extensions', () => {
  it('refuses an extensions key, pointing at the app config, without echoing it', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ extensions: [{ name: 'secret-x' }] }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.equal(err.code, 'invalid_config');
        assert.match(err.message, /app config/);
        assert.doesNotMatch(err.message, /secret-x/);
        return true;
      },
    );
  });
});

describe('validateRuntimeConfig retention and timeouts', () => {
  it('passes validated timeouts through', () => {
    const result = validateRuntimeConfig(
      makeConfig({ jobTimeoutMs: 60_000, shutdownTimeoutMs: 0 }),
      {},
    );
    assert.equal(result.jobTimeoutMs, 60_000);
    assert.equal(result.shutdownTimeoutMs, 0);
    const defaults = validateRuntimeConfig(makeConfig(), {});
    assert.equal('jobTimeoutMs' in defaults, false);
  });

  it('rejects malformed timeouts and retention', () => {
    for (const overrides of [
      { jobTimeoutMs: 0 },
      { shutdownTimeoutMs: -1 },
      { jobTimeoutMs: '10s' },
      { removeOnComplete: 'always' },
      { removeOnFail: { age: -1 } },
    ]) {
      assert.throws(
        () => validateRuntimeConfig(makeConfig(overrides), {}),
        RuntimeConfigError,
        JSON.stringify(overrides),
      );
    }
  });

  it('accepts retention for the built-in adapter', () => {
    const result = validateRuntimeConfig(
      {
        registry: { ping: { schema: {}, handler: async () => {} } },
        valkeyUrl: 'redis://127.0.0.1:6379',
        removeOnComplete: { count: 10 },
        removeOnFail: false,
      },
      {},
    );
    assert.equal(result.adapter.name, 'bullmq');
  });
});
