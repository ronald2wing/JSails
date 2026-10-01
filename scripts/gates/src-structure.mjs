/**
 * Naming invariants of every workspace `src/` and `test/`
 * (`scripts/check-src-structure.mjs`).
 */
import { scriptGate } from '../gate-script.mjs';

export const name = 'src-structure';
export const description = 'naming invariants of every src/ and test/ tree';
export const needsBuild = false;

export function run({ repoRoot }) {
  return scriptGate(repoRoot, 'check-src-structure.mjs');
}
