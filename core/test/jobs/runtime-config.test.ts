/**
 * Tests for the `extensions` field on the runtime config: structural
 * validation (reuses `validateExtensionEntries`) and integration into
 * the resolved config shape. No adapter factories are invoked and no
 * handlers are executed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MutexStore } from '../../src/cache/mutex.js';
import { validateRuntimeConfig, RuntimeConfigError } from '../../src/jobs/runtime-config.js';
import type { JobsRuntimeAdapter } from '../../src/jobs/runtime.js';

/**
 * Minimal {@link MutexStore} fixture passing the structural guard. The real
 * implementation lives in `@jsails/cache`.
 */
const mutexFixture: MutexStore = {
  acquire: async () => true,
  release: async () => undefined,
  close: async () => undefined,
};

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

describe('validateRuntimeConfig overlapMutex', () => {
  it('passes a mutex store through by identity', () => {
    const mutex = mutexFixture;
    const result = validateRuntimeConfig(makeConfig({ overlapMutex: mutex }), {});
    assert.equal(result.overlapMutex, mutex);
  });

  it('rejects a malformed mutex store', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ overlapMutex: {} }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.match(err.message, /overlapMutex/);
        return true;
      },
    );
  });
});

describe('validateRuntimeConfig extensions', () => {
  it('rejects extensions that are not an array', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ extensions: {} }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.match(err.message, /config\.extensions must be an array/);
        return true;
      },
    );
  });

  it('rejects an extension entry missing name/setup (delegates to validateExtensionEntries)', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ extensions: [{}] }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.match(err.message, /config\.extensions is invalid/);
        // The shared validator reports the specific code; the config error
        // only exposes the code, never the entry internals.
        assert.match(err.message, /missing_name/);
        return true;
      },
    );
  });

  it('rejects an extension entry with setup missing', () => {
    assert.throws(
      () => validateRuntimeConfig(makeConfig({ extensions: [{ name: 'x' }] }), {}),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.match(err.message, /config\.extensions is invalid/);
        assert.match(err.message, /missing_setup/);
        return true;
      },
    );
  });

  it('passes a valid minimal extension and lands it in result.extensions', () => {
    const ext = { name: 'x', setup() {} };
    const result = validateRuntimeConfig(makeConfig({ extensions: [ext] }), {});
    assert.deepEqual(result.extensions, [ext]);
  });

  it('defaults extensions to [] when absent', () => {
    const result = validateRuntimeConfig(makeConfig(), {});
    assert.deepEqual(result.extensions, []);
  });
});
