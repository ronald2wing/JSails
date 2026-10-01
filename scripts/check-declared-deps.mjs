/**
 * Guards that every workspace's published manifest matches what its shipped
 * code imports, in both directions.
 *
 * Undeclared imports fail the gate:
 *
 *  - A `.d.ts` under `dist/src` is read by consumers' compilers, so a package
 *    it imports must be installable from the published manifest. The root
 *    `devDependencies` are invisible to a consumer, and the starters compile
 *    with `skipLibCheck`, so a type package that lives only there resolves to
 *    `any` downstream without an error. A declaration's specifier is
 *    satisfied by the package itself or by its `@types/` package.
 *  - A `.js` under `dist/src` runs in consumers' processes, so a package it
 *    imports (statically, through `import()`, `require`, `require.resolve`,
 *    or `import.meta.resolve`) must be a runtime dependency. Here only the
 *    package itself counts; an `@types/` package installs no code.
 *
 * "Installable" means `dependencies`, `peerDependencies`, or
 * `optionalDependencies`.
 *
 * Unused declarations fail too: a package in one of those three fields that no
 * shipped `.js` or `.d.ts` imports (directly, or through the `@types/` package
 * it stands for) is installed into every app for nothing, and a second copy of
 * it can appear when its range drifts from the one the code actually reaches
 * through another package. A dependency the code reaches indirectly (loaded by
 * another library by name, or spawned as a binary) belongs in
 * `INDIRECT_DEPENDENCIES` with the reason it is needed.
 *
 * `jsails/internal` (and anything below it) is the kernel's surface for
 * first-party packages, with no compatibility promise between versions. A
 * workspace whose shipped code imports it must declare `jsails` at exactly the
 * lockstep version (core's own `version`, no range) in every field that
 * declares it, so an install can never pair it with another kernel.
 *
 * `node:` and bare Node builtins, relative paths, subpath imports (`#…`), and
 * a workspace's own name are never checked. Needs an existing build;
 * `dist/test` is never shipped and is skipped.
 *
 * Usage: node scripts/check-declared-deps.mjs   (exit 1 on any violation)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';

import { readManifest, repoRoot, workspaceDirs } from './workspaces.mjs';

/** A path as the messages print it: relative to the repo, with `/` on every platform. */
const repoPath = (root, path) => relative(root, path).split(sep).join('/');

/**
 * Declared dependencies that no shipped file imports by name but that the
 * package still needs at runtime, keyed by workspace and then dependency, each
 * with the reason. Keep every reason specific enough to re-check: an entry
 * whose reason no longer holds is a dependency to remove.
 */
export const INDIRECT_DEPENDENCIES = Object.freeze({
  jsails: Object.freeze({
    mysql2:
      'TypeORM loads the MySQL/MariaDB driver by name when a mysql or mariadb data source connects.',
    pg: 'TypeORM loads the PostgreSQL driver by name when a postgres data source connects.',
    'sql.js': 'TypeORM loads sql.js by name for the sqljs data source (tests and SQLite apps).',
    vite: '`jsails dev` and the starters run the `vite build` binary; core pins the version its build plugins are written against.',
  }),
});

