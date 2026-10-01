/**
 * The monorepo as the repo tooling sees it: the repository root, the workspace
 * directories the root `package.json` declares, and a manifest reader. Every
 * script under `scripts/` resolves paths through this module so there is one
 * definition of where the repo is and which packages it contains.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Absolute path of the repository root (the parent of `scripts/`). */
export const repoRoot = resolve(import.meta.dirname, '..');

/** Parses `<dir>/package.json`. */
export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * Expands the root `workspaces` globs into absolute directories, in the order
 * the root manifest lists them. Only a trailing `/*` is supported, which is
 * the only glob form this repo uses.
 */
export function workspaceDirs() {
  const { workspaces } = readManifest(repoRoot);
  return workspaces.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(repoRoot, pattern)];
    const parent = join(repoRoot, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  });
}
