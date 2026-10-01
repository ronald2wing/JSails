/**
 * The import-graph tool (needs a build): measures what every public entry and
 * every scenario process loads, and reports it.
 *
 * Usage: node scripts/import-graph/index.mjs              table of entries and scenarios
 *        node scripts/import-graph/index.mjs --check      the loaded-set gate's verdict
 *        node scripts/import-graph/index.mjs --write      record new ceilings, lower the others
 *        node scripts/import-graph/index.mjs --deps       dependency-to-subpath import map
 *        node scripts/import-graph/index.mjs --json       the measurement as JSON
 *        ... --only jsails/app,cli-help                   measure only these names
 *
 * The dependency map answers "which public subpaths load this package, and
 * which first-party module imports it": for every third-party package any
 * entry or scenario enters, plus core's declared dependencies that nothing
 * loads (installed into every app for no measured reason).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { readGateLedger } from '../expected-failures.mjs';
import { repoRoot } from '../workspaces.mjs';
import { judge, lowerBudgets } from './judge.mjs';
import { measure } from './measure.mjs';
import { ENTRIES, SCENARIOS } from './policy.mjs';

export const BUDGETS_FILE = join(import.meta.dirname, 'budgets.json');

/** The parsed module ceilings. */
export function readBudgets(file = BUDGETS_FILE) {
  const budgets = JSON.parse(readFileSync(file, 'utf8'));
  return { node: budgets.node, entries: budgets.entries ?? {}, scenarios: budgets.scenarios ?? {} };
}

/**
 * The dependency-to-subpath import map of a measurement:
 * `[{ package, loadedBy: [{ name, importer }] }]` sorted by package, then the
 * names of `declared` packages no measured name loads.
 */
export function dependencyMap(measurement, declared = [], root = repoRoot) {
  const map = new Map();
  for (const [name, summary] of measurement.loaded) {
    for (const [pkg, importer] of summary.entered) {
      if (!map.has(pkg)) map.set(pkg, []);
      map.get(pkg).push({ name, importer: relative(root, importer) });
    }
  }
  const loaded = new Set();
  for (const summary of measurement.loaded.values()) {
    for (const pkg of summary.packages.keys()) loaded.add(pkg);
  }
  return {
    packages: [...map]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([pkg, loadedBy]) => ({ package: pkg, loadedBy })),
    unused: declared.filter((pkg) => !loaded.has(pkg)).sort(),
  };
}

function printTable(measurement) {
  const rows = [...measurement.loaded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, summary] of rows) {
    const tier = (ENTRIES[name] ?? SCENARIOS[name])?.tier ?? '?';
    const entered = [...summary.entered.keys()].sort().join(', ');
    console.log(
      `${name.padEnd(width)}  ${tier.padEnd(7)} ${String(summary.modules).padStart(5)}  ${entered}`,
    );
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      deps: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      only: { type: 'string' },
    },
    strict: true,
  });
  const only = values.only?.split(',').map((name) => name.trim());
  const measurement = await measure({ root: repoRoot, only });

  if (values.write) {
    if (only !== undefined) throw new Error('--write measures everything; drop --only');
    const next = lowerBudgets(readBudgets(), measurement, { scenarios: SCENARIOS });
    writeFileSync(BUDGETS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${relative(repoRoot, BUDGETS_FILE)}`);
    return 0;
  }
  if (values.check) {
    const { failures, notes } = judge(measurement, {
      entries: ENTRIES,
      scenarios: SCENARIOS,
      budgets: readBudgets(),
      ledger: readGateLedger('import-graph'),
    });
    for (const note of notes) console.log(`note: ${note}`);
    for (const failure of failures) console.error(failure);
    return failures.length === 0 ? 0 : 1;
  }
  if (values.deps) {
    const core = JSON.parse(readFileSync(join(repoRoot, 'core', 'package.json'), 'utf8'));
    const map = dependencyMap(measurement, Object.keys(core.dependencies ?? {}));
    if (values.json) {
      console.log(JSON.stringify(map, null, 2));
      return 0;
    }
    for (const { package: pkg, loadedBy } of map.packages) {
      console.log(`${pkg}`);
      for (const { name, importer } of loadedBy) console.log(`  ${name}  <- ${importer}`);
    }
    if (map.unused.length > 0) {
      console.log(`\ncore dependencies no entry or scenario loads: ${map.unused.join(', ')}`);
    }
    return 0;
  }
  if (values.json) {
    const plain = Object.fromEntries(
      [...measurement.loaded].map(([name, summary]) => [
        name,
        {
          modules: summary.modules,
          builtins: [...summary.builtins].sort(),
          packages: Object.fromEntries(summary.packages),
          entered: Object.fromEntries(
            [...summary.entered].map(([pkg, file]) => [pkg, relative(repoRoot, file)]),
          ),
        },
      ]),
    );
    console.log(JSON.stringify(plain, null, 2));
    return 0;
  }
  printTable(measurement);
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
