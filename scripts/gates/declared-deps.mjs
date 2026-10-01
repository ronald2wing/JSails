/**
 * Each workspace's shipped `dist/src` imports exactly the packages its manifest
 * declares (`scripts/check-declared-deps.mjs`).
 */
import { scriptGate } from '../gate-script.mjs';

export const name = 'declared-deps';
export const description = 'shipped dist/src imports match each manifest';
export const needsBuild = true;

export function run({ repoRoot }) {
  return scriptGate(repoRoot, 'check-declared-deps.mjs');
}
