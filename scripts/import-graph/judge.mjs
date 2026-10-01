/**
 * Judges a loaded-set measurement (`measure.mjs`) against the policy, the
 * module ceilings and the gate ledger. Pure: every input is passed in, so the
 * gate's tests drive it with fixture measurements.
 *
 * Violation ids (the keys of `scripts/expected-failures/import-graph.json`):
 *
 * - `<name> enters <package>`: an entry or scenario process imports a
 *   third-party package from first-party code that its tier does not allow;
 * - `<entry> reaches <package | node:x> in its browser closure`: a
 *   browser-tier entry's static or lazy closure reaches a builtin, or a package
 *   outside its allowlist that it does not already load eagerly;
 * - `<entry> is browser tier but core does not declare it browser-safe`.
 *
 * Direct failures (never ledger entries, because the fix is in this tooling):
 * an entry with no tier, a tier for an entry that does not exist, a module
 * count above its ceiling, a missing or stale ceiling, and a subpath core
 * declares browser-safe that the policy does not place in the browser tier.
 * An entry of an unsettled workspace (`UNSETTLED` in `policy.mjs`) has no
 * ceiling, and a missing tier for it is a note.
 */
import { ratchet } from '../expected-failures.mjs';
import { TIERS, UNSETTLED, allowedPackages } from './policy.mjs';

/** The names of the measured entries that belong to an unsettled workspace. */
function unsettledNames(measurement, unsettled) {
  return new Set(
    measurement.entries
      .filter((entry) => unsettled[entry.workspace] !== undefined)
      .map((entry) => entry.entry),
  );
}

/** Current violations of a measurement: `[{ id, message }]`, sorted by id. */
export function violations(measurement, { entries, scenarios, tiers = TIERS }) {
  const found = [];
  const manifests = new Map(measurement.workspaces.map((w) => [w.name, w.manifest]));
  for (const [name, summary] of measurement.loaded) {
    const policy = entries[name] ?? scenarios[name];
    if (policy === undefined) continue;
    const allowed = allowedPackages(policy, manifests.get(summary.workspace), tiers);
    for (const [pkg, importer] of summary.entered) {
      if (allowed.has(pkg)) continue;
      found.push({
        id: `${name} enters ${pkg}`,
        message: `${name} (${policy.tier} tier) loads ${pkg}, imported by ${importer}`,
      });
    }
  }
  for (const [entry, closure] of measurement.closures) {
    const allowed = allowedPackages(entries[entry], undefined, tiers);
    const eager = measurement.loaded.get(entry)?.entered ?? new Map();
    for (const builtin of closure.builtins) {
      found.push({
        id: `${entry} reaches ${builtin} in its browser closure`,
        message: `${entry} is browser tier, but its closure imports ${builtin}`,
      });
    }
    for (const pkg of closure.packages) {
      // An eagerly loaded package is already judged as `enters`.
      if (allowed.has(pkg) || eager.has(pkg)) continue;
      found.push({
        id: `${entry} reaches ${pkg} in its browser closure`,
        message: `${entry} is browser tier, but its closure imports ${pkg}, which is not in its allowlist`,
      });
    }
  }
  if (measurement.declared !== undefined) {
    const declared = new Set(measurement.declared);
    for (const [entry, policy] of Object.entries(entries)) {
      if (policy.tier !== 'browser' || !entry.startsWith('jsails') || declared.has(entry)) continue;
      if (!measurement.entries.some((candidate) => candidate.entry === entry)) continue;
      found.push({
        id: `${entry} is browser tier but core does not declare it browser-safe`,
        message: `${entry} is browser tier in the policy but missing from core's BROWSER_SAFE_SUBPATHS`,
      });
    }
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Gate verdict: `{ failures, notes }`. `budgets` is the parsed
 * `budgets.json`; `ledger` the gate ledger; `tiers` defaults to the policy's.
 */
export function judge(
  measurement,
  { entries, scenarios, tiers = TIERS, budgets, ledger, unsettled = UNSETTLED },
) {
  const failures = [];
  const notes = [];
  const names = new Set(measurement.entries.map((entry) => entry.entry));
  const open = unsettledNames(measurement, unsettled);

  for (const name of names) {
    if (entries[name] !== undefined) continue;
    if (open.has(name)) {
      notes.push(`${name} has no tier yet; its workspace is unsettled`);
    } else {
      failures.push(`${name} has no tier: place it in scripts/import-graph/policy.mjs`);
    }
  }
  for (const name of Object.keys(entries)) {
    if (!names.has(name)) failures.push(`policy entry ${name} is no public entry; remove it`);
  }
  if (measurement.declared !== undefined) {
    for (const entry of measurement.declared) {
      if (entries[entry]?.tier !== 'browser') {
        failures.push(
          `${entry} is declared browser-safe by core but is not browser tier in the policy`,
        );
      }
    }
  }

  const current = violations(measurement, { entries, scenarios, tiers });
  const byId = new Map(current.map((violation) => [violation.id, violation]));
  const { unlisted, fixed } = ratchet(
    ledger,
    current.map((violation) => violation.id),
  );
  for (const id of unlisted) failures.push(`new violation: ${byId.get(id).message}`);
  for (const id of fixed) {
    failures.push(`fixed: "${id}" no longer occurs; remove it from import-graph.json`);
  }

  const ceilings = { ...budgets.entries, ...budgets.scenarios };
  for (const [name, summary] of measurement.loaded) {
    if (open.has(name)) {
      if (ceilings[name] !== undefined) {
        failures.push(
          `budgets.json lists ${name}, whose workspace is unsettled; remove its ceiling`,
        );
      }
      continue;
    }
    const ceiling = ceilings[name];
    if (ceiling === undefined) {
      failures.push(
        `${name} has no module ceiling (loads ${summary.modules}); record it with node scripts/import-graph/index.mjs --write`,
      );
    } else if (summary.modules > ceiling) {
      failures.push(
        `${name} loads ${summary.modules} modules, above its ceiling of ${ceiling}; import less, or raise the ceiling in scripts/import-graph/budgets.json with the reason in the commit`,
      );
    } else if (summary.modules < ceiling) {
      notes.push(
        `${name} loads ${summary.modules} modules, below its ceiling of ${ceiling}; lower it with node scripts/import-graph/index.mjs --write`,
      );
    }
  }
  const measured = new Set(measurement.loaded.keys());
  for (const name of Object.keys(budgets.entries)) {
    if (!names.has(name)) failures.push(`budgets.json lists ${name}, which is no public entry`);
  }
  for (const name of Object.keys(budgets.scenarios)) {
    if (scenarios[name] === undefined) failures.push(`budgets.json lists unknown scenario ${name}`);
  }
  for (const name of [...names, ...Object.keys(scenarios)]) {
    if (!measured.has(name)) failures.push(`${name} was not measured`);
  }
  return { failures, notes };
}

/**
 * Budgets after a `--write`: a new name is recorded at its measured count and
 * an existing ceiling only moves down. Names no longer measured, and entries
 * of unsettled workspaces, are dropped.
 */
export function lowerBudgets(
  budgets,
  measurement,
  { scenarios, node = process.version, unsettled = UNSETTLED },
) {
  const next = { node, entries: {}, scenarios: {} };
  const open = unsettledNames(measurement, unsettled);
  for (const [name, summary] of [...measurement.loaded].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (open.has(name)) continue;
    const section = scenarios[name] === undefined ? 'entries' : 'scenarios';
    const previous = budgets[section]?.[name];
    next[section][name] =
      previous === undefined ? summary.modules : Math.min(previous, summary.modules);
  }
  return next;
}
