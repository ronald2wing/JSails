/**
 * The log level vocabulary: the four ordered severities, their ranking, and
 * the one validation and threshold check every channel and the logger share.
 */

/** Severity level for a log record, strictly ordered from least to most severe. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Rank of each level; a record passes a channel when its rank is at or above `minLevel`. */
export const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
});

/**
 * Assert that an option value is a {@link LogLevel}. `label` names the option
 * (e.g. `consoleChannel.minLevel`) so the `TypeError` says which option is
 * wrong without echoing the value.
 */
export function assertLogLevel(value: unknown, label: string): asserts value is LogLevel {
  if (typeof value !== 'string' || !Object.hasOwn(LEVEL_ORDER, value)) {
    throw new TypeError(`${label} must be one of debug, info, warn, error`);
  }
}

/** Whether a record at `level` passes a channel whose threshold is `minLevel`. */
export function meetsThreshold(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}
