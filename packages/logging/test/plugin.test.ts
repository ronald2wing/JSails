/**
 * Logging plugin tests: service wiring through the extension runner, channel
 * and sink propagation, the definePlugin contract (value-free option
 * validation before any setup, an inert setup). No
 * connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnosticsPlugin } from '@jsails/diagnostics';
import { diagnosticsToken } from 'jsails/diagnostics';
import {
  createInterceptorRegistry,
  definePlugin as defineLegacyPlugin,
  runExtensions,
} from 'jsails/extensions';
import { checkOptionSchema, ConfigErrors, definePlugin, fn } from 'jsails/kernel';
import { RegistrySignalBus, signalsToken, type SignalBus } from 'jsails/signals';
import { testPlugin } from 'jsails/testing';
import { z } from 'jsails/zod';
import { memoryChannel } from '../src/channels.js';
import { logError, type LogChannel, type Logger, type LogRecord } from '../src/contract.js';
import { loggingPlugin, loggingToken, type LoggingPluginOptions } from '../src/plugin.js';

/** Resolve a logger from a plugin and return it together with a teardown for cleanup. */
async function pluginLogger(
  options?: LoggingPluginOptions,
): Promise<{ logger: Logger; close(): Promise<void> }> {
  const runtime = await runExtensions([loggingPlugin(options)], { rootDir: import.meta.dirname });
  const logger: Logger = runtime.services.get(loggingToken);
  return { logger, close: () => runtime.close() };
}

describe('loggingPlugin', () => {
  it('has name "logging" and a stable token', () => {
    assert.equal(loggingToken.name, 'logging');
    assert.equal(loggingPlugin().name, 'logging');
  });

  it('provides a Logger service under the token', async () => {
    const { logger, close } = await pluginLogger();
    try {
      assert.equal(typeof logger.debug, 'function');
      assert.equal(typeof logger.info, 'function');
      assert.equal(typeof logger.warn, 'function');
      assert.equal(typeof logger.error, 'function');
      assert.equal(typeof logger.child, 'function');
    } finally {
      await close();
    }
  });

  it('logger service is usable — info/warn/error do not throw', async () => {
    // The default logger writes to process.stdout/stderr via consoleChannel().
    // We only assert the calls do not throw; we do not assert output content.
    const { logger, close } = await pluginLogger();
    try {
      logger.info('plugin test info');
      logger.warn('plugin test warn');
      logger.error('plugin test error');
    } finally {
      await close();
    }
  });

  it('provided channels are used verbatim — memory channel receives records', async () => {
    const mem = memoryChannel({ minLevel: 'debug' });
    const { logger, close } = await pluginLogger({ channels: [mem] });

    try {
      logger.info('hello from plugin', { key: 'val' });

      const records: readonly LogRecord[] = mem.records();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.message, 'hello from plugin');
      assert.equal(records[0]!.level, 'info');
      assert.equal(records[0]!.context.key, 'val');
    } finally {
      await close();
    }
  });

  it('keeps a class-instance channel as the `this` of its write', async () => {
    class LineChannel implements LogChannel {
      readonly name = 'lines';
      readonly minLevel = 'debug';
      readonly #lines: string[] = [];
      write(record: LogRecord): void {
        this.#lines.push(record.message);
      }
      lines(): readonly string[] {
        return [...this.#lines];
      }
    }
    const channel = new LineChannel();
    const run = await testPlugin(loggingPlugin({ channels: [channel] }));
    try {
      run.services.get(loggingToken).error('hello');
      run.services.get(loggingToken).child({ requestId: 'r' }).info('child');
      assert.deepEqual(channel.lines(), ['hello', 'child']);
    } finally {
      await run.close();
    }
  });

  it('child loggers from the plugin service merge context correctly', async () => {
    const mem = memoryChannel({ minLevel: 'debug' });
    const { logger, close } = await pluginLogger({ channels: [mem] });

    try {
      const child = logger.child({ requestId: 'abc' });
      child.info('child log', { extra: 1 });

      const records = mem.records();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.context.requestId, 'abc');
      assert.equal(records[0]!.context.extra, 1);
    } finally {
      await close();
    }
  });

  it('injectable clock is passed through to records', async () => {
    const mem = memoryChannel();
    const { logger, close } = await pluginLogger({
      channels: [mem],
      clock: () => 42,
    });

    try {
      logger.info('timed');
      assert.equal(mem.records()[0]!.at, 42);
    } finally {
      await close();
    }
  });

  it('sets up inertly and provides only loggingToken', async () => {
    const mem = memoryChannel();
    const run = await testPlugin(loggingPlugin({ channels: [mem], clock: () => 7 }));
    try {
      assert.deepEqual(run.provided, [loggingToken]);
      run.services.get(loggingToken).info('inert');
      assert.equal(mem.records()[0]!.at, 7);
    } finally {
      await run.close();
    }
  });

  it('has an options schema of data, callbacks and tokens only', () => {
    assert.deepEqual(checkOptionSchema(loggingPlugin.definition.options!), []);
  });

  it('requires the services its options name', () => {
    assert.deepEqual(loggingPlugin().requires, []);
    assert.deepEqual(
      loggingPlugin({ diagnostics: diagnosticsToken, signals: signalsToken }).requires,
      [diagnosticsToken, signalsToken],
    );
  });
});

