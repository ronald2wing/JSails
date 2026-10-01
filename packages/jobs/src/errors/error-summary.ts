/**
 * The {@link JobErrorSummary} of a failed attempt: what a transport stores and
 * a signal carries about the failure, and nothing that could hold a value.
 *
 * A thrown value goes through the kernel's `normalizeError`, and the summary
 * keeps only facts a value cannot ride in on:
 *
 * - the kind (an unknown kind from another copy of jsails reads `internal`),
 *   which decides retryability through `isRetryableKind`;
 * - the framework code, only when it has the `domain.code` shape;
 * - the class name, only a built-in error name or one that reads
 *   `<Name>Error` (the kernel's cause-chain rule: `error.name` is writable,
 *   and the rule leaves room for a class name, little for a token);
 * - the stack frames, and only when the stack starts exactly with the header
 *   V8 or Node writes for the error's current name and message: everything up
 *   to the first frame is that header, so a message holding a forged
 *   `    at …` line is skipped with it, and a stack whose header no longer
 *   matches (its message changed after it was formatted) is dropped whole.
 *
 * The message is kept only when the app opted in (`storeErrorMessages`), and
 * never the `cause` chain: a message is where a payload field, a key or a
 * connection string ends up. Every read of the thrown value is guarded, and
 * the producer as a whole is too: summarizing a failure never fails.
 */

import {
  isErrorKind,
  isRetryableKind,
  normalizeError,
  type ErrorKind,
  type JsailsError,
} from 'jsails/errors';

import type { JobErrorSummary } from '../contract/outcome.js';
import { JobsErrors, type JobsErrorCode } from './jobs-errors.js';

/** How a failure is summarized. */
export interface SummaryOptions {
  /** Keep the error's own message (capped); off by default. */
  readonly storeMessages: boolean;
}

/** A summary and whether the attempt it describes may be retried. */
export interface SummarizedError {
  readonly summary: JobErrorSummary;
  readonly retryable: boolean;
}

/** The longest framework code a summary keeps. */
export const MAX_SUMMARY_CODE_LENGTH = 128;
/** The longest class name a summary keeps (the `<Name>Error` rule allows 40). */
export const MAX_SUMMARY_NAME_LENGTH = 64;
/** The longest stored message. */
export const MAX_SUMMARY_MESSAGE_LENGTH = 1_000;
/** Frames kept from a stack. */
export const MAX_SUMMARY_FRAMES = 32;
/** The longest frame line kept; a longer one is cut. */
export const MAX_SUMMARY_FRAME_LENGTH = 500;
/** The longest stack a summary may carry: every frame at its longest. */
export const MAX_SUMMARY_STACK_LENGTH = 16_384;

const FRAMEWORK_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
const BUILTIN_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SuppressedError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
/** `<Name>Error`, at most 40 characters. */
const ERROR_CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,34}Error$/;
/** Node's own codes and errno names, which Node writes into a header as `Name [CODE]`. */
const HEADER_CODE = /^(?:ERR_[A-Z][A-Z0-9_]{1,60}|E[A-Z0-9]{2,30})$/;
const FRAME = /^\s+at /;
const SUMMARY_KEYS: ReadonlySet<string> = new Set(['code', 'kind', 'name', 'stack', 'message']);

const FALLBACK: SummarizedError = Object.freeze({
  summary: Object.freeze({ kind: 'internal', name: 'Error' }),
  retryable: true,
});

/** Read `key` of an arbitrary value; a getter that throws (or a revoked proxy) reads as absent. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // Explaining a failure must not fail: an unreadable field is no fact.
    return undefined;
  }
}

/** Whether `name` may be stored: a built-in error name or one that reads `<Name>Error`. */
export function isSummaryName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length <= MAX_SUMMARY_NAME_LENGTH &&
    (BUILTIN_ERROR_NAMES.has(name) || ERROR_CLASS_NAME.test(name))
  );
}

/** Whether `code` has the framework's `domain.code` shape. */
export function isSummaryCode(code: unknown): code is string {
  return (
    typeof code === 'string' && code.length <= MAX_SUMMARY_CODE_LENGTH && FRAMEWORK_CODE.test(code)
  );
}

/**
 * The headers a stack of `origin` may start with, given the name and message
 * read after the stack: `Error.prototype.toString` as V8 applies it, and
 * Node's `Name [CODE]: message`. Empty when name or message is not a string.
 */
