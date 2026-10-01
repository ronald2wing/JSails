/**
 * Logger tests: RecordLogger construction, level-threshold filtering, child()
 * context merging, clock injection, context immutability, option validation,
 * inert construction, and the diagnostics and signals sinks (value-free
 * entries, error-only emission, failure isolation, sharing across children).
 *
 * All assertions that depend on record contents use an explicit memory channel
 * so the tests are deterministic and side-effect-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryDiagnosticsRecorder } from '@jsails/diagnostics';
import type { DiagnosticsRecorder } from 'jsails/diagnostics';
import { createInterceptorRegistry } from 'jsails/extensions';
import { RegistrySignalBus, type SignalBus } from 'jsails/signals';
import { memoryChannel } from '../src/channels.js';
import { logError, type Logger, type LogRecord } from '../src/contract.js';
import type { LogLevel } from '../src/levels.js';
import { RecordLogger } from '../src/logger.js';

function makeLogger(
  channels?: ReturnType<typeof memoryChannel>[],
  clock?: () => number,
): {
  logger: Logger;
  mem: ReturnType<typeof memoryChannel>;
} {
  const mem = channels?.[0] ?? memoryChannel();
  const logger = new RecordLogger({ channels: [mem, ...(channels?.slice(1) ?? [])], clock });
  return { logger, mem };
}

function lastRecord(mem: ReturnType<typeof memoryChannel>): LogRecord {
  const all = mem.records();
  assert.ok(all.length > 0, 'expected at least one record');
  return all[all.length - 1]!;
}

describe('RecordLogger', () => {
  describe('level-threshold filtering', () => {
    it('writes debug records when channel minLevel is debug', () => {
      const mem = memoryChannel({ minLevel: 'debug' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      assert.equal(mem.records().length, 4);
    });

    it('writes info and above when channel minLevel is info', () => {
      const mem = memoryChannel({ minLevel: 'info' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const all = mem.records();
      assert.equal(all.length, 3);
      const levels = all.map((r) => r.level);
      assert.deepEqual(levels, ['info', 'warn', 'error']);
    });

    it('writes only warn and error when channel minLevel is warn', () => {
      const mem = memoryChannel({ minLevel: 'warn' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const all = mem.records();
      assert.equal(all.length, 2);
      const levels = all.map((r) => r.level);
      assert.deepEqual(levels, ['warn', 'error']);
    });

    it('writes only error when channel minLevel is error', () => {
      const mem = memoryChannel({ minLevel: 'error' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const all = mem.records();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.level, 'error');
    });

    it('each channel filters independently by its own minLevel', () => {
      const memAll = memoryChannel({ minLevel: 'debug' });
      const memWarn = memoryChannel({ minLevel: 'warn' });

      const logger = new RecordLogger({ channels: [memAll, memWarn] });

      logger.debug('d');
      logger.info('i');
      logger.error('e');

      assert.equal(memAll.records().length, 3);
      assert.equal(memWarn.records().length, 1);
    });
  });

  describe('child() context merging', () => {
    it('bound context appears in every record', () => {
      const { logger, mem } = makeLogger();
      const child = logger.child({ userId: 42, traceId: 'abc' });

      child.info('first');
      child.warn('second');

      const all = mem.records();
      assert.equal(all.length, 2);
      for (const r of all) {
        assert.equal(r.context.userId, 42);
        assert.equal(r.context.traceId, 'abc');
      }
    });

    it('child key overrides parent on collision', () => {
      const { logger, mem } = makeLogger();
      const parent = logger.child({ env: 'prod', region: 'us-east' });
      const child = parent.child({ region: 'eu-west' });

      child.info('test');

      const rec = lastRecord(mem);
      assert.equal(rec.context.env, 'prod');
      // Child override wins.
      assert.equal(rec.context.region, 'eu-west');
    });

    it('nested child().child() merge order: parent -> child -> grandchild', () => {
      const { logger, mem } = makeLogger();
      const child = logger.child({ a: 1 });
      const grandchild = child.child({ b: 2, a: 99 });

      grandchild.info('test');

      const rec = lastRecord(mem);
      assert.equal(rec.context.a, 99); // grandchild overrides child
      assert.equal(rec.context.b, 2);
    });

    it('parent context is not mutated when creating a child', () => {
      const { logger, mem } = makeLogger();
      const parent = logger.child({ shared: 'original' });
      parent.child({ shared: 'override' });

      // Parent still writes with its own context.
      parent.info('after child creation');
      const rec = lastRecord(mem);
      assert.equal(rec.context.shared, 'original');
    });

    it('root logger context is empty', () => {
      const { logger, mem } = makeLogger();
      logger.info('bare');
      const rec = lastRecord(mem);
      assert.equal(Object.keys(rec.context).length, 0);
    });

    it('child context merges with per-call context (caller overrides child)', () => {
      const { logger, mem } = makeLogger();
      // Bound context is merged first, then caller-supplied context overrides.
      const child = logger.child({ repo: 'jsails', action: 'bound' });
      child.info('test', { action: 'called', extra: true });

      const rec = lastRecord(mem);
      assert.equal(rec.context.repo, 'jsails');
      assert.equal(rec.context.action, 'called');
      assert.equal(rec.context.extra, true);
    });
  });

  describe('clock injection', () => {
    it('record.at comes from the injected clock', () => {
      const { logger, mem } = makeLogger(undefined, () => 999);
      logger.info('x');
      assert.equal(lastRecord(mem).at, 999);
    });

    it('default clock is Date.now (produces a realistic timestamp)', () => {
      const { logger, mem } = makeLogger();
      const before = Date.now();
      logger.info('x');
      const after = Date.now();
      const rec = lastRecord(mem);
      assert.ok(rec.at >= before, `at ${rec.at} < before ${before}`);
      assert.ok(rec.at <= after, `at ${rec.at} > after ${after}`);
    });
  });

  describe('context immutability', () => {
    it('record.context is a frozen copy — mutating caller object does not change record', () => {
      const { logger, mem } = makeLogger();
      const ctx: Record<string, unknown> = { x: 1 };
      logger.info('msg', ctx);

      // Mutate caller's object after the call.
      ctx.x = 99;
      ctx.y = 2;

      const rec = lastRecord(mem);
      assert.equal(rec.context.x, 1); // original value preserved
      assert.equal(Object.keys(rec.context).length, 1); // no new keys leaked in
    });

    it('record.context is frozen', () => {
      const { logger, mem } = makeLogger();
      logger.info('msg', { x: 1 });

      const rec = lastRecord(mem);
      assert.throws(
        () => {
          (rec.context as Record<string, unknown>).x = 2;
        },
        { message: /frozen|read.only|immutable/i },
      );
    });

    it('per-call context = {} is not required', () => {
      const { logger, mem } = makeLogger();
      logger.info('no context');
      const rec = lastRecord(mem);
      assert.equal(Object.keys(rec.context).length, 0);
    });
  });

  describe('default options', () => {
    it('new RecordLogger() with no options does not throw', () => {
      const logger = new RecordLogger();
      assert.ok(logger);
      assert.equal(typeof logger.info, 'function');
      assert.equal(typeof logger.debug, 'function');
      assert.equal(typeof logger.warn, 'function');
      assert.equal(typeof logger.error, 'function');
      assert.equal(typeof logger.child, 'function');
    });

    it('default logger does not throw on log call', () => {
      const logger = new RecordLogger();
      // Debug defaults to the console channel whose minLevel is 'info', so a
      // debug call is a silent no-op. Info/warn/error write to stdout/stderr;
      // we only assert they do not throw.
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');
    });
  });

  describe('inert construction', () => {
    it('new RecordLogger performs no I/O at construction', () => {
      // Construction with no channels listed still creates consoleChannel()
      // which only touches process inside write(). We verify that merely
      // calling new RecordLogger() succeeds without side effects.
      const logger = new RecordLogger();
      assert.ok(logger);
    });

    it('construction is pure — same options produce independently usable loggers', () => {
      const mem1 = memoryChannel();
      const mem2 = memoryChannel();
      const logger1 = new RecordLogger({ channels: [mem1], clock: () => 1 });
      const logger2 = new RecordLogger({ channels: [mem2], clock: () => 2 });

      logger1.info('a');
      logger2.info('b');

      assert.equal(mem1.records().length, 1);
      assert.equal(mem2.records().length, 1);
      assert.equal(mem1.records()[0]!.at, 1);
      assert.equal(mem2.records()[0]!.at, 2);
    });
  });

  describe('channel isolation', () => {
    it('a throwing channel does not prevent writes to other channels', () => {
      const mem = memoryChannel();
      const throwingChannel = {
        name: 'thrower',
        minLevel: 'debug' as LogLevel,
        write(_record: LogRecord): void {
          throw new Error('channel-failure');
        },
      };

      const logger = new RecordLogger({ channels: [throwingChannel, mem] });

      // Must not throw.
      logger.info('hello');

      assert.equal(mem.records().length, 1);
    });

    it('a throwing channel does not propagate the error to caller', () => {
      const throwingChannel = {
        name: 'thrower',
        minLevel: 'debug' as LogLevel,
        write(_record: LogRecord): void {
          throw new Error('channel-failure');
        },
      };

      const logger = new RecordLogger({ channels: [throwingChannel] });

      // Must not throw.
      logger.info('hello');
      logger.error('still no throw');
    });
  });

  describe('option validation', () => {
    it('throws TypeError for non-array channels', () => {
      assert.throws(
        () => new RecordLogger({ channels: 'not-an-array' as never }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('throws TypeError for a channel that is not an object', () => {
      assert.throws(
        () => new RecordLogger({ channels: [null as never] }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('throws TypeError for a channel missing a name', () => {
      assert.throws(
        () =>
          new RecordLogger({
            channels: [{ minLevel: 'debug', write: () => {} } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('throws TypeError for a channel with an empty name', () => {
      assert.throws(
        () =>
          new RecordLogger({
            channels: [{ name: '', minLevel: 'debug', write: () => {} } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('throws TypeError for a channel missing write function', () => {
      assert.throws(
        () =>
          new RecordLogger({
            channels: [{ name: 'ch', minLevel: 'debug' } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('throws TypeError for a channel with invalid minLevel', () => {
      assert.throws(
        () =>
          new RecordLogger({
            channels: [{ name: 'ch', minLevel: 'fatal', write: () => {} } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('throws TypeError for a non-function clock', () => {
      assert.throws(
        () => new RecordLogger({ clock: 123 as never }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
    });

    it('value-free error messages: no caller values echoed', () => {
      assert.throws(
        () => new RecordLogger({ channels: [123 as never] }),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          // The message must not contain the raw value '123'.
          assert.ok(!err.message.includes('123'));
          return true;
        },
      );
    });
  });
});

/**
 * Build a logger with a memory channel and optional diagnostics / signals
 * sinks, returning the logger and the channel to read back from.
 */
