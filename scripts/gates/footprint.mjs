/**
 * Install footprint per workspace (`scripts/footprint.mjs`): the production
 * dependency closure of every workspace, counted from `package-lock.json` and
 * measured on disk, may not grow past `scripts/footprint-budget.json`. A
 * budget only moves down (`node scripts/footprint.mjs --write`); raising one
 * is an explicit edit. A workspace without a budget is reported, not failed,
 * so a new package needs no edit here. Budgets name the platform they were
 * taken on and are compared only there.
 */
import { checkWorkspaces, readBudget } from '../footprint.mjs';

export const name = 'footprint';
export const description =
  'the production install closure of each workspace stays within its package and byte budget';
export const needsBuild = false;

export function run({ repoRoot }) {
  const { failures, notes } = checkWorkspaces({ root: repoRoot, budget: readBudget() });
  for (const note of notes) console.log(`note: ${note}`);
  return failures;
}