function stackHeaders(origin: object, name: unknown, message: unknown): readonly string[] {
  const shownName = name === undefined ? 'Error' : name;
  const shownMessage = message === undefined ? '' : message;
  if (typeof shownName !== 'string' || typeof shownMessage !== 'string') return [];
  if (shownName === '') return [shownMessage];
  const headers = [shownMessage === '' ? shownName : `${shownName}: ${shownMessage}`];
  const code = read(origin, 'code');
  if (typeof code === 'string' && HEADER_CODE.test(code)) {
    headers.push(
      shownMessage === '' ? `${shownName} [${code}]` : `${shownName} [${code}]: ${shownMessage}`,
    );
  }
  return headers;
}

/** The frame lines of `stack` after an exact header, or `undefined` when no header matches. */
function framesOf(stack: string, headers: readonly string[]): string | undefined {
  let rest: string | undefined;
  for (const header of headers) {
    if (stack === header) {
      rest = '';
      break;
    }
    if (stack.startsWith(`${header}\n`)) {
      rest = stack.slice(header.length + 1);
      break;
    }
  }
  if (rest === undefined) return undefined;
  const frames: string[] = [];
  for (const line of rest.split('\n')) {
    if (frames.length === MAX_SUMMARY_FRAMES) break;
    if (FRAME.test(line)) frames.push(line.slice(0, MAX_SUMMARY_FRAME_LENGTH));
  }
  return frames.length === 0 ? undefined : frames.join('\n');
}

function capped(text: string): string {
  return text.slice(0, MAX_SUMMARY_MESSAGE_LENGTH);
}

function summarize(thrown: unknown, options: SummaryOptions): SummarizedError {
  const normalized: JsailsError = normalizeError(thrown);
  const rawKind: unknown = read(normalized, 'kind');
  const kind: ErrorKind = isErrorKind(rawKind) ? rawKind : 'internal';
  const rawCode = read(normalized, 'code');
  const origin = typeof thrown === 'object' && thrown !== null ? thrown : undefined;
  let name = 'Error';
  let stack: string | undefined;
  let message: string | undefined;
  if (origin !== undefined) {
    // The stack first: V8 formats it on first access from the name and
    // message of that moment, which the header check then reads again.
    const rawStack = read(origin, 'stack');
    const rawName = read(origin, 'name');
    const rawMessage = read(origin, 'message');
    if (isSummaryName(rawName)) name = rawName;
    if (typeof rawStack === 'string') {
      stack = framesOf(rawStack, stackHeaders(origin, rawName, rawMessage));
    }
    if (options.storeMessages && typeof rawMessage === 'string') message = capped(rawMessage);
  } else if (options.storeMessages && typeof thrown === 'string') {
    message = capped(thrown);
  }
  const summary: JobErrorSummary = Object.freeze({
    ...(isSummaryCode(rawCode) ? { code: rawCode } : {}),
    kind,
    name,
    ...(stack === undefined ? {} : { stack }),
    ...(message === undefined ? {} : { message }),
  });
  return Object.freeze({ summary, retryable: isRetryableKind(kind) });
}

/**
 * The value-free summary of `thrown` and whether its kind is retried. Never
 * throws.
 */
export function summarizeJobError(thrown: unknown, options: SummaryOptions): SummarizedError {
  try {
    return summarize(thrown, options);
  } catch {
    // A value built to break the summary (a proxy that throws on every
    // operation) still fails its attempt, as an unrecognized failure.
    return FALLBACK;
  }
}

/**
 * The summary of a failure the runtime names itself. It carries no stack:
 * the stack would point at the runtime, not at the job.
 */
export function runtimeSummary(code: JobsErrorCode): JobErrorSummary {
  return Object.freeze({
    code: `${JobsErrors.domain}.${code}`,
    kind: JobsErrors.codes[code].kind,
    name: 'JobsError',
  });
}

/**
 * Whether `value` is a well-formed summary: only the known fields, each
 * within its bounds. A transport stores what passes, so an adapter checks a
 * processor's summary with this before trusting it.
 */
export function isJobErrorSummary(value: unknown): value is JobErrorSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => SUMMARY_KEYS.has(key))) return false;
  if (!isErrorKind(record.kind) || !isSummaryName(record.name)) return false;
  if (record.code !== undefined && !isSummaryCode(record.code)) return false;
  if (
    record.stack !== undefined &&
    (typeof record.stack !== 'string' || record.stack.length > MAX_SUMMARY_STACK_LENGTH)
  ) {
    return false;
  }
  return (
    record.message === undefined ||
    (typeof record.message === 'string' && record.message.length <= MAX_SUMMARY_MESSAGE_LENGTH)
  );
}
