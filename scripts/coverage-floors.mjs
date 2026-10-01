/**
 * The per-workspace coverage floors in `coverage-floors.json`.
 *
 * `scripts/run-tests.mjs --coverage` measures each workspace's `dist/src`
 * coverage (lines, branches, functions), writes it to
 * `test-results/coverage/<workspace>.json`, and fails when a metric is below
 * the workspace's floor. A floor is a reviewed number: raise it in the same
 * change that adds coverage; lowering one is a visible diff in review. A new
 * workspace has no floor until one is recorded here: it is measured and
 * reported, not failed, so adding a package needs no root edit.
 *
 * Usage:
 *   node scripts/coverage-floors.mjs --write   set every measured workspace's floor
 *                                              from test-results/coverage/ (one point
 *                                              below the measurement, rounded down)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readWorkspaces, repoRoot } from './workspaces.mjs';

export const FLOORS_FILE = join(repoRoot, 'coverage-floors.json');
export const METRICS = Object.freeze(['lines', 'branches', 'functions']);
/** Points between a measurement and the floor written from it: run-to-run jitter. */
export const MARGIN = 1;

/** The floor for one measured percentage. */
export function floorFor(measured) {
  return Math.max(0, Math.floor(measured) - MARGIN);
}

/**
 * Problems with a parsed floors document against the workspace names: a floor
 * for something that is not a workspace, or a malformed one. A workspace
 * without a floor is not a problem (see the header).
 */
export function validateFloors(document, workspaceNames) {
  const errors = [];
  if (
    document === null ||
    typeof document !== 'object' ||
    typeof document.workspaces !== 'object'
  ) {
    return [
      'coverage-floors.json must be { "workspaces": { "<name>": { lines, branches, functions } } }',
    ];
  }
  for (const [name, floor] of Object.entries(document.workspaces)) {
    if (!workspaceNames.includes(name)) errors.push(`${name}: not a workspace`);
    for (const metric of METRICS) {
      const value = floor?.[metric];
      if (typeof value !== 'number' || value < 0 || value > 100) {
        errors.push(`${name}: "${metric}" must be a percentage`);
      }
    }
    for (const key of Object.keys(floor ?? {})) {
      if (!METRICS.includes(key)) errors.push(`${name}: unknown key "${key}"`);
    }
  }
  return errors;
}

/** The floors document with every measured workspace's floor replaced. */
export function withMeasurements(document, measurements) {
  const workspaces = { ...document.workspaces };
  for (const measured of measurements) {
    workspaces[measured.workspace] = Object.fromEntries(
      METRICS.map((metric) => [metric, floorFor(measured[metric])]),
    );
  }
  const sorted = Object.fromEntries(
    Object.entries(workspaces).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return { workspaces: sorted };
}

function main() {
  if (!process.argv.includes('--write')) {
    console.error('Usage: node scripts/coverage-floors.mjs --write');
    process.exit(2);
  }
  const dir = join(repoRoot, 'test-results', 'coverage');
  const measurements = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
        .filter((record) => METRICS.every((metric) => typeof record[metric] === 'number'))
    : [];
  if (measurements.length === 0) {
    console.error(
      'No measurements in test-results/coverage/; run the tests with --coverage first.',
    );
    process.exit(1);
  }
  const current = existsSync(FLOORS_FILE)
    ? JSON.parse(readFileSync(FLOORS_FILE, 'utf8'))
    : { workspaces: {} };
  const next = withMeasurements(current, measurements);
  const errors = validateFloors(next, [...readWorkspaces().keys()]);
  writeFileSync(FLOORS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote floors for ${measurements.length} workspace(s) to coverage-floors.json.`);
  for (const error of errors) console.error(`  ${error}`);
  if (errors.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
