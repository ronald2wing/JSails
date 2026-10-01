/**
 * Reject a non-plain-object options argument. Every generator can be reached
 * through the registry with arbitrary caller input, and each module raises its
 * own error class, so the error factory is passed in rather than fixed here.
 */
export function assertPlainOptions(
  options: unknown,
  label: string,
  fail: (message: string) => Error,
): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail(`${label} must be a plain object`);
  }
}
