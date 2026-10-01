/**
 * `create-jsails` as a module: the `npm create jsails` / `npx create-jsails`
 * convention. npm maps `npm create jsails <dir>` to `create-jsails <dir>`, so
 * {@link main} prepends the `create` command and runs the `jsails` CLI. The
 * executable is `create-bin.cjs`, which checks the Node version first.
 */

import { main as runJsails } from './index.js';

/** The `create-jsails` bin's entry. */
export function main(argv: readonly string[]): Promise<void> {
  return runJsails(['create', ...argv]);
}
