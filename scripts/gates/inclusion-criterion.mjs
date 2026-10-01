/**
 * `api/criteria.json` classifies every workspace and entry point, the stability
 * table of `website/content/docs/versioning.md` matches it, and the 1.0
 * inclusion criterion (`scripts/api-report-criteria.mjs`) ratchets against
 * `scripts/expected-failures/inclusion-criterion.json`: a newly missing piece
 * fails, and a listed piece that is now present fails until its entry is
 * removed.
 */
import { join } from 'node:path';

import { buildModel } from '../api-report.mjs';
import {
  evaluate,
  exportIndex,
  gatherEvidence,
  structuralProblems,
} from '../api-report-criteria.mjs';
import { ratchet, readGateLedger } from '../expected-failures.mjs';

export const name = 'inclusion-criterion';
export const description =
  'every entry is classified and the 1.0 inclusion criterion may only improve';
export const needsBuild = true;

/** Gate failures for the missing criterion pieces against a gate ledger. */
export function judge(missing, ledger) {
  const { unlisted, fixed } = ratchet(ledger, missing);
  return [
    ...unlisted.map(
      (id) => `newly missing: ${id} (see the criterion in scripts/api-report-criteria.mjs)`,
    ),
    ...fixed.map((id) => `now met: "${id}"; remove it from inclusion-criterion.json`),
  ];
}

export async function run({ repoRoot }) {
  const { problems, criteria, workspaces } = structuralProblems(repoRoot);
  if (problems.length > 0) return problems;
  const model = await buildModel({ root: repoRoot });
  const { missing } = evaluate(criteria, workspaces, gatherEvidence(repoRoot), exportIndex(model));
  const ledger = readGateLedger(name, {
    root: repoRoot,
    dir: join(repoRoot, 'scripts', 'expected-failures'),
  });
  return judge(missing, ledger);
}
