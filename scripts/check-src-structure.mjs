/**
 * Guards three structural invariants of every workspace's `src/` and `test/`
 * tree that are cheap to state and easy to violate by accident:
 *
 *   1. A file and a directory never share a basename in the same parent. When
 *      `foo.ts` and `foo/` coexist, a reader cannot tell which one an importer
 *      means, and some tooling resolves them inconsistently. A test tree
 *      mirrors `src/`, so `foo.test.ts` beside `foo/` is the same ambiguity
 *      and is rejected the same way.
 *   2. Banned generic names (`utils`, `helpers`, `misc`, `internal`) never
 *      appear, as a file or as a directory. A module is named for the concept
 *      it holds, not for its role in a call chain. `internal` is banned because
 *      it names a visibility, not a concept: `disk-key.ts` says what it holds,
 *      `internal.ts` does not.
 *   3. A name never ends in a role suffix (`-helpers`, `-shared`, `-utils`,
 *      `-common`, `-misc`). The same reasoning as (2), applied to the compound
 *      names that slip past the exact-match list.
 *
 * Files are checked by their basename with the `.ts`/`.tsx` extension removed;
 * a test file is also checked by its subject, the basename without `.test`, so
 * `render-helpers.test.ts` is rejected like the `render-helpers.ts` it tests.
 * Named exceptions are listed below with the reason they are legitimate. The
 * script walks `src/` and `test/` of `core/` and of every `packages/<name>/`;
 * `templates/` and `dist/` are out of scope.
 *
 * Usage: node scripts/check-src-structure.mjs   (exit 1 on any violation)
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot, workspaceDirs } from './workspaces.mjs';

const TREES = ['src', 'test'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

const roots = workspaceDirs()
  .flatMap((dir) => TREES.map((tree) => join(dir, tree)))
  .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());

const BANNED_NAMES = new Set(['utils', 'helpers', 'misc', 'internal']);

// Role suffixes that name a module's position in a call chain rather than the
// concept it holds. Matched against the name after the extension is stripped,
// so `asset-helpers.ts`, `render-shared/`, and `asset-helpers.test.ts` are all
// rejected.
const BANNED_SUFFIXES = ['-helpers', '-shared', '-utils', '-common', '-misc'];

// Legitimate `X.ts` + `X/` (or `X.test.ts` + `X/`) pairs, keyed by their path
// relative to the tree root (`src/` or `test/`). Each entry states why the pair
// is intentional. Keep this list empty by default: a new entry is a decision,
// not a convenience.
const COLLISION_EXCEPTIONS = new Map([]);

const violations = [];

/** Walks `dir` and every directory beneath it, running `visit` on each. */
function walk(dir, visit) {
  visit(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), visit);
  }
}

/** The module a name is about: the name itself, or what a `.test` file tests. */
function subjectOf(name) {
  return name.endsWith('.test') ? name.slice(0, -'.test'.length) : name;
}

/** The violation a name carries by itself, or `undefined` when it is clean. */
function nameViolation(name) {
  const subject = subjectOf(name);
  if (BANNED_NAMES.has(subject)) return `banned generic name "${subject}"`;
  const suffix = BANNED_SUFFIXES.find((candidate) => subject.endsWith(candidate));
  if (suffix !== undefined)
    return `name ends in role suffix "${suffix}" — name the concept instead`;
  return undefined;
}

for (const root of roots) {
  walk(root, (dir) => {
    const rel = relative(root, dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = relative(repoRoot, join(dir, entry.name));

      if (entry.isDirectory()) {
        const violation = nameViolation(entry.name);
        if (violation !== undefined) violations.push(`${path}/: ${violation}`);
        continue;
      }

      const extension = SOURCE_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate));
      if (!entry.isFile() || extension === undefined) continue;
      const basename = entry.name.slice(0, -extension.length);

      const violation = nameViolation(basename);
      if (violation !== undefined) {
        violations.push(`${path}: ${violation}`);
        continue;
      }

      const subject = subjectOf(basename);
      if (!statSync(join(dir, subject), { throwIfNoEntry: false })?.isDirectory()) continue;
      const key = rel === '' ? subject : `${rel}/${subject}`;
      if (!COLLISION_EXCEPTIONS.has(key)) {
        violations.push(`${path}: file and directory share basename "${subject}/"`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`check-src-structure: ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `check-src-structure: ${roots.length} trees OK — no file/directory basename collisions, no banned generic names or role suffixes.`,
);
