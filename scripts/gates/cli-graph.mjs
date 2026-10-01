/**
 * The CLI's static import graph stays clear of the app stack.
 *
 * From the built `jsails` bin (`core/dist/src/cli/bin.cjs`), its module
 * (`index.js`) and the command table (`manifest.js`), every static import and
 * re-export is followed through `core/dist/src`; a dynamic `import()` is
 * not, since that is where a command loads what it needs when it runs. No
 * module reached may import zod, typeorm, bullmq, hono or preact, or reach
 * the app config schema (`app/config/schema.js`): listing commands, a usage
 * error and a command's help are answered by this graph alone. How many
 * modules `jsails --help` loads is ratcheted by the import-graph gate's
 * `cli-help` scenario; this gate names the edge that pulled a forbidden
 * module in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { loadParser } from '../api-report.mjs';

export const name = 'cli-graph';
export const description =
  'the jsails bin, CLI module and command table statically reach no schema, ORM, queue or server library';
export const needsBuild = true;

/** Packages the static CLI graph may not import. */
export const FORBIDDEN_PACKAGES = Object.freeze(['zod', 'typeorm', 'bullmq', 'hono', 'preact']);
/** Modules under `core/dist/src` the static CLI graph may not reach. */
export const FORBIDDEN_MODULES = Object.freeze(['app/config/schema.js']);

const ENTRIES = Object.freeze(['cli/bin.cjs', 'cli/index.js', 'cli/manifest.js']);

/** The package an import specifier names, or `undefined` for a relative or builtin one. */
function packageOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The static specifiers of one module: imports and re-exports, never `import()`. */
function staticSpecifiers(parseSync, file, text) {
  const parsed = parseSync(file, text, {
    sourceType: file.endsWith('.cjs') ? 'script' : 'module',
  });
  const specifiers = parsed.module.staticImports.map((entry) => entry.moduleRequest.value);
  for (const statement of parsed.module.staticExports) {
    for (const part of statement.entries) {
      if (part.moduleRequest !== null) specifiers.push(part.moduleRequest.value);
    }
  }
  return specifiers;
}

/**
 * Walk the static graph from the entries under `srcDir`; returns the
 * violations as `importer -> target` lines (paths relative to `srcDir`).
 */
export function scanCliGraph(parseSync, srcDir) {
  const violations = [];
  const seen = new Set();
  // Named by their posix entry ids, so the message reads the same on every platform.
  const missing = ENTRIES.filter((entry) => !existsSync(join(srcDir, entry)));
  if (missing.length > 0) return missing.map((entry) => `${entry} is missing; build core first`);
  const queue = ENTRIES.map((entry) => join(srcDir, entry));
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const from = relative(srcDir, file).split('\\').join('/');
    for (const specifier of staticSpecifiers(parseSync, file, readFileSync(file, 'utf8'))) {
      const owner = packageOf(specifier);
      if (owner !== undefined) {
        if (FORBIDDEN_PACKAGES.includes(owner)) violations.push(`${from} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      const id = relative(srcDir, target).split('\\').join('/');
      if (FORBIDDEN_MODULES.includes(id)) violations.push(`${from} -> ${id}`);
      if (existsSync(target)) queue.push(target);
    }
  }
  return violations;
}

export async function run({ repoRoot }) {
  const parseSync = await loadParser(repoRoot);
  return scanCliGraph(parseSync, join(repoRoot, 'core', 'dist', 'src')).map((line) =>
    line.includes('->')
      ? `the static CLI graph reaches a forbidden module (${line}); load it with import() where the command runs`
      : line,
  );
}
