/**
 * Guards that every published workspace ships the same license text as
 * `core/LICENSE`, which the repo-root `LICENSE` symlink also points at. npm
 * packs each workspace's own `LICENSE`, so a stale or missing copy would
 * publish a package under different terms than the framework.
 *
 * Usage: node scripts/check-licenses.mjs   (exit 1 on any mismatch)
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot, workspaceDirs } from './workspaces.mjs';

const canonical = readFileSync(join(repoRoot, 'core', 'LICENSE'), 'utf8');
const violations = [];
let checked = 0;

for (const dir of workspaceDirs()) {
  const file = join(dir, 'LICENSE');
  checked += 1;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    violations.push(`${relative(repoRoot, file)}: missing`);
    continue;
  }
  if (text !== canonical) violations.push(`${relative(repoRoot, file)}: differs from core/LICENSE`);
}

if (violations.length > 0) {
  console.error(`check-licenses: ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`check-licenses: ${checked} workspaces ship the core/LICENSE text.`);