function makeSinkLogger(options?: {
  readonly diagnostics?: DiagnosticsRecorder;
  readonly signals?: SignalBus;
}) {
  const mem = memoryChannel({ minLevel: 'debug' });
  const clock = (() => {
    let t = 0;
    return () => ++t;
  })();
  const logger = new RecordLogger({
    channels: [mem],
    clock,
    diagnostics: options?.diagnostics,
    signals: options?.signals,
  });
  return { logger, mem, clock };
}

describe('diagnostics sink', () => {
  it('calls diagnostics.record({ type: "log", data: { level, message } }) on every log call', () => {
    const diag = new InMemoryDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ diagnostics: diag });

    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    const entries = diag.entries({ type: 'log' });
    assert.equal(entries.length, 4);

    const levels = entries.map((e) => e.data?.level);
    assert.deepEqual(levels, ['debug', 'info', 'warn', 'error']);

    const messages = entries.map((e) => e.data?.message);
    assert.deepEqual(messages, ['debug msg', 'info msg', 'warn msg', 'error msg']);
  });

  it('diagnostics entry is value-free — no context payload leaked into data', () => {
    const diag = new InMemoryDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ diagnostics: diag });

    // Log with potentially secret context — diagnostics must not leak it.
    logger.info('auth event', { token: 'secret-token', userId: 42 });

    const entries = diag.entries({ type: 'log' });
    assert.equal(entries.length, 1);

    const entry = entries[0]!;
    assert.equal(entry.type, 'log');
    assert.ok(entry.data !== undefined);

    // TypeScript narrows data after the assertion above.
    const data = entry.data;

    // data must contain only level and message, never context keys.
    assert.equal(data.level, 'info');
    assert.equal(data.message, 'auth event');
    assert.equal('token' in data, false, 'diagnostics data must not leak secret context');
    assert.equal('userId' in data, false, 'diagnostics data must not leak context keys');
    // Only the two expected keys should be present.
    assert.deepEqual(Object.keys(data).sort(), ['level', 'message']);
  });

  it('does not throw when diagnostics is not wired', () => {
    const { logger } = makeSinkLogger();

    // Must not throw — undefined diagnostics is handled gracefully.
    logger.info('no diag');
    logger.error('no diag error');
  });
});

