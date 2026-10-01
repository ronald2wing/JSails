/**
 * Audit regression tests (`jsails/testing`).
 *
 * {@link auditCase} names an ordinary `node:test` test after a stable audit id
 * (`live/publish-chain`), so a finding keeps one test title from the day its
 * failing test is written to the day its fix lands:
 *
 * ```ts
 * test(...auditCase('live/resume-ahead-of-head', 'a resume past the head snapshots'), async () => {
 *   // assert the correct behaviour
 * });
 * ```
 *
 * The test asserts the correct behaviour; it is never inverted, skipped or
 * marked todo. Whether it may fail today is decided by the expected-failure
 * ledgers (`scripts/expected-failures/*.json`), which name the test by its full
 * title and the failure it shows, and which the repo's test runner reconciles
 * on every run: a listed test that passes, or an unlisted one that fails, fails
 * the run.
 *
 * `auditCase` returns the arguments for `test` instead of calling it, because
 * node:test records the file of a test from the frame that calls `test()`. A
 * wrapper that called it would attribute every audit test to this module, and
 * no ledger entry could name its file.
 *
 * Audit tests often probe a hang (a socket that never answers, an upload that
 * never ends), so each gets a bounded default timeout instead of the runner's
 * five minutes. A probe that should observe "did not finish in time" uses
 * {@link settlesWithin}, which fails in the test body, not as a timeout.
 */

import { JsailsError } from '../errors/jsails-error.js';

/**
 * An audit id: `<area>/<finding>`, both kebab-case (`live/resume-ahead-of-head`).
 * The area is the package or subsystem, so ids sort by where the fix lands.
 */
export const AUDIT_ID_PATTERN: RegExp = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The timeout {@link auditCase} gives a test unless the caller sets one. */
export const DEFAULT_AUDIT_TIMEOUT_MS = 20_000;

/** Options for {@link auditCase}: the `node:test` options it sets. */
export interface AuditCaseOptions {
  /** Defaults to {@link DEFAULT_AUDIT_TIMEOUT_MS}. */
  readonly timeout?: number;
}

/** The `node:test` options {@link auditCase} returns. */
export interface AuditTestOptions {
  readonly timeout: number;
}

/** Stable codes carried by {@link AuditTestError}. */
export type AuditTestErrorCode = 'invalid_id' | 'invalid_name' | 'duplicate_id';

/** A misdeclared audit test: a malformed id or name, or one id used twice in a file. */
export class AuditTestError extends JsailsError {
  constructor(
    readonly code: AuditTestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const registered = new Set<string>();

/** The test title for `id` and `name`: `<id>: <name>`, the name a ledger entry uses. */
export function auditTitle(id: string, name: string): string {
  if (!AUDIT_ID_PATTERN.test(id)) {
    throw new AuditTestError('invalid_id', 'an audit id is <area>/<finding>, both kebab-case');
  }
  if (name.trim() === '' || name !== name.trim()) {
    throw new AuditTestError('invalid_name', 'an audit test name is non-empty and trimmed');
  }
  return `${id}: ${name}`;
}

/**
 * The `test()` title and options for audit finding `id`: spread them into
 * `test(...)`. `name` states the correct behaviour ("a failing append does not
 * stop later changes"). Ids are unique per test file; a second use throws, so
 * two tests can never answer for one finding.
 */
export function auditCase(
  id: string,
  name: string,
  options: AuditCaseOptions = {},
): [title: string, options: AuditTestOptions] {
  const title = auditTitle(id, name);
  const timeout = options.timeout ?? DEFAULT_AUDIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError('an audit test timeout is a positive integer of milliseconds');
  }
  if (registered.has(id)) {
    throw new AuditTestError('duplicate_id', 'an audit id is used once per test file');
  }
  registered.add(id);
  return [title, { timeout }];
}

/** Stable codes carried by {@link SettleTimeoutError}. */
export type SettleTimeoutErrorCode = 'not_settled';

/**
 * Thrown by {@link settlesWithin} when the promise is still pending at the
 * deadline. It reports a failure of the code under test, not of the test run,
 * so it is a test-body failure (`testCodeFailure`) that a ledger entry can name
 * by class (`"name": "SettleTimeoutError"`).
 */
export class SettleTimeoutError extends JsailsError {
  readonly code: SettleTimeoutErrorCode = 'not_settled';

  constructor(
    readonly timeoutMs: number,
    label: string,
  ) {
    super(`${label} did not settle within ${timeoutMs}ms`);
  }
}

/**
 * Await `promise`, failing with {@link SettleTimeoutError} when it has neither
 * resolved nor rejected after `timeoutMs`. The promise's own rejection passes
 * through unchanged. The timer is cleared either way, so a passing check leaves
 * nothing behind; a still-pending promise is the caller's to clean up (close the
 * client or server it belongs to).
 */
export async function settlesWithin<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a finite, non-negative number');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SettleTimeoutError(timeoutMs, label)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
