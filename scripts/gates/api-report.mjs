/**
 * The committed API report (`api/**\/*.api.md`) matches what the built
 * declaration files export, and no entry's value exports exceed the budget its
 * report records (`scripts/api-report.mjs`).
 */
import { main } from '../api-report.mjs';

export const name = 'api-report';
export const description = 'api/*.api.md matches the built declarations and value budgets hold';
export const needsBuild = true;

export async function run({ repoRoot }) {
  const { status, messages } = await main(['--check'], { root: repoRoot });
  return status === 0 ? [] : messages;
}