describe('signals sink', () => {
  it('emits logError for every error-level record with the full LogRecord', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    const emitted: LogRecord[] = [];
    registry.observe(logError, (payload) => {
      emitted.push(payload);
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('first error', { code: 500, path: '/api' });
    logger.error('second error');

    // emit is async — wait for microtasks to flush.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 2);

    const [r0, r1] = emitted;
    assert.equal(r0!.level, 'error');
    assert.equal(r0!.message, 'first error');
    assert.equal(r0!.context.code, 500);
    assert.equal(r0!.context.path, '/api');

    assert.equal(r1!.level, 'error');
    assert.equal(r1!.message, 'second error');
  });

  it('does NOT emit logError for non-error levels', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitCount, 0);
  });

  it('does not throw when signals is not wired', () => {
    const { logger } = makeSinkLogger();

    logger.error('error without signals');
  });

  it('a throwing signals observer does not propagate to the caller', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    let secondObserved = false;
    registry.observe(logError, () => {
      throw new Error('observer-failure');
    });
    registry.observe(logError, () => {
      secondObserved = true;
    });

    // Must not throw despite the throwing observer.
    logger.error('error with throwing observer');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondObserved, true);
  });
});

describe('sink failure isolation', () => {
  it('a throwing diagnostics.record does not propagate to the caller', () => {
    const throwingDiagnostics: DiagnosticsRecorder = {
      record(): void {
        throw new Error('diag-failure');
      },
      entries: () => [],
      clear: () => {},
      stats: () => ({ total: 0, byType: {}, withDuration: 0 }),
      wrapAsync: async (_type, fn) => fn(),
      pause: () => {},
      resume: () => {},
      isPaused: () => false,
      prune: () => 0,
    };

    const mem = memoryChannel({ minLevel: 'debug' });
    const logger = new RecordLogger({
      channels: [mem],
      diagnostics: throwingDiagnostics,
    });

    // Must not throw — log call returns normally.
    logger.info('still works');

    // Channel still received the record.
    assert.equal(mem.records().length, 1);
    assert.equal(mem.records()[0]!.message, 'still works');
  });

  it('a thrown signal in the emit call itself (not an observer) does not propagate', async () => {
    // SignalBus.emit already isolates observer errors, but a caller-supplied
    // bus could throw on the emit call itself (e.g. a mis-wired mock).
    // The logger must guard that case too.
    const throwingSignals: SignalBus = {
      observe: () => {},
      emit: async () => {
        throw new Error('bus-failure');
      },
    };

    const mem = memoryChannel({ minLevel: 'debug' });
    const logger = new RecordLogger({
      channels: [mem],
      signals: throwingSignals,
    });

    // Must not throw.
    logger.error('error with throwing bus');

    // Channel still received the record — the sink failure is isolated.
    assert.equal(mem.records().length, 1);
    assert.equal(mem.records()[0]!.message, 'error with throwing bus');
  });
});

describe('child loggers share sinks', () => {
  it('a child logger error still emits logError', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    let emitted = false;
    registry.observe(logError, () => {
      emitted = true;
    });

    const child = logger.child({ requestId: 'abc' });
    child.error('child error');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted, true);
  });

  it('a child logger still records into the same diagnostics', () => {
    const diag = new InMemoryDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ diagnostics: diag });

    const child = logger.child({ component: 'api' });
    child.info('child info');

    const entries = diag.entries({ type: 'log' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.data!.level, 'info');
    assert.equal(entries[0]!.data!.message, 'child info');
  });

  it('nested child loggers all share the same sinks', async () => {
    const registry = createInterceptorRegistry();
    const signals = new RegistrySignalBus(registry);
    const diag = new InMemoryDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ signals, diagnostics: diag });

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    const child = logger.child({ a: 1 });
    const grandchild = child.child({ b: 2 });
    grandchild.error('grandchild error');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitCount, 1);
    assert.equal(diag.entries({ type: 'log' }).length, 1);
  });
});
