/**
 * Logging plugin tests: service wiring through the extension runner, channel
 * and sink propagation, option validation, and inert construction. No
 * connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryDiagnosticsRecorder } from '@jsails/diagnostics';
import { createInterceptorRegistry, runExtensions } from 'jsails/extensions';
import { RegistrySignalBus } from 'jsails/signals';
import { memoryChannel } from '../src/channels.js';
import { logError, type Logger, type LogRecord } from '../src/contract.js';
import { loggingPlugin, loggingToken, type LoggingPluginOptions } from '../src/plugin.js';

/** Resolve a logger from a plugin and return it together with a teardown for cleanup. */
async function pluginLogger(
  options?: LoggingPluginOptions,
): Promise<{ logger: Logger; close(): Promise<void> }> {
  const runtime = await runExtensions([loggingPlugin(options)]);
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

  it('construction is inert — loggingPlugin() performs no I/O', () => {
    const plugin = loggingPlugin();
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');

    // loggingPlugin() with no channels still creates consoleChannel() internally
    // during setup, but consoleChannel() only touches process inside write().
    // The plugin object itself is just a plain descriptor — no side effects.
    const pluginWithOpts = loggingPlugin({
      channels: [memoryChannel()],
      clock: () => 0,
    });
    assert.equal(pluginWithOpts.name, 'logging');
  });
});

describe('option validation', () => {
  it('throws TypeError for non-array channels (validated by RecordLogger)', async () => {
    await assert.rejects(
      async () => {
        const runtime = await runExtensions([loggingPlugin({ channels: 'nope' as never })]);
        // cleanup should still run
        await runtime.close();
      },
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        // The message should not echo the value 'nope'.
        assert.ok(!err.message.includes('nope'));
        return true;
      },
    );
  });

  it('throws TypeError for a non-function clock', async () => {
    await assert.rejects(
      async () => {
        const runtime = await runExtensions([loggingPlugin({ clock: 123 as never })]);
        await runtime.close();
      },
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        return true;
      },
    );
  });
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([loggingPlugin()]);
    await runtime.close();
    await runtime.close();
  });
});

describe('loggingPlugin forwards sinks', () => {
  it('loggingPlugin({ diagnostics }) wires the recorder', async () => {
    const diag = new InMemoryDiagnosticsRecorder();
    const runtime = await runExtensions([loggingPlugin({ diagnostics: diag })]);
    const logger = runtime.services.get(loggingToken);

    try {
      logger.info('plugin info');
      logger.error('plugin error');

      const entries = diag.entries({ type: 'log' });
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

  it('loggingPlugin({ signals }) wires the signal bus', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);

    let observed = false;
    registry.observe(logError, () => {
      observed = true;
    });

    const runtime = await runExtensions([loggingPlugin({ signals })]);
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

  it('loggingPlugin({ diagnostics, signals }) forwards both', async () => {
    const diag = new InMemoryDiagnosticsRecorder();
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    const runtime = await runExtensions([loggingPlugin({ diagnostics: diag, signals })]);
    const logger = runtime.services.get(loggingToken);

    try {
      logger.info('info');
      logger.error('error');

      await new Promise((resolve) => setImmediate(resolve));

      // Diagnostics recorded both.
      assert.equal(diag.entries({ type: 'log' }).length, 2);
      // Only error emitted.
      assert.equal(emitCount, 1);
    } finally {
      await runtime.close();
    }
  });
});
