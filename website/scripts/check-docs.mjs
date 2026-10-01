#!/usr/bin/env node
/**
 * Docs-to-implementation correctness gate.
 *
 * Every named import the docs teach — from `jsails`, `jsails/<subpath>`,
 * `@jsails/<package>`, or `@jsails/<package>/<subpath>` — must exist: the
 * subpath in that package's `exports`, and each value name in the compiled
 * barrel it resolves to. Packages are read from the monorepo workspaces
 * (`core/`, `packages/<name>/`), so a build must run first. Failures name the
 * page, specifier, and symbol only.
 *
 * Usage: node website/scripts/check-docs.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { readManifest, repoRoot } from '../../scripts/workspaces.mjs';

const docsDir = join(repoRoot, 'website', 'content', 'docs');

/** Workspace directory for a package name, or `undefined` when it is not ours. */
function packageDirOf(name) {
  if (name === 'jsails') return join(repoRoot, 'core');
  if (name.startsWith('@jsails/')) return join(repoRoot, 'packages', name.slice('@jsails/'.length));
  return undefined;
}

const manifests = new Map();

function manifestOf(name) {
  if (!manifests.has(name)) {
    const dir = packageDirOf(name);
    manifests.set(
      name,
      dir !== undefined && existsSync(join(dir, 'package.json'))
        ? { dir, exports: readManifest(dir).exports ?? {} }
        : undefined,
    );
  }
  return manifests.get(name);
}

/** Split `@jsails/admin/server` into the package name and its `exports` key. */
function parseSpecifier(specifier) {
  const parts = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength).join('/');
  const rest = parts.slice(nameLength).join('/');
  return { name, key: rest === '' ? '.' : `./${rest}` };
}

/** The compiled module an `exports` entry resolves to for an ESM importer. */
function moduleOf(entry) {
  if (typeof entry === 'string') return entry;
  return entry.default ?? entry.import;
}

// A barrel's visible names, following `export * from` transitively: the root
// barrel re-exports almost everything, so a single-file scan would miss most.
const barrelNames = new Map();

function exportedNames(file, seen = new Set()) {
  if (barrelNames.has(file)) return barrelNames.get(file);
  if (!existsSync(file) || seen.has(file)) return new Set();
  seen.add(file);

  const text = readFileSync(file, 'utf8');
  const names = new Set();
  const declaration =
    /export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declaration)) names.add(match[1]);
  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      // `export { X as Y }` makes `Y` the visible name.
      const name =
        part
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const name of exportedNames(resolve(dirname(file), match[1]), seen)) names.add(name);
  }

  barrelNames.set(file, names);
  return names;
}

function docPages(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return docPages(path);
    return entry.endsWith('.md') ? [path] : [];
  });
}

const importPattern =
  /import\s*(type\s*)?\{([^}]+)\}\s*from\s*['"]((?:@jsails\/[a-z-]+|jsails)(?:\/[a-z-]+)*)['"]/g;

const pages = docPages(docsDir);
const violations = [];

for (const page of pages) {
  const where = relative(repoRoot, page);
  for (const [, typeOnly, list, specifier] of readFileSync(page, 'utf8').matchAll(importPattern)) {
    const { name, key } = parseSpecifier(specifier);
    const manifest = manifestOf(name);
    if (manifest === undefined) {
      violations.push(`${where}: unknown package "${name}"`);
      continue;
    }
    const entry = manifest.exports[key];
    if (entry === undefined) {
      violations.push(`${where}: "${specifier}" is not an export of ${name}`);
      continue;
    }
    // Type-only imports are checked for the subpath only; types are erased.
    if (typeOnly !== undefined) continue;

    const target = moduleOf(entry);
    if (target === undefined) continue;
    const barrel = resolve(manifest.dir, target);
    if (!existsSync(barrel)) {
      violations.push(`${where}: "${specifier}" is not built (${target}); run a build first`);
      continue;
    }
    const names = exportedNames(barrel);
    for (const raw of list.split(',')) {
      const item = raw.trim();
      if (item === '' || item.startsWith('type ')) continue;
      const symbol = item.replace(/\s+as\s+.+$/, '');
      if (!names.has(symbol)) {
        violations.push(`${where}: "${symbol}" is not exported from "${specifier}"`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Docs reference symbols or subpaths that do not exist:\n');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(`\n${violations.length} mismatch(es). Fix the docs or the exports.`);
  process.exit(1);
}

console.log(`check-docs: ${pages.length} doc pages validated against package exports.`);
