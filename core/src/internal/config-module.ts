/**
 * Config-module path guards shared by the CLI, app config loader, and runtime
 * config loader. A TypeScript config path is rejected before import so a source
 * checkout fails with the compile-first instruction instead of a loader error.
 */

/** True for a TypeScript config module path (`.ts`, `.mts`, `.cts`). */
export function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}
