/**
 * `normalizeError`: the one function every boundary (HTTP response, CLI exit,
 * job outcome, log line) runs a thrown value through, so each boundary deals
 * with a framework error and nothing else.
 *
 * A framework error passes through unchanged. Anything else is offered to the
 * registered translators, newest first, and then to the built-in ones:
 *
 * - a Zod error becomes the client-audience `request.invalid`, its issues
 *   reduced to path, code and message;
 * - an `AbortError` (a client disconnect, a cancelled command) becomes
 *   `errors.aborted`, a non-error outcome boundaries do not log;
 * - a `TimeoutError` (an `AbortSignal.timeout` firing) becomes `errors.timeout`;
 * - a driver unique-constraint violation becomes the operator-audience
 *   `errors.unique_violation`; a resource that wants its caller to see the
 *   conflict translates it to `conflict(reason)` itself.
 *
 * Everything else becomes `errors.internal` with the original as its cause.
 * Recognition is structural (an error's `name` and fields), so this module
 * imports neither Zod nor a database driver and stays browser-safe.
 */

import { invalid, type ErrorIssue } from './kernel.js';
import { isJsailsError, type JsailsError } from './jsails-error.js';
import { KernelErrors } from './registry.js';

/**
 * Turns a foreign thrown value into a framework error, or declines with `undefined`.
 *
 * @public
 */
export type ErrorTranslator = (error: unknown) => JsailsError | undefined;

const TRANSLATORS_KEY = Symbol.for('jsails.errors.translators');

function translators(): ErrorTranslator[] {
  const holder = globalThis as { [TRANSLATORS_KEY]?: ErrorTranslator[] };
  holder[TRANSLATORS_KEY] ??= [];
  return holder[TRANSLATORS_KEY];
}

/**
 * Register a translator, consulted before the built-in ones and before every
 * translator registered earlier. Returns the function that removes it.
 *
 * @public
 */
export function registerErrorTranslator(translator: ErrorTranslator): () => void {
  translators().unshift(translator);
  return () => {
    const list = translators();
    const index = list.indexOf(translator);
    if (index !== -1) list.splice(index, 1);
  };
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

const ISSUE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function zodIssues(error: unknown): ErrorIssue[] | undefined {
  if (errorName(error) !== 'ZodError') return undefined;
  const raw = (error as { readonly issues?: unknown }).issues;
  if (!Array.isArray(raw)) return undefined;
  const issues: ErrorIssue[] = [];
  for (const issue of raw as unknown[]) {
    if (typeof issue !== 'object' || issue === null) return undefined;
    const { path, code, message } = issue as Record<string, unknown>;
    const keys = Array.isArray(path)
      ? (path as unknown[]).filter(
          (key): key is string | number => typeof key === 'string' || typeof key === 'number',
        )
      : [];
    issues.push({
      path: keys,
      code: typeof code === 'string' && ISSUE_CODE.test(code) ? code : 'invalid',
      ...(typeof message === 'string' ? { message } : {}),
    });
  }
  return issues;
}

interface DriverFields {
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly message?: unknown;
}

/**
 * SQLite (sql.js) reports `UNIQUE constraint failed: …` with no code, and its
 * extended code is 2067; MariaDB reports `ER_DUP_ENTRY`/`ER_DUP_KEY` (errno
 * 1062); PostgreSQL reports SQLSTATE `23505`. TypeORM wraps each in a
 * `QueryFailedError` whose `driverError` holds them. Only those fields are read,
 * never the duplicated value.
 */
function isUniqueViolation(error: unknown): boolean {
  if (errorName(error) !== 'QueryFailedError') return false;
  const driver = (error as { readonly driverError?: unknown }).driverError;
  if (typeof driver !== 'object' || driver === null) return false;
  const { code, errno, message } = driver as DriverFields;
  return (
    (typeof message === 'string' && message.includes('UNIQUE constraint failed')) ||
    code === 'ER_DUP_ENTRY' ||
    code === 'ER_DUP_KEY' ||
    code === '23505' ||
    errno === 1062 ||
    errno === 2067
  );
}

function builtIn(error: unknown): JsailsError | undefined {
  const issues = zodIssues(error);
  if (issues !== undefined) return invalid(issues);
  const name = errorName(error);
  if (name === 'AbortError') return new KernelErrors.Error('aborted', {}, { cause: error });
  if (name === 'TimeoutError') return new KernelErrors.Error('timeout', {}, { cause: error });
  if (isUniqueViolation(error)) {
    return new KernelErrors.Error('unique_violation', {}, { cause: error });
  }
  return undefined;
}

/**
 * The framework error for any thrown value. Never throws: a translator that
 * throws is skipped, and a value nothing recognizes becomes `errors.internal`
 * with the value as its cause.
 *
 * @public
 */
export function normalizeError(error: unknown): JsailsError {
  if (isJsailsError(error)) return error;
  for (const translate of [...translators(), builtIn]) {
    let translated: JsailsError | undefined;
    try {
      translated = translate(error);
    } catch {
      // A broken translator must not turn a boundary into a second failure;
      // the next translator, or the internal fallback, still answers.
      continue;
    }
    if (translated !== undefined && isJsailsError(translated)) return translated;
  }
  return new KernelErrors.Error('internal', {}, { cause: error });
}
