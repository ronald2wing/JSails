/**
 * The package-direction scan: every import in `core/src`, and every import of
 * a mapped future package (`jsails/<subpath>` placed by the map, or a package
 * the map names) in the `src/` of a workspace the map names, judged against
 * the final package map (`package-map.mjs`).
 *
 * Imports are read with the oxc parser core already ships (`loadParser` from
 * `scripts/api-report.mjs`):
 * static imports, re-exports, and `import()` with a literal specifier. A
 * type-only import counts as well, because the importing package's
 * declarations would name the imported one.
 *
 * A violation id is `<file> -> <future package>` for a first-party import
 * against the allowed direction, and `<file> -> npm:<package>` for a
 * third-party import that neither the importing future package nor a package
 * it may import owns (a package may use what its imports own, as a peer). A file that no
 * placement rule covers is reported apart, as `unplaced`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';

import {
  PACKAGES,
  PLACEMENT,
  mayImport,
  ownsDependency,
  placeOf,
  reachable,
} from './package-map.mjs';

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const SOURCE = /\.tsx?$/;

const posix = (path) => path.split(sep).join('/');

/** The package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every `.ts`/`.tsx` file below `dir`, sorted, skipping declaration files. */
export function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(dir);
  return files.sort();
}

/** The import specifiers of one source file: `[{ specifier, typeOnly }]`. */
export function importsOf(parseSync, file, text) {
  const parsed = parseSync(file, text, {
    sourceType: 'module',
    lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
  });
  const found = [];
  for (const entry of parsed.module.staticImports) {
    const typeOnly = entry.entries.length > 0 && entry.entries.every((part) => part.isType);
    found.push({ specifier: entry.moduleRequest.value, typeOnly });
  }
  for (const statement of parsed.module.staticExports) {
    const requests = statement.entries.filter((part) => part.moduleRequest !== null);
    if (requests.length === 0) continue;
    found.push({
      specifier: requests[0].moduleRequest.value,
      typeOnly: requests.every((part) => part.isType),
    });
  }
  for (const entry of parsed.module.dynamicImports) {
    const raw = text.slice(entry.moduleRequest.start, entry.moduleRequest.end).trim();
    const literal = /^(['"`])([^'"`$]*)\1$/.exec(raw);
    if (literal !== null) found.push({ specifier: literal[2], typeOnly: false });
  }
  return found;
}

/** Resolves a relative `.js` specifier of a source file to the source file it names. */
function resolveRelative(fromFile, specifier) {
  const target = resolve(fromFile, '..', specifier);
  const candidates = [
    target,
    target.replace(/\.js$/, '.ts'),
    target.replace(/\.js$/, '.tsx'),
    target.replace(/\.jsx$/, '.tsx'),
    join(target, 'index.ts'),
  ];
  return candidates.find((candidate) => SOURCE.test(candidate) && existsSync(candidate)) ?? target;
}

/** `jsails/<sub>` -> the `core/src` path of its barrel, from core's `exports`. */
function coreSubpaths(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'core', 'package.json'), 'utf8'));
  const subpaths = new Map();
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const target = typeof value === 'string' ? value : value?.default;
    if (typeof target !== 'string' || !target.startsWith('./dist/src/')) continue;
    const source = target.slice('./dist/src/'.length).replace(/\.js$/, '.ts');
    const tsx = source.replace(/\.ts$/, '.tsx');
    const file = existsSync(join(root, 'core', 'src', tsx)) ? tsx : source;
    subpaths.set(key === '.' ? 'jsails' : `jsails${key.slice(1)}`, file);
  }
  return subpaths;
}

/**
 * Scans the repo at `root`; `workspaces` is `[{ name, dir }]`. Returns `{ violations, unplaced }`: violations as
 * `[{ id, file, owner, target, typeOnly }]` (one per file and target, `typeOnly` when
 * every import behind it is type-only), and the `core/src` files no rule
 * places.
 */
export function scanDirection(
  parseSync,
  { root, packages = PACKAGES, placement = PLACEMENT, workspaces = [] },
) {
  const coreSrc = join(root, 'core', 'src');
  const workspaceNames = workspaces.map((workspace) => workspace.name);
  const subpaths = coreSubpaths(root);
  const found = new Map();
  const unplaced = [];
  const record = (file, owner, target, typeOnly) => {
    const id = `${posix(relative(root, file))} -> ${target}`;
    const previous = found.get(id);
    found.set(id, {
      id,
      file: posix(relative(root, file)),
      owner,
      target,
      typeOnly: (previous?.typeOnly ?? true) && typeOnly,
    });
  };
  const placeOfCore = (path) => placeOf(posix(relative(coreSrc, path)), placement);

  for (const file of sourceFiles(coreSrc)) {
    const owner = placeOfCore(file);
    if (owner === undefined) {
      unplaced.push(posix(relative(root, file)));
      continue;
    }
    for (const { specifier, typeOnly } of importsOf(parseSync, file, readFileSync(file, 'utf8'))) {
      if (BUILTINS.has(specifier)) continue;
      let target;
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier);
        if (!resolved.startsWith(coreSrc + sep)) continue;
        target = placeOfCore(resolved);
        if (target === undefined) continue;
        if (!mayImport(owner, target, packages)) record(file, owner, target, typeOnly);
        continue;
      }
      const name = packageName(specifier);
      if (name === 'jsails') {
        const barrel = subpaths.get(specifier);
        target = barrel === undefined ? undefined : placeOf(barrel, placement);
        if (target !== undefined && !mayImport(owner, target, packages)) {
          record(file, owner, target, typeOnly);
        }
      } else if (workspaceNames.includes(name) || packages[name] !== undefined) {
        if (!mayImport(owner, name, packages)) record(file, owner, name, typeOnly);
      } else if (
        ![...reachable(owner, packages)].some((by) => ownsDependency(by, name, packages))
      ) {
        record(file, owner, `npm:${name}`, typeOnly);
      }
    }
  }

  // A mapped workspace keeps to its map entry like any core directory: it may
  // import only the future packages the map allows (an import back into code
  // that will depend on it, a cycle once the packages exist, is one case).
  for (const { name: workspace, dir } of workspaces) {
    if (workspace === 'jsails' || packages[workspace] === undefined) continue;
    for (const file of sourceFiles(join(dir, 'src'))) {
      for (const { specifier, typeOnly } of importsOf(
        parseSync,
        file,
        readFileSync(file, 'utf8'),
      )) {
        const name = packageName(specifier);
        let target;
        if (name === 'jsails') {
          const barrel = subpaths.get(specifier);
          target = barrel === undefined ? undefined : placeOf(barrel, placement);
        } else if (packages[name] !== undefined) {
          target = name;
        }
        if (target === undefined || target === workspace) continue;
        if (!mayImport(workspace, target, packages)) record(file, workspace, target, typeOnly);
      }
    }
  }

  return {
    violations: [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    unplaced,
  };
}
