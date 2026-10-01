/**
 * Deterministic code-unit string comparator. A dependency-free leaf so startup
 * modules (route discovery, the compiler walk, CLI command discovery) can sort
 * without loading the `Arr` namespace and its library imports.
 */

/**
 * Deterministic code-unit comparator for `Array.prototype.sort`.
 *
 * `localeCompare` is locale-dependent, so the same input can order differently
 * on two machines; generated artifacts must be byte-stable across environments.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
