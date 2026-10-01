/**
 * The error-registry gate (KRN-07). It holds two things.
 *
 * Registry structure: every module under a workspace's `src/` that calls
 * `defineErrors` is found by parsing the sources, and its built file is
 * imported in one fresh process, which then reads the process-wide error table
 * (`registeredErrorCodes()`, `errorRegistryConflicts()` from the built error
 * kernel). Finding the registries in the sources, rather than through what a
 * public entry happens to import, reaches the ones only a bin or a lazily
 * loaded module holds (`@jsails/jamal`'s `jamal_credentials`). For that to
 * be the whole table, every call runs at module scope and names its domain as
 * a string literal, and every domain so named must register codes; a call
 * that breaks either rule fails the gate. It fails on a domain defined twice
 * with different codes, and when the codes differ from `api/error-codes.json`,
 * the committed reference data:
 * each code's kind, audience and exposed payload members, and the message of
 * every client-audience code (its wire text). Removing or reclassifying a code
 * is a contract change, so the file changes in the same commit, regenerated
 * with `node scripts/gates/error-registry.mjs --write`.
 *
 * Adoption: a unit (a top-level entry of `core/src`, or one package's `src`)
 * is converted when it raises no hand-written `Error`, `TypeError` or
 * `RangeError` (constructed, called, or extended) and declares no hand-written
 * `JsailsError` subclass. Each unconverted unit is an `adoption:<unit>` entry in
 * `scripts/expected-failures/error-registry.json`, which only shrinks: a
 * converted unit still listed fails until its entry is removed, and
 * `eslint/errors.mjs` enforces the same bans in every unit the ledger does not
 * list, so removing the entry switches the lint on.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatJson, listWorkspaces, loadParser } from '../api-report.mjs';
import { readGateLedger, ratchet } from '../expected-failures.mjs';
import { run as runProcess } from '../subprocess.mjs';
import { repoRoot as defaultRoot } from '../workspaces.mjs';

export const name = 'error-registry';
export const description =
  'error codes are unique and match api/error-codes.json; unconverted units may only shrink';
export const needsBuild = true;

/** Where the committed reference data lives, relative to the repo root. */
/**
 * The reference file, as the repo-relative `/` path messages print on every
 * platform; `join` accepts it as a path segment on Windows too.
 */
export const REFERENCE_FILE = 'api/error-codes.json';

const RAW_ERRORS = new Set(['Error', 'TypeError', 'RangeError']);
const SOURCE = /\.(ts|tsx)$/;
const DECLARATION = /\.d\.ts$/;
const KERNEL_UNIT = 'core/src/errors';

/** The adoption units of the repo: `core/src/<entry>` and `packages/<name>/src`. */
export function adoptionUnits(root, workspaces) {
  const units = [];
  for (const { dir } of workspaces) {
    const src = join(dir, 'src');
    if (!existsSync(src)) continue;
    const unit = relative(root, src).split('\\').join('/');
    if (unit !== 'core/src') {
      units.push({ unit, path: src });
      continue;
    }
    for (const entry of readdirSync(src)) {
      const path = join(src, entry);
      if (statSync(path).isDirectory() || (SOURCE.test(entry) && !DECLARATION.test(entry))) {
        units.push({ unit: `core/src/${entry}`, path });
      }
    }
  }
  return units.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
}

function sourceFiles(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name) && !DECLARATION.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    walk(node[key], visit);
  }
}

/**
 * The adoption violations in one source text, as `{ line, what }` records:
 * a raw error constructed or called, and (outside the error kernel, which
 * holds the base class and the registry classes) a class extending a raw
 * error or `JsailsError`.
 */
export function adoptionViolations(parseSync, file, text, { kernel = false } = {}) {
  const parsed = parseSync(file, text, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  const lineOf = (offset) => text.slice(0, offset).split('\n').length;
  const found = [];
  walk(parsed.program, (node) => {
    if (
      (node.type === 'NewExpression' || node.type === 'CallExpression') &&
      node.callee?.type === 'Identifier' &&
      RAW_ERRORS.has(node.callee.name)
    ) {
      found.push({ line: lineOf(node.start), what: `raw ${node.callee.name}` });
    }
    if (
      (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') &&
      node.superClass?.type === 'Identifier'
    ) {
      // The kernel is where the base class and the registry classes live.
      if (kernel) return;
      if (RAW_ERRORS.has(node.superClass.name)) {
        found.push({ line: lineOf(node.start), what: `class extends ${node.superClass.name}` });
      } else if (node.superClass.name === 'JsailsError') {
        found.push({ line: lineOf(node.start), what: 'hand-written JsailsError subclass' });
      }
    }
  });
  return found;
}

/** Every unit with at least one adoption violation, as `adoption:<unit>` ids. */
export function scanAdoption(parseSync, root, workspaces) {
  const ids = [];
  for (const { unit, path } of adoptionUnits(root, workspaces)) {
    const kernel = unit === KERNEL_UNIT;
    const dirty = sourceFiles(path).some(
      (file) =>
        adoptionViolations(parseSync, file, readFileSync(file, 'utf8'), { kernel }).length > 0,
    );
    if (dirty) ids.push(`adoption:${unit}`);
  }
  return ids;
}

/** Nodes whose body runs later than the module's own evaluation, if at all. */
const DEFERRED_SCOPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassBody',
]);

