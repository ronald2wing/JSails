/**
 * The schema-portability check behind the `data-specs` gate: every model in
 * the repository is a ModelSpec, and every ModelSpec lowers on all three
 * dialects with its foreign-key and tenant columns indexed.
 *
 * It reads each workspace's `src/` for two things. A file that imports
 * `@jsails/database/model` (or, inside `@jsails/database`, its `model/`
 * directory) and calls `defineModel` or `defineTable` declares models: the
 * check imports its built module from `dist/src` and takes every export that
 * carries a model definition. A file with a TypeORM `@Entity(...)` class or a
 * `new EntitySchema(...)` declares a model that is not a ModelSpec; those
 * are listed in `scripts/expected-failures/data-specs.json`, which may only
 * shrink until the data cutover (DAT-15b) empties it.
 *
 * Failures: a model module that cannot be imported (a spec the validator
 * refuses throws at definition); a file that defines models but exports
 * none; `physicalTable` refusing a model on any dialect; a foreign-key or
 * tenant column that leads no index; two models with one table name, or two
 * tables with one index name (PostgreSQL index names share one namespace);
 * and a non-spec model the ledger does not list, or a listed one that is gone.
 *
 * Usage: node scripts/check-schema-portability.mjs   (needs a build; exit 1 on any failure)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ratchet, readGateLedger } from './expected-failures.mjs';
import { repoRoot, workspaceDirs } from './workspaces.mjs';

export const GATE = 'data-specs';
export const DIALECTS = Object.freeze(['postgres', 'mariadb', 'sqlite']);
const MODEL_SUBPATH = '@jsails/database/model';
const DATABASE_SOURCE = join('packages', 'database', 'src');

/**
 * `text` with comments and the contents of string and template literals
 * blanked (line breaks kept), so only code is searched: a model mentioned in
 * documentation or emitted as text is not a model.
 */
