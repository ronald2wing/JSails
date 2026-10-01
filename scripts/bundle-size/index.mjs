/**
 * Client bundle sizes (needs a build): every fixture entry in `fixtures/` is
 * bundled for the browser with Rolldown (core's own bundler), minified, and
 * gzipped, and its sizes are compared with `scripts/bundle-budgets.json`.
 *
 * A fixture reports two numbers, in gzip bytes: `initial`, the entry chunk and
 * every chunk it imports statically (what a page downloads before the client
 * starts), and `lazy`, every chunk loaded through `import()` (Turbo, the
 * editor). Entries are bundled under the starters' entry rule,
 * `preserveEntrySignatures: 'strict'`: a chunk never imports the entry, so a
 * module a lazy chunk shares with the entry is a chunk of its own, counted in
 * `initial`. Bundling is deterministic for a given Rolldown and zlib, so a
 * budget is an exact ceiling: growth is a reviewed edit of the budget file,
 * and a shrink is recorded with `--write`.
 *
 * Usage: node scripts/bundle-size/index.mjs           table of every fixture
 *        node scripts/bundle-size/index.mjs --check   compare with the budgets
 *        node scripts/bundle-size/index.mjs --write   record new budgets, lower the others
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { repoRoot } from '../workspaces.mjs';

export const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
export const BUDGET_FILE = join(repoRoot, 'scripts', 'bundle-budgets.json');

/** Rolldown, resolved from core (its dependency). */
export async function loadRolldown(root = repoRoot) {
  const require = createRequire(join(root, 'core', 'package.json'));
  const module = await import(pathToFileURL(require.resolve('rolldown')).href);
  const version = JSON.parse(
    readFileSync(require.resolve('rolldown/package.json'), 'utf8'),
  ).version;
  return { rolldown: module.rolldown, version };
}

/** The fixture files in `dir`, sorted, as `{ name, file }`. */
export function fixtureFiles(dir = FIXTURES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.mjs'))
    .sort()
    .map((file) => ({ name: basename(file, '.mjs'), file: join(dir, file) }));
}

/** Gzip size of one chunk's code. */
function gzipBytes(code) {
  return gzipSync(code, { level: 9 }).length;
}

/**
 * Bundles one fixture: `{ initial, lazy, chunks }`, sizes in gzip bytes.
 * `chunks` lists `{ file, gzip, initial }` for each output chunk.
 */
export async function measureFixture(rolldown, file, { cwd = repoRoot } = {}) {
  const bundle = await rolldown({
    input: file,
    cwd,
    platform: 'browser',
    preserveEntrySignatures: 'strict',
    logLevel: 'silent',
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  });
  try {
    const { output } = await bundle.generate({ format: 'es', minify: true });
    const chunks = output.filter((item) => item.type === 'chunk');
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const initial = new Set();
    const queue = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
    while (queue.length > 0) {
      const name = queue.shift();
      if (initial.has(name)) continue;
      initial.add(name);
      queue.push(...(byName.get(name)?.imports ?? []));
    }
    const measured = chunks
      .map((chunk) => ({
        // Chunk names carry a content hash; the stable part names the chunk.
        file: chunk.fileName.replace(/-[\w-]{8}\.js$/, '.js'),
        gzip: gzipBytes(chunk.code),
        initial: initial.has(chunk.fileName),
      }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return {
      initial: measured
        .filter((chunk) => chunk.initial)
        .reduce((sum, chunk) => sum + chunk.gzip, 0),
      lazy: measured.filter((chunk) => !chunk.initial).reduce((sum, chunk) => sum + chunk.gzip, 0),
      chunks: measured,
    };
  } finally {
    await bundle.close();
  }
}

/** Measures every fixture: `{ name: { initial, lazy, chunks } }`. */
export async function measureAll({ root = repoRoot, dir = FIXTURES_DIR } = {}) {
  const { rolldown, version } = await loadRolldown(root);
  const sizes = {};
  for (const { name, file } of fixtureFiles(dir)) {
    sizes[name] = await measureFixture(rolldown, file, { cwd: root });
  }
  return { rolldown: version, sizes };
}

/** Reads the budgets; a missing file is an empty budget. */
export function readBudget(file = BUDGET_FILE) {
  if (!existsSync(file)) return { fixtures: {} };
  const budget = JSON.parse(readFileSync(file, 'utf8'));
  return { ...budget, fixtures: budget.fixtures ?? {} };
}

/** The gate's verdict for measured sizes against a budget: `{ failures, notes }`. */
export function compare(sizes, budget) {
  const failures = [];
  const notes = [];
  for (const [name, size] of Object.entries(sizes)) {
    const limits = budget.fixtures[name];
    if (limits === undefined) {
      failures.push(
        `${name}: no budget (initial ${size.initial} B, lazy ${size.lazy} B gzip); record it with node scripts/bundle-size/index.mjs --write`,
      );
      continue;
    }
    for (const part of ['initial', 'lazy']) {
      if (size[part] > limits[part]) {
        failures.push(
          `${name}: ${part} chunks are ${size[part]} B gzip, above the budget of ${limits[part]} B; shrink the bundle, or raise the budget in scripts/bundle-budgets.json with the reason in the commit`,
        );
      } else if (size[part] < limits[part]) {
        notes.push(
          `${name}: ${part} chunks are ${size[part]} B gzip, below the budget of ${limits[part]} B; lower it with --write`,
        );
      }
    }
  }
  for (const name of Object.keys(budget.fixtures)) {
    if (sizes[name] === undefined) failures.push(`${name} has a budget but no fixture; remove it`);
  }
  return { failures, notes };
}

/** Budgets after a `--write`: new fixtures recorded, existing ones only lowered. */
export function lowerBudget(budget, measured, node = process.version) {
  const fixtures = {};
  for (const [name, size] of Object.entries(measured.sizes)) {
    const previous = budget.fixtures[name];
    fixtures[name] = {
      initial: previous === undefined ? size.initial : Math.min(previous.initial, size.initial),
      lazy: previous === undefined ? size.lazy : Math.min(previous.lazy, size.lazy),
    };
  }
  return { node, rolldown: measured.rolldown, fixtures };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const measured = await measureAll();
  const budget = readBudget();
  if (values.write) {
    writeFileSync(BUDGET_FILE, `${JSON.stringify(lowerBudget(budget, measured), null, 2)}\n`);
    console.log(`wrote ${relative(repoRoot, BUDGET_FILE)}`);
    return 0;
  }
  if (values.check) {
    const { failures, notes } = compare(measured.sizes, budget);
    for (const note of notes) console.log(`note: ${note}`);
    for (const failure of failures) console.error(failure);
    return failures.length === 0 ? 0 : 1;
  }
  if (values.json) {
    console.log(JSON.stringify(measured, null, 2));
    return 0;
  }
  for (const [name, size] of Object.entries(measured.sizes)) {
    console.log(
      `${name.padEnd(20)} initial ${String(size.initial).padStart(7)} B  lazy ${String(size.lazy).padStart(7)} B (gzip)`,
    );
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
