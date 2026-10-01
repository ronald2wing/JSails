/**
 * The committed first-party route list (`api/routes.md`) matches what the
 * built framework and first-party plugins register: every route's kind,
 * methods, pattern, access, cross-site rule, owner and origin
 * (`scripts/route-registration.mjs`). A changed public surface is reviewed
 * line by line, then recorded with `node scripts/route-registration.mjs
 * --write`. How the pipeline answers each surface is the `access` gate's.
 */
import { main } from '../route-registration.mjs';

export const name = 'route-registration';
export const description =
  'api/routes.md lists every route the framework and its first-party plugins register, with its access, surface kind, credentials and owner';
export const needsBuild = true;

export async function run({ repoRoot }) {
  const { status, messages } = await main(['--check'], { root: repoRoot });
  return status === 0 ? [] : messages;
}
