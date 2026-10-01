/**
 * Every workspace ships the license text of `core/LICENSE`, and the root
 * LICENSE, README.md and CHANGELOG.md are regular copies of their `core/`
 * originals (`scripts/check-licenses.mjs`).
 */
import { scriptGate } from '../gate-script.mjs';

export const name = 'licenses';
export const description =
  'every workspace LICENSE equals core/LICENSE; root LICENSE/README.md/CHANGELOG.md are copies of core/';
export const needsBuild = false;

export function run({ repoRoot }) {
  return scriptGate(repoRoot, 'check-licenses.mjs');
}
