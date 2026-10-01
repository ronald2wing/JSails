/**
 * The final package map as a direction gate: every import in `core/src` is
 * judged against `scripts/import-graph/package-map.mjs` while the future
 * packages are still directories, and every import from `packages/<name>/src`
 * into code that will depend on that package is a cycle. Today's violations
 * are listed in `scripts/expected-failures/import-direction.json`, which may
 * only shrink: a new violation fails, and a listed one that is gone fails until
 * its entry is removed. KRN-22 empties the ledger and switches nothing else:
 * the gate is already failing for anything unlisted.
 */
import { listWorkspaces, loadParser } from '../api-report.mjs';
import { readGateLedger, ratchet } from '../expected-failures.mjs';
import { scanDirection } from '../import-graph/direction.mjs';
import { validateMap } from '../import-graph/package-map.mjs';

export const name = 'import-direction';
export const description =
  'core/src imports follow the final package map; violations may only shrink';
export const needsBuild = false;

/** A one-line explanation of a violation record. */
export function explain(violation) {
  if (violation.target.startsWith('npm:')) {
    return `${violation.file} (future ${violation.owner}) imports ${violation.target.slice(4)}, which neither ${violation.owner} nor a package it may import owns`;
  }
  return `${violation.file} (future ${violation.owner}) imports ${violation.target}, against the package map`;
}

/** Gate failures for a scan result against a gate ledger. */
export function judge({ violations, unplaced }, ledger, mapProblems = []) {
  const byId = new Map(violations.map((violation) => [violation.id, violation]));
  const { unlisted, fixed } = ratchet(
    ledger,
    violations.map((violation) => violation.id),
  );
  return [
    ...mapProblems.map((problem) => `package map: ${problem}`),
    ...unplaced.map(
      (file) => `${file} is in no future package: place it in scripts/import-graph/package-map.mjs`,
    ),
    ...unlisted.map(
      (id) =>
        `new violation: ${explain(byId.get(id))}; import through an allowed package or change the map`,
    ),
    ...fixed.map((id) => `fixed: "${id}" no longer occurs; remove it from import-direction.json`),
  ];
}

export async function run({ repoRoot }) {
  const parseSync = await loadParser(repoRoot);
  const scan = scanDirection(parseSync, {
    root: repoRoot,
    workspaces: listWorkspaces(repoRoot),
  });
  return judge(scan, readGateLedger(name, { root: repoRoot }), validateMap());
}
