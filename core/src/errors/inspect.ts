/**
 * Read an unknown thrown value: render it as a one-line message, or read its
 * Node errno `code`.
 *
 * A dependency-free leaf (no Node runtime imports), so command modules, Jamal,
 * the deploy tooling, and browser modules can all import it without forming a
 * cycle back into the CLI dispatcher.
 */

/** Options for the sanitized form of {@link formatError}. */
interface FormatErrorOptions {
  /** When set, only errors passing this predicate have their message echoed. */
  readonly allow?: (error: unknown) => boolean;
  /** Message returned when `allow` is set and the error is not allowed. */
  readonly fallback?: string;
}

/**
 * Render any thrown value as a single-line message. With `options.allow`, the
 * message is echoed only for errors the caller declares safe to surface; every
 * other value is replaced with `options.fallback` (default `the command failed`).
 *
 * An error carrying a `suggestion` gets it appended as a `hint:` line. The
 * check is structural rather than `instanceof JsailsError` so this module stays
 * a dependency-free leaf: a plugin's own error class that follows the same
 * shape gets the same rendering.
 */
export function formatError(error: unknown, options?: FormatErrorOptions): string {
  if (options?.allow !== undefined && !options.allow(error)) {
    return options.fallback ?? 'the command failed';
  }
  if (error instanceof Error) {
    const suggestion = (error as { suggestion?: unknown }).suggestion;
    if (typeof suggestion === 'string' && suggestion.length > 0) {
      return `${error.message}\n  hint: ${suggestion}`;
    }
    return error.message;
  }
  return String(error);
}

/** The errno `code` of a Node-style error, if any (e.g. `ENOENT`, `EACCES`). */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return undefined;
}

/** Whether `error` is a Node-style error carrying the given errno `code`. */
export function isErrno(error: unknown, code: string): boolean {
  return errnoCode(error) === code;
}
