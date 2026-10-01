/**
 * The committed CLI signature (`api/cli.md`) matches the generated help of
 * every built-in command in the built manifest (`scripts/cli-signature.mjs`).
 * A changed command surface is reviewed line by line, then recorded with
 * `node scripts/cli-signature.mjs --write`.
 */
import { main } from '../cli-signature.mjs';

export const name = 'cli-signature';
export const description = 'api/cli.md holds the generated help of every built-in jsails command';
export const needsBuild = true;

export async function run({ repoRoot }) {
  const { status, messages } = await main(['--check'], { root: repoRoot });
  return status === 0 ? [] : messages;
}
