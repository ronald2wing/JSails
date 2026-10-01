/**
 * The logging contract: the immutable {@link LogRecord}, the pluggable
 * {@link LogFormatter} and {@link LogChannel} seams, the application-facing
 * {@link Logger}, and the {@link logError} signal token.
 *
 * Nothing here performs I/O. The token is defined once because event tokens
 * are identity-based: two callers that separately call
 * `defineEvent('logging.error')` produce distinct tokens that never match, so
 * observers must import this one.
 */

import { defineEvent, type EventToken } from 'jsails/extensions';
import type { LogLevel } from './levels.js';

/**
 * An immutable structured log record produced by a logger and consumed by
 * every channel and formatter. `at` is the milliseconds-since-epoch timestamp
 * from the logger's injected clock — it is always present so formatters never
 * fall back to `Date.now()`.
 */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly at: number;
}

/**
 * Formats a {@link LogRecord} into a single output string. A formatter must
 * never throw — a failing formatter would break every log write.
 */
export interface LogFormatter {
  format(record: LogRecord): string;
}

/**
 * A destination for log records, gated by a minimum severity level. Channels
 * are the only point where side effects happen (console, memory buffer, file,
 * network) — everything upstream is pure composition.
 */
export interface LogChannel {
  readonly name: string;
  readonly minLevel: LogLevel;
  write(record: LogRecord): void;
}

/**
 * The application-facing logging interface. Every method is synchronous and
 * never throws: a write to a channel that fails must not propagate to the
 * caller. `child` returns a new logger that merges the given context into
 * every record it writes.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

/** Emitted for every `error`-level record when a signal bus is wired. */
export const logError: EventToken<LogRecord> = defineEvent<LogRecord>('logging.error');
