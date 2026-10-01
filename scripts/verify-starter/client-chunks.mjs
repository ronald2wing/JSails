/**
 * The built client's chunk graph (stage `client-chunks`). The page loads the
 * entry as `/assets/app.js?v=<hash>`, a URL no chunk names, so a chunk that
 * imported the entry (`../app.js`) would load a second copy of the client:
 * a second Preact, a second island registry hydrating the same DOM. The
 * starters' Vite config prevents it (`preserveEntrySignatures: 'strict'`);
 * this check reads the real build output, parsing every chunk's static and
 * constant dynamic imports, and fails on any chunk that resolves one to the
 * entry. It also names the lazy chunks the entry loads, so a stage can
 * require one (the rich-text editor's runtime) to stay out of the entry.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../workspaces.mjs';

/** Rolldown's parser, resolved from core (its dependency). */
async function loadParser() {
  const require = createRequire(join(repoRoot, 'core', 'package.json'));
  return import(pathToFileURL(require.resolve('rolldown/parseAst')).href);
}

/** Every node below `node`, depth first. */
function* walk(node) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node.type === 'string') yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && value !== null && typeof value === 'object') yield* walk(value);
  }
}

/**
 * The text of a constant specifier: a string literal, or a template literal
 * with no substitution (Vite writes its dynamic imports as `` import(`./x.js`) ``).
 */
function constantSpecifier(source) {
  if (source?.type === 'Literal' && typeof source.value === 'string') return source.value;
  if (source?.type === 'TemplateLiteral' && source.expressions.length === 0) {
    return source.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** The static and constant dynamic import specifiers of one module's code. */
export function importSpecifiers(parseAst, code) {
  const specifiers = { static: [], dynamic: [] };
  for (const node of walk(parseAst(code, { sourceType: 'module' }))) {
    const specifier = constantSpecifier(node.source);
    if (specifier === null) continue;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      specifiers.static.push(specifier);
    } else if (node.type === 'ImportExpression') {
      specifiers.dynamic.push(specifier);
    }
  }
  return specifiers;
}

/** Every `.js` file under `dir`, as POSIX paths relative to it. */
function chunkFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...chunkFiles(dir, path));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

/**
 * `specifier` imported from chunk `from`, as a path relative to the assets
 * root, which the site serves at `base`; `null` for a bare or foreign one.
 */
function resolveChunk(from, specifier, base) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const { pathname } = new URL(specifier, `https://assets.invalid${base}${from}`);
  return pathname.startsWith(base) ? decodeURIComponent(pathname.slice(base.length)) : null;
}

/**
 * The chunk graph of the build in `assetsDir` (Vite's `outDir`):
 * served at `base`: `{ entryImporters, lazy }`, where `entryImporters` lists each chunk that
 * imports `entry` (statically or dynamically) and `lazy` every chunk loaded
 * through `import()` from any chunk.
 */
export async function readClientChunks(assetsDir, { entry = 'app.js', base = '/assets/' } = {}) {
  const { parseAst } = await loadParser();
  const entryImporters = [];
  const lazy = new Set();
  for (const file of chunkFiles(assetsDir)) {
    const code = readFileSync(join(assetsDir, ...file.split('/')), 'utf8');
    const imports = importSpecifiers(parseAst, code);
    const resolve = (specifier) => resolveChunk(file, specifier, base);
    if ([...imports.static, ...imports.dynamic].map(resolve).includes(entry)) {
      entryImporters.push(file);
    }
    for (const target of imports.dynamic.map(resolve)) {
      if (target !== null) lazy.add(target);
    }
  }
  return { entryImporters, lazy: [...lazy].sort() };
}

/** The stage: no chunk imports the entry, and a lazy chunk matches each of `lazyNames`. */
export async function checkClientChunks(assetsDir, { lazyNames = [] } = {}) {
  const { entryImporters, lazy } = await readClientChunks(assetsDir);
  if (entryImporters.length > 0) {
    throw new Error(
      `chunks import the entry app.js, which loads a second client: ${entryImporters.join(', ')}`,
    );
  }
  const base = (path) => path.split('/').at(-1) ?? path;
  for (const name of lazyNames) {
    if (!lazy.some((path) => base(path).startsWith(`${name}-`))) {
      throw new Error(
        `no lazy ${name} chunk in the client build (lazy: ${lazy.join(', ') || 'none'})`,
      );
    }
  }
  return `no chunk imports app.js; lazy: ${lazy.map(base).join(', ')}`;
}
