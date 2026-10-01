/**
 * The package's dependency boundary, read from its compiled sources: no
 * TypeORM and no `@jsails/cache` anywhere, and every bare import a builtin,
 * one of the `jsails` subpaths the package is allowed to use, or `bullmq`.
 * Two of them are imported only dynamically, so importing any entry point
 * loads neither: `jsails/internal` (the kernel's command runner, which pins
 * `jsails` to the lockstep version), imported when a command job runs, and
 * `bullmq` (an optional peer), imported by the one module that loads it.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ALLOWED: ReadonlySet<string> = new Set([
  'jsails/context',
  'jsails/errors',
  'jsails/extensions',
  'jsails/internal',
  'jsails/signals',
  'jsails/zod',
]);

/** Allowed only as a dynamic `import()`. */
const DYNAMIC_ONLY: ReadonlySet<string> = new Set(['jsails/internal', 'bullmq']);

/** The one module that loads the optional peer `bullmq`. */
const BULLMQ_LOADER = join('valkey', 'bullmq-module.js');

const SPECIFIERS = [
  /(?:^|[\s;])(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

function specifiers(file: string, patterns: readonly RegExp[] = SPECIFIERS): string[] {
  const text = readFileSync(file, 'utf8');
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!));
}

describe('dependency boundary', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = sources(root);

  test('the compiled sources are found', () => {
    assert.ok(files.length > 20, `only ${files.length} compiled sources found under ${root}`);
  });

  test('every bare import is a builtin or an allowed jsails subpath', () => {
    const found = new Set<string>();
    for (const file of files) {
      for (const specifier of specifiers(file)) {
        if (specifier.startsWith('.')) continue;
        found.add(specifier);
        if (specifier === 'bullmq') {
          assert.ok(file.endsWith(BULLMQ_LOADER), `${file} imports bullmq`);
          continue;
        }
        assert.ok(
          !specifier.startsWith('typeorm') && !specifier.startsWith('@jsails/cache'),
          `${file} imports ${specifier}`,
        );
        assert.ok(
          specifier.startsWith('node:') || ALLOWED.has(specifier),
          `${file} imports ${specifier}, which the package may not depend on`,
        );
      }
    }
    assert.ok(found.has('jsails/context'), 'the scan found no jsails import at all');
    assert.ok(found.has('bullmq'), 'the scan found no bullmq loader');
  });

  test('jsails/internal and bullmq are imported only dynamically', () => {
    const statics = SPECIFIERS.slice(0, 2);
    for (const file of files) {
      for (const specifier of specifiers(file, statics)) {
        assert.ok(!DYNAMIC_ONLY.has(specifier), `${file} imports ${specifier} statically`);
      }
    }
  });
});
