/**
 * Tests for the `signals` plugin: it provides the bus under `signalsToken`, and
 * an emit through that bus reaches observers registered by other plugins on
 * the shared interceptor registry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineEvent, definePlugin, runExtensions } from 'jsails/extensions';
import { signalsToken } from 'jsails/signals';
import { signalsPlugin } from '../src/index.js';

describe('signalsPlugin', () => {
  const event = defineEvent<{ n: number }>('test-event');

  it('fires observers from another plugin on the shared registry', async () => {
    let observerRan = false;

    const observerPlugin = definePlugin({
      name: 'observer',
      setup({ observe }) {
        observe(event, () => {
          observerRan = true;
        });
      },
    });

    const runtime = await runExtensions([signalsPlugin(), observerPlugin]);

    const bus = runtime.services.get(signalsToken);
    const errors = await bus.emit(event, { n: 42 });
    assert.equal(errors.length, 0);
    assert.equal(observerRan, true);

    await runtime.close();
  });

  it('provides the bus under signalsToken', async () => {
    const runtime = await runExtensions([signalsPlugin()]);

    assert.equal(runtime.services.has(signalsToken), true);
    const bus = runtime.services.get(signalsToken);
    assert.equal(typeof bus.observe, 'function');
    assert.equal(typeof bus.emit, 'function');

    await runtime.close();
  });
});
