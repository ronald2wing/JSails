/**
 * Guards two copies of framework files:
 *
 * - Every published workspace ships the same license text as `core/LICENSE`.
 *   npm packs each workspace's own `LICENSE`, so a stale or missing copy would
 *   publish a package under different terms than the framework.
 * - The repo-root `LICENSE`, `README.md`, and `CHANGELOG.md` are regular files
 *   equal to their `core/` originals (which npm packs for `jsails`). They are
 *   copies, not symlinks, so a checkout needs no `core.symlinks` and reads the
 *   same on Windows; `--write` refreshes them after the `core/` file changes.
 *
 * Usage: node scripts/check-licenses.mjs [--write]   (exit 1 on any mismatch)
 */
import { copyFileSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot, workspaceDirs } from './workspaces.mjs';

/** Root files that are copies of `core/<same name>`. */
export const ROOT_COPIES = Object.freeze(['LICENSE', 'README.md', 'CHANGELOG.md']);

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Workspaces whose `LICENSE` is missing or differs from `core/LICENSE`. */
export function licenseViolations(root = repoRoot, dirs = workspaceDirs()) {
  const canonical = readFileSync(join(root, 'core', 'LICENSE'), 'utf8');
  const violations = [];
  for (const dir of dirs) {
    const file = join(dir, 'LICENSE');
    const text = readText(file);
    if (text === undefined) violations.push(`${relative(root, file)}: missing`);
    else if (text !== canonical)
      violations.push(`${relative(root, file)}: differs from core/LICENSE`);
  }
  return violations;
}

/** Root copies that are missing, not a regular file, or differ from `core/`. */
export function rootCopyViolations(root = repoRoot) {
  const violations = [];
  for (const name of ROOT_COPIES) {
    let stats;
    try {
      stats = lstatSync(join(root, name));
    } catch {
      violations.push(`${name}: missing (a copy of core/${name})`);
      continue;
    }
    if (!stats.isFile()) {
      violations.push(`${name}: must be a regular file equal to core/${name}, not a symlink`);
    } else if (readText(join(root, name)) !== readFileSync(join(root, 'core', name), 'utf8')) {
      violations.push(
        `${name}: differs from core/${name} (run node scripts/check-licenses.mjs --write)`,
      );
    }
  }
  return violations;
}

/**
 * Replaces each root copy with the current `core/` file. The old entry is
 * removed first: copying onto a symlink that points at the source would write
 * the file onto itself.
 */
export function writeRootCopies(root = repoRoot) {
  for (const name of ROOT_COPIES) {
    rmSync(join(root, name), { force: true });
    copyFileSync(join(root, 'core', name), join(root, name));
  }
}

function main(argv) {
  if (argv.includes('--write')) writeRootCopies();
  const dirs = workspaceDirs();
  const violations = [...licenseViolations(repoRoot, dirs), ...rootCopyViolations()];
  if (violations.length > 0) {
    console.error(`check-licenses: ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    return 1;
  }
  console.log(
    `check-licenses: ${dirs.length} workspaces ship the core/LICENSE text; ` +
      `${ROOT_COPIES.join(', ')} equal their core/ copies.`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
