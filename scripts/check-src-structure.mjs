// Guards three structural invariants of the `src/` tree that are cheap to state
// and easy to violate by accident:
//
//   1. A file and a directory never share a basename in the same parent. When
//      `foo.ts` and `foo/` coexist, a reader cannot tell which one an importer
//      means, and some tooling resolves them inconsistently.
//   2. Banned generic filenames (`utils`, `helpers`, `misc`, `internal`) never
//      appear. A file is named for the concept it holds, not for its role in a
//      call chain. `internal` is banned because it names a visibility, not a
//      concept: `disk-key.ts` says what it holds, `internal.ts` does not.
//   3. A basename never ends in a role suffix (`-helpers`, `-shared`, `-utils`,
//      `-common`, `-misc`). The same reasoning as (2), applied to the compound
//      names that slip past the exact-match list.
//
// Named exceptions are listed below with the reason they are legitimate. The
// script walks `src/` only; `test/`, `templates/`, and `dist/` are out of scope.
//
// Usage: node scripts/check-src-structure.mjs   (exit 1 on any violation)
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = [
  join(projectRoot, 'core', 'src'),
  ...readdirSync(join(projectRoot, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectRoot, 'plugins', entry.name, 'src'))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory()),
];

const BANNED_BASENAMES = new Set(['utils', 'helpers', 'misc', 'internal']);

// Role suffixes that name a file's position in a call chain rather than the
// concept it holds. Matched against the basename after the extension is
// stripped, so `asset-helpers` and `render-shared` are rejected.
const BANNED_BASENAME_SUFFIXES = ['-helpers', '-shared', '-utils', '-common', '-misc'];

// Legitimate `X.ts` + `X/` pairs, keyed by their path relative to `src/`.
// Each entry states why the pair is intentional. Keep this list empty by
// default: a new entry is a decision, not a convenience.
const COLLISION_EXCEPTIONS = new Map([]);

const violations = [];

/** Walks `src/` and every directory beneath it, running `visit` on each. */
function walk(dir, visit) {
  visit(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), visit);
  }
}

for (const srcRoot of sourceRoots) {
  walk(srcRoot, (dir) => {
    const rel = relative(srcRoot, dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;

      const basename = entry.name.slice(0, -'.ts'.length);

      if (BANNED_BASENAMES.has(basename)) {
        violations.push(
          `${relative(projectRoot, join(dir, entry.name))}: banned generic basename "${basename}"`,
        );
        continue;
      }

      const suffix = BANNED_BASENAME_SUFFIXES.find((candidate) => basename.endsWith(candidate));
      if (suffix !== undefined) {
        violations.push(
          `${relative(projectRoot, join(dir, entry.name))}: basename ends in role suffix "${suffix}" — name the concept instead`,
        );
        continue;
      }

      const siblingDir = join(dir, basename);
      try {
        if (!statSync(siblingDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const key = rel === '' ? basename : `${rel}/${basename}`;
      if (!COLLISION_EXCEPTIONS.has(key)) {
        violations.push(
          `${relative(projectRoot, join(dir, entry.name))}: file and directory share basename "${basename}/"`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`check-src-structure: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(
  'check-src-structure: source structure OK — no file/dir basename collisions, no banned generic filenames or role suffixes.',
);