const BUILTINS = new Set(builtinModules);
const KERNEL = 'jsails';
const INSTALLABLE_FIELDS = Object.freeze([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/** Whether a specifier reaches the kernel's internal subpath. */
export function isKernelInternal(specifier) {
  return specifier === `${KERNEL}/internal` || specifier.startsWith(`${KERNEL}/internal/`);
}

const DECLARATION_PATTERNS = [
  // `(?<!['"])` keeps a string-literal union member (`'to' | 'from' | 'cc'`) from reading as an import.
  /(?<!['"])\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // A side-effect import starts its line, so a string literal ending in the word
  // (`'a module failed to import'`) does not read as one.
  /^\s*import\s*['"]([^'"]+)['"]/gm,
];
const REFERENCE_PATTERN = /\/\/\/\s*<reference\s+types=['"]([^'"]+)['"]/g;

/*
 * Emitted JavaScript keeps doc comments, whose examples contain import
 * statements, and string literals, which can contain anything. So a static
 * import or re-export is only read where the compiler emits one, at the start
 * of a line, and the call forms only outside comment lines.
 */
const RUNTIME_PATTERNS = [
  /^(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^import\s*['"]([^'"]+)['"]/gm,
  /(?<![\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?<![\w$.])require(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\.meta\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*).*$/gm;

/**
 * The specifiers a declaration file resolves. Reference directives are read
 * first because comment stripping removes them along with the doc comments,
 * whose code examples would otherwise count as imports.
 */
export function* declarationSpecifiers(text) {
  for (const [, specifier] of text.matchAll(REFERENCE_PATTERN)) yield specifier;
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const pattern of DECLARATION_PATTERNS) {
    for (const [, specifier] of code.matchAll(pattern)) yield specifier;
  }
}

/** The specifiers an emitted JavaScript module loads at runtime. */
export function* runtimeSpecifiers(text) {
  const code = text.replace(COMMENT_LINE, '');
  for (const pattern of RUNTIME_PATTERNS) {
    for (const [, specifier] of code.matchAll(pattern)) yield specifier;
  }
}

/**
 * The package name a bare specifier resolves to, or `undefined` for anything
 * else. A specifier containing `${` is a template placeholder in generated
 * source text (the compiler emits import statements for apps), not an import.
 */
export function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  if (specifier.includes('${')) return undefined;
  if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The `@types/` package DefinitelyTyped publishes for `name`. */
export function typesPackage(name) {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

function shippedFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shippedFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

/**
 * Checks one workspace directory against its manifest and returns its
 * violations as `{ file, message }` (`file` relative to `root`) plus the number
 * of files read. `indirect` maps a dependency to the reason it is declared
 * without an import; `lockstepVersion` is the version a workspace importing
 * `jsails/internal` must pin `jsails` to.
 */
export function checkWorkspace(dir, { root = repoRoot, indirect = {}, lockstepVersion } = {}) {
  const manifest = readManifest(dir);
  const installable = new Set(
    INSTALLABLE_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})),
  );
  const shipped = join(dir, 'dist', 'src');
  const where = repoPath(root, dir) || '.';
  if (!existsSync(shipped)) {
    return { checked: 0, violations: [{ file: where, message: 'no dist/src; run a build first' }] };
  }

  const violations = [];
  const used = new Set();
  let internalImport;
  let checked = 0;
  for (const file of shippedFiles(shipped)) {
    const isDeclaration = file.endsWith('.d.ts');
    if (!isDeclaration && !file.endsWith('.js')) continue;
    checked += 1;
    const text = readFileSync(file, 'utf8');
    const missing = new Set();
    for (const specifier of isDeclaration ? declarationSpecifiers(text) : runtimeSpecifiers(text)) {
      const name = packageName(specifier);
      if (name === undefined || name === manifest.name) continue;
      used.add(name);
      if (isKernelInternal(specifier)) internalImport ??= repoPath(root, file);
      // A package that ships no types is declared next to its `@types/`
      // package; a declaration importing it uses both, and dropping the types
      // package would turn that import into `any` downstream.
      const types = typesPackage(name);
      if (isDeclaration && installable.has(types)) used.add(types);
      if (installable.has(name) || (isDeclaration && installable.has(types))) continue;
      missing.add(name);
    }
    for (const name of missing) {
      const kind = isDeclaration ? 'a dependency' : 'a runtime dependency';
      violations.push({
        file: repoPath(root, file),
        message: `imports "${name}", not ${kind} of ${manifest.name}`,
      });
    }
  }

  if (internalImport !== undefined) {
    if (lockstepVersion === undefined) throw new Error('checkWorkspace needs lockstepVersion');
    for (const field of INSTALLABLE_FIELDS) {
      const range = manifest[field]?.[KERNEL];
      if (range === undefined || range === lockstepVersion) continue;
      violations.push({
        file: join(where, 'package.json'),
        message: `${internalImport} imports ${KERNEL}/internal, so ${field} must pin "${KERNEL}" to exactly ${lockstepVersion}, not "${range}"`,
      });
    }
  }

  for (const name of [...installable].sort()) {
    if (used.has(name) || Object.hasOwn(indirect, name)) continue;
    violations.push({
      file: join(where, 'package.json'),
      message: `declares "${name}", which nothing under dist/src imports`,
    });
  }
  for (const name of Object.keys(indirect).sort()) {
    if (installable.has(name)) continue;
    violations.push({
      file: 'scripts/check-declared-deps.mjs',
      message: `INDIRECT_DEPENDENCIES lists "${name}" for ${manifest.name}, which does not declare it`,
    });
  }
  return { checked, violations };
}

function main() {
  const violations = [];
  let checked = 0;
  const lockstepVersion = readManifest(join(repoRoot, 'core')).version;
  for (const dir of workspaceDirs()) {
    const { name } = readManifest(dir);
    const result = checkWorkspace(dir, {
      indirect: INDIRECT_DEPENDENCIES[name] ?? {},
      lockstepVersion,
    });
    checked += result.checked;
    violations.push(...result.violations);
  }

  if (violations.length > 0) {
    console.error(`check-declared-deps: ${violations.length} violation(s):`);
    for (const { file, message } of violations) console.error(`  - ${file}: ${message}`);
    process.exit(1);
  }
  console.log(`check-declared-deps: ${checked} shipped files import exactly what they declare.`);
}

if (import.meta.main) main();
