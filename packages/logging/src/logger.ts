/**
 * {@link RecordLogger}, the concrete {@link Logger}: every call builds a frozen
 * {@link LogRecord} and writes it to every channel whose `minLevel` is at or
 * below the record's level.
 *
 * Construction is inert — no I/O, no `process` access, no timers fire until a
 * log method is called. Channels, clock, diagnostics, and signals are injected
 * so the logger is fully testable without process-level mocking.
 *
 * When a {@link DiagnosticsRecorder} is wired, every log call records a
 * value-free `{ type: 'log', data: { level, message } }` entry — context is
 * excluded because it is caller-owned and may carry secrets. When a
 * {@link SignalBus} is wired, `error`-level records emit the shared
 * {@link logError} event. Both sinks are fire-and-forget by contract — a
 * throwing sink never propagates to the caller.
 */

import type { DiagnosticsRecorder } from 'jsails/diagnostics';
import { isRecord } from 'jsails/plugin-sdk';
import type { SignalBus } from 'jsails/signals';
import { consoleChannel } from './channels.js';
import { logError, type LogChannel, type Logger, type LogRecord } from './contract.js';
import { assertLogLevel, meetsThreshold, type LogLevel } from './levels.js';

/** Options for {@link RecordLogger} (and, unchanged, for the logging plugin). */
export interface LoggerOptions {
  /**
   * Channels to write to on every log call. Each channel filters records
   * independently by its own `minLevel`. Default: `[consoleChannel()]`.
   */
  readonly channels?: readonly LogChannel[];
  /**
   * Clock returning milliseconds since epoch. Every record carries the
   * timestamp from this clock so formatters never fall back to `Date.now()`.
   * Default: `Date.now`.
   */
  readonly clock?: () => number;
  /**
   * Optional diagnostics recorder. When wired, every log call records a
   * value-free `{ type: 'log', data: { level, message } }` entry.
   */
  readonly diagnostics?: DiagnosticsRecorder;
  /**
   * Optional signal bus. When wired, `error`-level records emit the shared
   * {@link logError} event with the full {@link LogRecord} as payload.
   */
  readonly signals?: SignalBus;
}

/** Assert one configured channel has the {@link LogChannel} surface. */
function assertChannel(channel: unknown, index: number): asserts channel is LogChannel {
  if (!isRecord(channel)) {
    throw new TypeError(`channels[${index}] must be an object`);
  }
  if (typeof channel.name !== 'string' || channel.name === '') {
    throw new TypeError(`channels[${index}].name must be a non-empty string`);
  }
  assertLogLevel(channel.minLevel, `channels[${index}].minLevel`);
  if (typeof channel.write !== 'function') {
    throw new TypeError(`channels[${index}].write must be a function`);
  }
}

function assertOptions(options: LoggerOptions): void {
  if (options.channels !== undefined) {
    if (!Array.isArray(options.channels)) {
      throw new TypeError('channels must be an array');
    }
    options.channels.forEach(assertChannel);
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock must be a function');
  }
}

/**
 * Merge parent and child context objects (parent first) into a single frozen
 * copy. The child's keys override the parent's on collision. Only own
 * enumerable keys are read.
 */
function mergeContext(
  parent: Readonly<Record<string, unknown>>,
  child: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...parent, ...child });
}

/**
 * With no options, the logger writes to a single `consoleChannel()` (which
 * resolves `process.stdout.write` inside `write()` — no process access at
 * construction time), uses `Date.now` as its clock, and has no diagnostics or
 * signals sink wired.
 */
export class RecordLogger implements Logger {
  readonly #channels: readonly LogChannel[];
  readonly #clock: () => number;
  readonly #diagnostics: DiagnosticsRecorder | undefined;
  readonly #signals: SignalBus | undefined;
  readonly #boundContext: Readonly<Record<string, unknown>>;

  constructor(options: LoggerOptions = {}, boundContext: Readonly<Record<string, unknown>> = {}) {
    assertOptions(options);
    this.#channels = options.channels ?? [consoleChannel()];
    this.#clock = options.clock ?? Date.now;
    this.#diagnostics = options.diagnostics;
    this.#signals = options.signals;
    this.#boundContext = Object.freeze({ ...boundContext });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.#write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.#write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.#write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.#write('error', message, context);
  }

  child(context: Record<string, unknown>): Logger {
    // Children share the same sinks — a child's error still emits logError
    // and records into the same diagnostics buffer.
    return new RecordLogger(
      {
        channels: this.#channels,
        clock: this.#clock,
        diagnostics: this.#diagnostics,
        signals: this.#signals,
      },
      mergeContext(this.#boundContext, context),
    );
  }

  /**
   * Build a frozen {@link LogRecord}, write it to every channel whose
   * `minLevel` is at or below `level`, then notify the optional diagnostics
   * and signals sinks. Channel writes and sink calls are isolated — a throwing
   * channel or sink never prevents the record from reaching other destinations.
   */
  #write(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
    const at = this.#clock();
    const merged =
      context === undefined || Object.keys(context).length === 0
        ? this.#boundContext
        : mergeContext(this.#boundContext, context);
    const record: LogRecord = Object.freeze({ level, message, context: merged, at });

    for (const channel of this.#channels) {
      if (!meetsThreshold(level, channel.minLevel)) {
        continue;
      }
      try {
        channel.write(record);
      } catch {
        // A channel write failure must never propagate: log calls are
        // fire-and-forget by contract.
      }
    }

    if (this.#diagnostics !== undefined) {
      try {
        // Context is excluded: it is caller-owned and may carry secrets, while
        // diagnostics entries stay value-free by contract.
        this.#diagnostics.record({ type: 'log', data: { level, message } });
      } catch {
        // A diagnostics failure must never propagate to the caller.
      }
    }

    if (this.#signals !== undefined && level === 'error') {
      try {
        // `SignalBus.emit` isolates observer errors and never rejects; the
        // `.catch` guards a mis-wired bus whose `emit` rejects anyway.
        this.#signals.emit(logError, record).catch(() => {
          // A rejecting bus must not become an unhandled rejection.
        });
      } catch {
        // A bus whose `emit` throws synchronously is isolated the same way.
      }
    }
  }
}
