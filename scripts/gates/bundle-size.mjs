/**
 * Client bundle sizes (`scripts/bundle-size/`): each fixture entry, bundled
 * for the browser with Rolldown, minified and gzipped, stays within
 * `scripts/bundle-budgets.json`, for the chunks a page loads up front and for
 * its lazy chunks. Deterministic, so the budgets are exact ceilings.
 */
import { compare, measureAll, readBudget } from '../bundle-size/index.mjs';

export const name = 'bundle-size';
export const description = 'gzip size of each client bundle fixture stays within its budget';
export const needsBuild = true;

export async function run({ repoRoot }) {
  const measured = await measureAll({ root: repoRoot });
  const { failures, notes } = compare(measured.sizes, readBudget());
  for (const note of notes) console.log(`note: ${note}`);
  return failures;
}
