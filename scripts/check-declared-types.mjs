/**
 * Guards that every package a workspace's shipped declarations import is a
 * dependency of that workspace.
 *
 * A `.d.ts` under `dist/` is read by consumers' compilers, so a package it
 * imports must be installable from the published manifest: `dependencies`,
 * `peerDependencies`, or `optionalDependencies`. The root `devDependencies`
 * are invisible to a consumer, and the starters compile with `skipLibCheck`,
 * so a type package that lives only there resolves to `any` downstream without
 * an error. This gate makes that a build failure here instead.
 *
 * A specifier is satisfied by the package itself or by its `@types/` package;
 * `node:` and bare Node builtins, relative paths, and a workspace's own name
 * are not checked. Needs an existing build; `dist/test` is never shipped and
 * is skipped.
 *
 * Usage: node scripts/check-declared-types.mjs   (exit 1 on any violation)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';

import { readManifest, repoRoot, workspaceDirs } from './workspaces.mjs';

const BUILTINS = new Set(builtinModules);

const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
];
const REFERENCE_PATTERN = /\/\/\/\s*<reference\s+types=['"]([^'"]+)['"]/g;

/**
 * The specifiers a declaration file resolves. Reference directives are read
 * first because comment stripping removes them along with the doc comments,
 * whose code examples would otherwise count as imports.
 */
function* specifiers(text) {
  for (const [, specifier] of text.matchAll(REFERENCE_PATTERN)) yield specifier;
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const pattern of IMPORT_PATTERNS) {
    for (const [, specifier] of code.matchAll(pattern)) yield specifier;
  }
}

/** The package name a bare specifier resolves to, or `undefined` for a path. */
function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The `@types/` package DefinitelyTyped publishes for `name`. */
function typesPackage(name) {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

function declarationFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return declarationFiles(path);
    return entry.isFile() && entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const violations = [];
let checked = 0;

for (const dir of workspaceDirs()) {
  const manifest = readManifest(dir);
  const declared = new Set(
    [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap(
      (group) => Object.keys(group ?? {}),
    ),
  );
  const shipped = join(dir, 'dist', 'src');
  if (!existsSync(shipped)) {
    violations.push(`${relative(repoRoot, dir)}: no dist/src — run a build first`);
    continue;
  }

  for (const file of declarationFiles(shipped)) {
    checked += 1;
    const text = readFileSync(file, 'utf8');
    const missing = new Set();
    for (const specifier of specifiers(text)) {
      const name = packageName(specifier);
      if (name === undefined || name === manifest.name) continue;
      if (declared.has(name) || declared.has(typesPackage(name))) continue;
      missing.add(name);
    }
    for (const name of missing) {
      violations.push(
        `${relative(repoRoot, file)}: imports "${name}", not a dependency of ${manifest.name}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`check-declared-types: ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `check-declared-types: ${checked} declaration files import only declared dependencies.`,
);
