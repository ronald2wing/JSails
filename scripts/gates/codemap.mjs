/**
 * `docs/CODEMAP.md` matches the file tree and every module has a header
 * (`scripts/build-codemap.mjs --check`).
 */
import { scriptGate } from '../gate-script.mjs';

export const name = 'codemap';
export const description = 'docs/CODEMAP.md matches the tree; every module has a header';
export const needsBuild = false;

export function run({ repoRoot }) {
  return scriptGate(repoRoot, 'build-codemap.mjs', ['--check']);
}
