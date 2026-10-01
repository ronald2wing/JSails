/**
 * The browser closure of a compiled entry: every module a bundler would pull
 * in for it, followed through static imports, re-exports and `import()` with
 * a literal specifier (a bundler emits a lazy chunk for those, so a lazy server
 * import still lands in the browser build). Relative imports and imports of
 * another workspace's public entry are followed; a third-party package is
 * recorded and not entered (its own `browser` field is the bundler's
 * business); a builtin is recorded as `node:<name>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';

import { packageName } from './direction.mjs';

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The specifiers one compiled module imports (static, re-export, literal dynamic). */
export function moduleSpecifiers(parseSync, file, text) {
  const parsed = parseSync(file, text, { sourceType: 'module' });
  const specifiers = [];
  for (const entry of parsed.module.staticImports) specifiers.push(entry.moduleRequest.value);
  for (const statement of parsed.module.staticExports) {
    for (const part of statement.entries) {
      if (part.moduleRequest !== null) specifiers.push(part.moduleRequest.value);
    }
  }
  for (const entry of parsed.module.dynamicImports) {
    const raw = text.slice(entry.moduleRequest.start, entry.moduleRequest.end).trim();
    const literal = /^(['"`])([^'"`$]*)\1$/.exec(raw);
    if (literal !== null) specifiers.push(literal[2]);
  }
  return specifiers;
}

/**
 * What the closure of `entryFile` reaches: `{ builtins, packages, modules }`
 * (builtins as `node:<name>`, third-party package names, and the count of
 * first-party modules walked). `entryFiles` maps a workspace entry specifier
 * (`jsails/client`) to its compiled file; an import of a workspace that is no
 * public entry (`jsails/package.json`) is not followed and not a package.
 */
export function browserClosure(parseSync, entryFile, entryFiles, cache = new Map()) {
  const workspaceNames = new Set([...entryFiles.keys()].map((entry) => packageName(entry)));
  const builtins = new Set();
  const packages = new Set();
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    let specifiers = cache.get(file);
    if (specifiers === undefined) {
      specifiers = moduleSpecifiers(parseSync, file, readFileSync(file, 'utf8'));
      cache.set(file, specifiers);
    }
    for (const specifier of specifiers) {
      if (BUILTINS.has(specifier)) builtins.add(specifier.replace(/^(node:)?/, 'node:'));
      else if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
      else if (entryFiles.has(specifier)) queue.push(entryFiles.get(specifier));
      else if (specifier.startsWith('/')) queue.push(specifier);
      else if (!workspaceNames.has(packageName(specifier))) packages.add(packageName(specifier));
    }
  }
  return { builtins, packages, modules: seen.size };
}

/** `entry -> compiled file` for every public entry (`publicEntries` output). */
export function entryFileMap(entries) {
  return new Map(entries.map(({ entry, file }) => [entry, file]));
}
