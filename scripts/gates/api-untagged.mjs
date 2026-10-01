/**
 * Tier and TSDoc findings of the API report ratchet against
 * `scripts/expected-failures/api-untagged.json`: a declaration exported without
 * a tier tag or summary, a `@public` declaration naming an `@internal` one, an
 * `@experimental` export outside an `/experimental` entry, or one name bound to
 * two declarations fails unless listed, and a listed finding that is gone fails
 * until its entry is removed.
 */
import { join } from 'node:path';

import { readGateLedger, ratchet } from '../expected-failures.mjs';
import { buildModel, findings } from '../api-report.mjs';

export const name = 'api-untagged';
export const description = 'API tier and TSDoc findings may only shrink';
export const needsBuild = true;

const HINTS = Object.freeze({
  untagged: 'tag and document the export',
  undocumented: 'tag and document the export',
  'conflicting-tiers': 'keep one tier tag',
  'public-uses-internal': 'make every declaration it names public',
  'experimental-outside': 'export it from an /experimental entry',
  duplicate: 'give the name one declaration',
});

/** Gate failures for the current findings against a gate ledger. */
export function judge(current, ledger) {
  const byId = new Map(current.map((finding) => [finding.id, finding]));
  const { unlisted, fixed } = ratchet(
    ledger,
    current.map((finding) => finding.id),
  );
  return [
    ...unlisted.map((id) => {
      const { message, kind } = byId.get(id);
      return `new finding: ${message} (${HINTS[kind] ?? 'see scripts/api-report.mjs'})`;
    }),
    ...fixed.map((id) => `fixed: "${id}" no longer occurs; remove it from api-untagged.json`),
  ];
}

export async function run({ repoRoot }) {
  const model = await buildModel({ root: repoRoot });
  return judge(
    findings(model),
    readGateLedger(name, { root: repoRoot, dir: join(repoRoot, 'scripts', 'expected-failures') }),
  );
}
