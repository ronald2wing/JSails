/**
 * The access matrix holds its hard invariants over the framework's own apps
 * (`scripts/check-access.mjs`): every first-party plugin's fixture app and
 * every starter preset that serves HTTP, each surface asked by every
 * canonical actor through the real pipeline. A violation is either fixed or
 * pending in `scripts/expected-failures/access.json` with the package that
 * makes it hold; a pending one that holds fails until its entry is removed.
 */
import { main } from '../check-access.mjs';

export const name = 'access';
export const description =
  'the access matrix of every first-party plugin and starter preset holds its hard invariants; violations still pending are ledgered with the package that fixes them';
export const needsBuild = true;

export async function run({ repoRoot }) {
  const { status, messages } = await main({ root: repoRoot });
  return status === 0 ? [] : messages;
}
