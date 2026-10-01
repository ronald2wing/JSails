/**
 * Tests for `RegistrySignalBus`: emit delegates to the interceptor registry,
 * observer failures are isolated and collected, a sealed registry rejects new
 * observers, and construction without a registry fails with `SignalError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInterceptorRegistry,
  defineEvent,
  InterceptorError,
} from '../../src/extensions/index.js';
import { RegistrySignalBus, SignalError } from '../../src/signals/index.js';

describe('RegistrySignalBus', () => {
  const event = defineEvent<{ n: number }>('test-event');

  it('delegates emit to the underlying InterceptorRegistry', async () => {
    const registry = createInterceptorRegistry();
    const bus = new RegistrySignalBus(registry);

    let observerRan = false;
    registry.observe(event, () => {
      observerRan = true;
    });

    const errors = await bus.emit(event, { n: 1 });
    assert.equal(errors.length, 0);
    assert.equal(observerRan, true);
  });

  it('emit returns isolated errors and continues through observers', async () => {
    const registry = createInterceptorRegistry();
    const bus = new RegistrySignalBus(registry);

    registry.observe(event, () => {
      throw new Error('first-error');
    });
    let secondRan = false;
    registry.observe(event, () => {
      secondRan = true;
    });
    registry.observe(event, () => {
      throw new Error('third-error');
    });

    const errors = await bus.emit(event, { n: 2 });
    assert.equal(errors.length, 2);
    const [e0, e1] = errors;
    assert.ok(e0 instanceof Error);
    assert.equal(e0.message, 'first-error');
    assert.ok(e1 instanceof Error);
    assert.equal(e1.message, 'third-error');
    assert.equal(secondRan, true);
  });

  it('observe after seal() throws InterceptorError with code sealed', () => {
    const registry = createInterceptorRegistry();
    const bus = new RegistrySignalBus(registry);

    registry.seal();

    assert.throws(
      () => bus.observe(event, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof InterceptorError);
        assert.equal(error.code, 'sealed');
        return true;
      },
    );
  });

  it('throws SignalError when the registry is missing', () => {
    assert.throws(
      () => new RegistrySignalBus(undefined as never),
      (error: unknown) => {
        assert.ok(error instanceof SignalError);
        assert.equal(error.code, 'unavailable');
        return true;
      },
    );
  });
});