export function codeOnly(text) {
  let out = '';
  let index = 0;
  const blank = (from, to) => {
    out += text.slice(from, to).replace(/[^\n]/g, ' ');
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      out += char;
      blank(index + 1, Math.min(end, text.length));
      out += end < text.length ? char : '';
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** Module specifiers a source text imports or re-exports. */
function specifiers(text) {
  return [...text.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/**
 * What one source file declares: `defines` when it imports the model API and
 * calls `defineModel`/`defineTable`, and `entities`, the names of its
 * TypeORM `@Entity` classes and `EntitySchema` instances.
 */
export function scanSource(text, { insideDatabase = false } = {}) {
  const code = codeOnly(text);
  const importsModel = specifiers(text).some(
    (specifier) =>
      specifier === MODEL_SUBPATH ||
      (insideDatabase && /(?:^|\/)model\/[a-z-]+\.js$/.test(specifier)),
  );
  const defines = importsModel && /(?<!function\s+)\bdefine(?:Model|Table)\s*[<(]/.test(code);
  const entities = [];
  for (const match of code.matchAll(/@Entity\s*\(/g)) {
    const rest = code.slice(match.index);
    const name = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(rest)?.[1];
    entities.push(name ?? `@Entity@${match.index}`);
  }
  for (const match of code.matchAll(/\bnew\s+EntitySchema\s*[<(]/g)) {
    entities.push(`EntitySchema@${match.index}`);
  }
  return { defines, entities };
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Repository-relative path with `/` separators. */
function repoPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

/**
 * Scan every workspace's `src/`: the files that define models (with their
 * built module path) and the ids of non-spec models (`<path>#<name>`).
 */
export function scanWorkspaces(root, workspaces) {
  const modelFiles = [];
  const entities = [];
  for (const workspace of workspaces) {
    const src = join(workspace, 'src');
    for (const file of sourceFiles(src)) {
      const path = repoPath(root, file);
      const insideDatabase = relative(root, file).startsWith(DATABASE_SOURCE + sep);
      const scan = scanSource(readFileSync(file, 'utf8'), { insideDatabase });
      if (scan.defines) {
        const built = join(workspace, 'dist', 'src', relative(src, file)).replace(/\.tsx?$/, '.js');
        modelFiles.push({ path, built });
      }
      for (const name of scan.entities) entities.push(`${path}#${name}`);
    }
  }
  return { modelFiles, entities };
}

/** Import each model file's built module and collect its exported definitions. */
export async function collectModels(modelFiles, model) {
  const failures = [];
  const models = [];
  const seen = new Set();
  for (const { path, built } of modelFiles) {
    if (!existsSync(built)) {
      failures.push(`${path}: no built module at ${built}; run "npm run build"`);
      continue;
    }
    let exports;
    try {
      exports = await import(pathToFileURL(built).href);
    } catch (error) {
      const code = error?.code === undefined ? '' : ` [${error.code}]`;
      failures.push(`${path}: the module fails to load${code}: ${error?.message ?? String(error)}`);
      continue;
    }
    let found = 0;
    for (const [name, value] of Object.entries(exports)) {
      const definition = model.modelDefinition(value);
      if (definition === undefined) continue;
      found += 1;
      if (seen.has(definition)) continue;
      seen.add(definition);
      models.push({ id: `${path}#${name}`, target: value, spec: definition.spec });
    }
    if (found === 0) {
      failures.push(`${path}: defines models but exports none, so no tool can see them`);
    }
  }
  return { models, failures };
}

/** Lower every model on every dialect and check names across the whole set. */
export function checkModels(models, model) {
  const failures = [];
  const tables = new Map();
  const indexes = new Map();
  for (const { id, target, spec } of models) {
    const owner = tables.get(spec.table);
    if (owner !== undefined) failures.push(`${id}: table "${spec.table}" is also ${owner}'s`);
    tables.set(spec.table, id);
    let lowered;
    for (const dialect of DIALECTS) {
      try {
        lowered = model.physicalTable(target, dialect);
      } catch (error) {
        failures.push(`${id}: ${dialect}: ${error?.message ?? String(error)}`);
        lowered = undefined;
        break;
      }
    }
    if (lowered === undefined) continue;
    for (const columns of model.unindexedColumns(lowered)) {
      failures.push(`${id}: foreign-key or tenant column ${columns} leads no index`);
    }
    for (const index of lowered.indexes) {
      const other = indexes.get(index.name);
      if (other !== undefined) failures.push(`${id}: index "${index.name}" is also ${other}'s`);
      indexes.set(index.name, id);
    }
  }
  return failures;
}

/** Gate failures for non-spec models against the gate ledger. */
export function judgeEntities(entities, ledger) {
  const { unlisted, fixed } = ratchet(ledger, entities);
  return [
    ...unlisted.map(
      (id) =>
        `${id} is a TypeORM model, not a ModelSpec: declare it with defineModel or defineTable from ${MODEL_SUBPATH}`,
    ),
    ...fixed.map(
      (id) => `fixed: "${id}" is no longer a TypeORM model; remove it from ${GATE}.json`,
    ),
  ];
}

/**
 * Every failure of the check. `model` is the `@jsails/database/model` module
 * (the built one under `root` by default); `ledger` the gate ledger.
 */
export async function checkSchemaPortability({
  root = repoRoot,
  workspaces = workspaceDirs(),
  ledger = readGateLedger(GATE, { root }),
  model,
} = {}) {
  const api =
    model ??
    (await import(
      pathToFileURL(join(root, 'packages', 'database', 'dist', 'src', 'model', 'index.js')).href
    ));
  const { modelFiles, entities } = scanWorkspaces(root, workspaces);
  const { models, failures } = await collectModels(modelFiles, api);
  return [...failures, ...checkModels(models, api), ...judgeEntities(entities, ledger)];
}

async function main() {
  const failures = await checkSchemaPortability();
  for (const failure of failures) console.error(failure);
  if (failures.length === 0) console.log('schema portability: every model is a portable ModelSpec');
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
