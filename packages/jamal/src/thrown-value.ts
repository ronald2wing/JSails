/**
 * Reading an unknown thrown value: its one-line message (with the `hint:` line
 * a JSails error's suggestion adds) and its Node errno `code`.
 */

/**
 * Render any thrown value as a single-line message. An error carrying a
 * `suggestion` gets it appended as a `hint:` line; the check is structural, so
 * any error class following the JSails error shape renders the same way.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const suggestion = (error as { suggestion?: unknown }).suggestion;
    if (typeof suggestion === 'string' && suggestion.length > 0) {
      return `${error.message}\n  hint: ${suggestion}`;
    }
    return error.message;
  }
  return String(error);
}

/** Whether `error` is a Node-style error carrying the errno `code` (e.g. `ENOENT`). */
export function isErrno(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === code;
}