/**
 * The `defineErrors` calls in one source text, as `{ line, domain }` records:
 * `domain` is the literal domain name, or `undefined` when the first argument
 * is not a string literal, and `deferred` is true for a call inside a
 * function or class body, which importing the module does not run.
 */
export function registryCalls(parseSync, file, text) {
  const parsed = parseSync(file, text, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  const lineOf = (offset) => text.slice(0, offset).split('\n').length;
  const calls = [];
  const visit = (node, deferred) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, deferred);
      return;
    }
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'defineErrors'
    ) {
      const [first] = node.arguments;
      const domain =
        first?.type === 'Literal' && typeof first.value === 'string' ? first.value : undefined;
      calls.push({ line: lineOf(node.start), domain, deferred });
    }
    const inner = deferred || DEFERRED_SCOPES.has(node.type);
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      visit(node[key], inner);
    }
  };
  visit(parsed.program, false);
  return calls;
}

/** A source file's built module: `<workspace>/dist/src/<path>.js`. */
function builtModule(dir, file) {
  const path = relative(join(dir, 'src'), file).replace(SOURCE, '.js');
  return join(dir, 'dist', 'src', path);
}

/**
 * Every first-party registry module, from the sources of every workspace's
 * `src/`: `modules` lists each defining file once, sorted by repo path, with
 * its built file and its literal domains; `problems` names each call the gate
 * could not account for by importing the module.
 */
export function registryModules(parseSync, root, workspaces) {
  const modules = [];
  const problems = [];
  for (const { dir } of workspaces) {
    const src = join(dir, 'src');
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('defineErrors')) continue;
      const calls = registryCalls(parseSync, file, text);
      if (calls.length === 0) continue;
      const source = relative(root, file).split('\\').join('/');
      for (const call of calls) {
        if (call.deferred) {
          problems.push(
            `${source}:${call.line}: defineErrors runs inside a function or class; call it at module scope so importing the module registers the domain`,
          );
        }
        if (call.domain === undefined) {
          problems.push(
            `${source}:${call.line}: defineErrors names its domain with an expression; use a string literal`,
          );
        }
      }
      const domains = calls.flatMap((call) => (call.domain === undefined ? [] : [call.domain]));
      modules.push({ source, built: builtModule(dir, file), domains: [...new Set(domains)] });
    }
  }
  modules.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return { modules, problems };
}

/** The literal domains the sources define that registered no code once imported. */
export function unregisteredDomains(modules, codes) {
  const registered = new Set(codes.map((entry) => entry.code.slice(0, entry.code.indexOf('.'))));
  const missing = [];
  for (const { source, domains } of modules) {
    for (const domain of domains) {
      if (!registered.has(domain)) {
        missing.push(`${source}: error domain "${domain}" registered no code when imported`);
      }
    }
  }
  return missing;
}

const COLLECTOR = `
const [registryUrl, ...entryUrls] = JSON.parse(process.argv[1]);
const failures = [];
for (const url of entryUrls) {
  try {
    await import(url);
  } catch (error) {
    failures.push(url + ': ' + (error instanceof Error ? error.message.split('\\n')[0] : String(error)));
  }
}
const registry = await import(registryUrl);
// An entry may leave a handle open (a timer, a pool); the table is read, so end.
process.stdout.write(
  JSON.stringify({
    codes: registry.registeredErrorCodes(),
    conflicts: registry.errorRegistryConflicts(),
    failures,
  }),
  () => process.exit(0),
);
`;

