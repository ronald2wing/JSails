/**
 * Shared logging test fixtures: a base record and a way to vary it.
 */

import type { LogRecord } from '../src/contract.js';

const BASE: LogRecord = {
  level: 'info',
  message: 'hello',
  context: {},
  at: 1700000000000,
};

/** A record with the base values, overridden by `overrides`. */
export function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return { ...BASE, ...overrides };
}