describe('invalid options', () => {
  const SECRET = 'zz-secret-input';
  const cases: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'a non-object', input: SECRET },
    { name: 'an unknown option', input: { [SECRET]: true } },
    { name: 'non-array channels', input: { channels: SECRET } },
    { name: 'a channel without write', input: { channels: [{ name: SECRET, minLevel: 'info' }] } },
    { name: 'an unknown level', input: { diagnosticsLevel: SECRET } },
    { name: 'a non-function clock', input: { clock: 123 } },
    { name: 'a recorder instance for diagnostics', input: { diagnostics: { record() {} } } },
    { name: 'a token of another family for signals', input: { signals: loggingToken } },
  ];
  for (const { name, input } of cases) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = loggingPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          assert.equal(`${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET), false);
          return true;
        },
      );
    });
  }
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([loggingPlugin()], { rootDir: import.meta.dirname });
    await runtime.close();
    await runtime.close();
  });
});

/** A plugin providing `bus` under `signalsToken`, as an application would. */
const signalBusPlugin = definePlugin({
  name: 'signal-bus',
  options: z.object({ bus: fn<() => SignalBus>() }).strict(),
  provides: [signalsToken],
  setup({ options, services }) {
    services.provide(signalsToken, options.bus());
  },
});

describe('loggingPlugin forwards sinks', () => {
  it('loggingPlugin({ diagnostics }) records into the diagnostics service', async () => {
    const runtime = await runExtensions(
      [
        diagnosticsPlugin(),
        loggingPlugin({ diagnostics: diagnosticsToken, diagnosticsLevel: 'info' }),
      ],
      { rootDir: import.meta.dirname },
    );
    const logger = runtime.services.get(loggingToken);

    try {
      logger.info('plugin info');
      logger.error('plugin error');

      const entries = runtime.services.get(diagnosticsToken).entries({ type: 'log' });
      assert.equal(entries.length, 2);

      // Verify value-free — no context leaked.
      for (const e of entries) {
        assert.ok(e.data !== undefined);
        const data = e.data;
        assert.equal('level' in data, true);
        assert.equal('message' in data, true);
        // Only the two expected keys.
        assert.equal(Object.keys(data).length, 2);
      }
    } finally {
      await runtime.close();
    }
  });

  it('loggingPlugin({ signals }) emits on the signal bus', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);

    let observed = false;
    registry.observe(logError, () => {
      observed = true;
    });

    const runtime = await runExtensions(
      [signalBusPlugin({ bus: () => signals }), loggingPlugin({ signals: signalsToken })],
      { rootDir: import.meta.dirname },
    );
    const logger = runtime.services.get(loggingToken);

    try {
      logger.error('plugin error');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observed, true);

      // Non-error levels do not emit.
      observed = false;
      logger.info('plugin info');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observed, false);
    } finally {
      await runtime.close();
    }
  });

  it('loggingPlugin({ signals }) uses a bus an app-owned legacy plugin declared after it provides', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);
    let observed = 0;
    registry.observe(logError, () => {
      observed += 1;
    });
    // `plugins.use` runs before an app's `extensions`, so the logging entry
    // always comes first; the app's plugin is the documented legacy shape.
    const appSignals = defineLegacyPlugin({
      name: 'app-signals',
      setup({ services }) {
        services.provide(signalsToken, signals);
      },
    });
    const runtime = await runExtensions([loggingPlugin({ signals: signalsToken }), appSignals], {
      rootDir: import.meta.dirname,
    });
    try {
      runtime.services.get(loggingToken).error('plugin error');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observed, 1);
    } finally {
      await runtime.close();
    }
  });

  it('loggingPlugin({ diagnostics, signals }) forwards both', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    const runtime = await runExtensions(
      [
        loggingPlugin({
          diagnostics: diagnosticsToken,
          diagnosticsLevel: 'info',
          signals: signalsToken,
        }),
        diagnosticsPlugin(),
        signalBusPlugin({ bus: () => signals }),
      ],
      { rootDir: import.meta.dirname },
    );
    const logger = runtime.services.get(loggingToken);

    try {
      logger.info('info');
      logger.error('error');

      await new Promise((resolve) => setImmediate(resolve));

      // Diagnostics recorded both.
      assert.equal(runtime.services.get(diagnosticsToken).entries({ type: 'log' }).length, 2);
      // Only error emitted.
      assert.equal(emitCount, 1);
    } finally {
      await runtime.close();
    }
  });
});