/** Import every registry module in one process and read the error table. */
export async function collectRegistry(parseSync, root, workspaces) {
  const registry = join(root, 'core', 'dist', 'src', 'errors', 'registry.js');
  if (!existsSync(registry)) return { codes: [], conflicts: [], failures: ['core is not built'] };
  const { modules, problems } = registryModules(parseSync, root, workspaces);
  const unbuilt = modules
    .filter(({ built }) => !existsSync(built))
    .map(({ source }) => `${source} is not built`);
  if (unbuilt.length > 0) return { codes: [], conflicts: [], failures: [...problems, ...unbuilt] };
  const urls = [
    pathToFileURL(registry).href,
    ...modules.map(({ built }) => pathToFileURL(built).href),
  ];
  const result = await runProcess(
    process.execPath,
    ['--input-type=module', '--eval', COLLECTOR, JSON.stringify(urls)],
    { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, capture: true },
  );
  if (result.code !== 0) {
    return {
      codes: [],
      conflicts: [],
      failures: [...problems, `collector exited ${result.code}: ${result.stderr}`],
    };
  }
  const collected = JSON.parse(result.stdout);
  return {
    ...collected,
    failures: [
      ...problems,
      ...collected.failures,
      ...unregisteredDomains(modules, collected.codes),
    ],
  };
}

/** The committed reference data for a list of registered codes. */
export function referenceData(codes) {
  const reference = {};
  for (const entry of codes) {
    reference[entry.code] = {
      kind: entry.kind,
      audience: entry.audience,
      ...(entry.exposes.length === 0 ? {} : { exposes: [...entry.exposes] }),
      ...(entry.audience === 'client' ? { message: entry.message } : {}),
    };
  }
  return reference;
}

/**
 * The text of the committed reference for a list of registered codes,
 * formatted the way the repository's Prettier config formats it, so a
 * regenerated file passes `format:check` as it is written: one key per line
 * in every code's entry, so a changed code is a diff of its own lines.
 */
export function renderReference(root, codes) {
  return formatJson(root, REFERENCE_FILE, referenceData(codes), 2);
}

/** Gate failures for a collected registry against the committed reference. */
export function judgeRegistry({ codes, conflicts, failures }, committed) {
  const problems = failures.map((failure) => `registry collection: ${failure}`);
  for (const domain of conflicts) {
    problems.push(`error domain "${domain}" is defined twice with different codes`);
  }
  const current = referenceData(codes);
  if (committed === undefined) {
    problems.push(
      `${REFERENCE_FILE} is missing; run node scripts/gates/error-registry.mjs --write`,
    );
    return problems;
  }
  const keys = new Set([...Object.keys(current), ...Object.keys(committed)]);
  for (const code of [...keys].sort()) {
    const now = JSON.stringify(current[code]);
    const then = JSON.stringify(committed[code]);
    if (now === then) continue;
    if (now === undefined) problems.push(`error code ${code} was removed`);
    else if (then === undefined) problems.push(`error code ${code} is new`);
    else problems.push(`error code ${code} changed`);
  }
  if (problems.length > failures.length + conflicts.length) {
    problems.push(
      `${REFERENCE_FILE} differs from the registered codes; if the change is intended, run node scripts/gates/error-registry.mjs --write`,
    );
  }
  return problems;
}

/** Gate failures for the adoption scan against the gate ledger. */
export function judgeAdoption(currentIds, ledger) {
  const { unlisted, fixed } = ratchet(ledger, currentIds);
  return [
    ...unlisted.map(
      (id) =>
        `${id.slice('adoption:'.length)} raises a hand-written error; declare its codes with defineErrors (jsails/errors)`,
    ),
    ...fixed.map(
      (id) =>
        `fixed: "${id}" is converted; remove it from error-registry.json to switch its lint on`,
    ),
  ];
}

function readReference(root) {
  const file = join(root, REFERENCE_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

export async function run({ repoRoot }) {
  const workspaces = listWorkspaces(repoRoot);
  const parseSync = await loadParser(repoRoot);
  const collected = await collectRegistry(parseSync, repoRoot, workspaces);
  return [
    ...judgeRegistry(collected, readReference(repoRoot)),
    ...judgeAdoption(
      scanAdoption(parseSync, repoRoot, workspaces),
      readGateLedger(name, { root: repoRoot }),
    ),
  ];
}

if (import.meta.main) {
  if (!process.argv.includes('--write')) {
    console.error('usage: node scripts/gates/error-registry.mjs --write');
    process.exit(2);
  }
  const collected = await collectRegistry(
    await loadParser(defaultRoot),
    defaultRoot,
    listWorkspaces(defaultRoot),
  );
  if (collected.failures.length > 0 || collected.conflicts.length > 0) {
    console.error(judgeRegistry(collected, {}).join('\n'));
    process.exit(1);
  }
  writeFileSync(
    join(defaultRoot, REFERENCE_FILE),
    await renderReference(defaultRoot, collected.codes),
  );
  console.log(`wrote ${REFERENCE_FILE} (${collected.codes.length} codes)`);
}
