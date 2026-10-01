/**
 * The docs compile gate (`website/scripts/check-docs.mjs`) in report-only mode:
 * every docs, AGENTS.md, and starter-guide sample is compiled against the built
 * workspaces, marked references are resolved against the API report, and each
 * published entry needs a compiled sample. Today's findings are listed in
 * `scripts/expected-failures/docs.json`; a new finding fails, and a listed one
 * that is gone fails until its entry is removed.
 */
import { join } from 'node:path';

import { readGateLedger } from '../expected-failures.mjs';
import { checkDocs, judge } from '../../website/scripts/check-docs.mjs';

export const name = 'docs';
export const description = 'Docs samples compile; findings may only shrink';
export const needsBuild = true;

export async function run({ repoRoot }) {
  const result = await checkDocs({ repoRoot });
  return judge(
    result,
    readGateLedger(name, { root: repoRoot, dir: join(repoRoot, 'scripts', 'expected-failures') }),
  );
}
