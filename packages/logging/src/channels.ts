/**
 * Built-in log channels: console, in-memory buffer, and null (discard).
 *
 * Channels are the only place where side effects happen. The console channel
 * resolves `process.stdout`/`process.stderr` inside `write()` so that
 * importing this module in a non-Node bundler is safe.
 */

import type { LogChannel, LogFormatter, LogRecord } from './contract.js';
import { lineFormatter } from './formatters.js';
import { assertLogLevel, meetsThreshold, type LogLevel } from './levels.js';

/** Options for {@link consoleChannel}. */
export interface ConsoleChannelOptions {
  /** Minimum severity level; records below this are ignored. Default `'info'`. */
  readonly minLevel?: LogLevel | undefined;
  /** Formatter applied to every record before writing. Default {@link lineFormatter}. */
  readonly formatter?: LogFormatter | undefined;
  /** Writer for `debug`/`info` lines. Defaults to `process.stdout.write`. */
  readonly stdout?: ((line: string) => void) | undefined;
  /** Writer for `warn`/`error` lines. Defaults to `process.stderr.write`. */
  readonly stderr?: ((line: string) => void) | undefined;
}

/**
 * A channel that writes formatted lines to stdout (debug/info) and stderr
 * (warn/error). The `process` globals are resolved inside `write()` so
 * importing this module is safe in non-Node environments.
 */
export function consoleChannel(options?: ConsoleChannelOptions): LogChannel {
  const minLevel = options?.minLevel ?? 'info';
  assertLogLevel(minLevel, 'consoleChannel.minLevel');

  const formatter = options?.formatter ?? lineFormatter();
  if (typeof formatter.format !== 'function') {
    throw new TypeError('consoleChannel.formatter must have a format function');
  }

  const stdout = options?.stdout;
  const stderr = options?.stderr;
  if (stdout !== undefined && typeof stdout !== 'function') {
    throw new TypeError('consoleChannel.stdout must be a function');
  }
  if (stderr !== undefined && typeof stderr !== 'function') {
    throw new TypeError('consoleChannel.stderr must be a function');
  }

  return {
    name: 'console',
    minLevel,
    write(record: LogRecord): void {
      if (!meetsThreshold(record.level, minLevel)) {
        return;
      }
      const line = formatter.format(record) + '\n';
      if (record.level === 'warn' || record.level === 'error') {
        (stderr ?? writeStderr)(line);
      } else {
        (stdout ?? writeStdout)(line);
      }
    },
  };
}

function writeStdout(line: string): void {
  process.stdout.write(line);
}

function writeStderr(line: string): void {
  process.stderr.write(line);
}

/** Options for {@link memoryChannel}. */
export interface MemoryChannelOptions {
  /** Minimum severity level; records below this are ignored. Default `'debug'`. */
  readonly minLevel?: LogLevel | undefined;
}

/**
 * A channel that accumulates records in an internal buffer. Each `write`
 * pushes the raw {@link LogRecord} (not a formatted string) onto the buffer;
 * `records` reads a frozen snapshot and `clear` empties it.
 */
export interface MemoryChannel extends LogChannel {
  /** A frozen snapshot of every record currently in the buffer. */
  records(): readonly LogRecord[];
  /** Empty the buffer. */
  clear(): void;
}

/** A channel that keeps every record at or above `minLevel` in memory, for tests. */
export function memoryChannel(options?: MemoryChannelOptions): MemoryChannel {
  const minLevel = options?.minLevel ?? 'debug';
  assertLogLevel(minLevel, 'memoryChannel.minLevel');

  const buffer: LogRecord[] = [];

  return {
    name: 'memory',
    minLevel,
    write(record: LogRecord): void {
      if (meetsThreshold(record.level, minLevel)) {
        buffer.push(record);
      }
    },
    records(): readonly LogRecord[] {
      return Object.freeze([...buffer]);
    },
    clear(): void {
      buffer.length = 0;
    },
  };
}

/**
 * A channel that discards every record. Its `minLevel` is `error` so the
 * logger skips the write for everything below it; the write itself is a no-op.
 */
export function nullChannel(): LogChannel {
  return {
    name: 'null',
    minLevel: 'error',
    write(): void {
      // Discard by contract.
    },
  };
}
