/**
 * The dependency cache of the CI install step
 * (`.github/actions/install-dependencies`): the key and paths of the tree one
 * `npm ci` produces, and the check a restored tree passes before it is used.
 *
 * `npm ci` installs the tree a lockfile describes after checking it against
 * the manifests that lockfile names (the root's, every workspace's, and every
 * `file:` link target's) and against the workspaces the root's `workspaces`
 * globs match, and fails when one disagrees. The key therefore hashes the
 * lockfile, each of those manifests, the manifest of every glob-matched
 * workspace (a package added under `packages/` without a relock is in no
 * lockfile entry, and `npm ci` refuses it as missing from the lock), the
 * directory's `.npmrc` (`engine-strict`), whether lifecycle scripts run, and
 * the exact Node version, which fixes the bundled npm and the native ABI; the
 * workflow adds the runner's OS and architecture. Equal keys mean an `npm ci`
 * given the same inputs on the same platform, which succeeded when the entry
 * was saved: a manifest edited, added or removed out of step with the
 * lockfile changes the key, so the step installs and `npm ci` reports the
 * mismatch as it always did. A restore never falls back to a partial match,
 * which would be another tree.
 *
 * The paths are every `node_modules` directory the lockfile places (the root
 * one and any nested under a workspace, such as `packages/filesystem`), so a
 * restore brings back the whole tree.
 *
 * Workspaces and `file:` dependencies are links in the tree (symlinks, or
 * junctions on Windows). An archive tool that stored one as a copy, or that
 * restored it pointing elsewhere, would hand the build a stale package, so a
 * restored tree is used only when every such entry is a link that resolves to
 * its target and every tree root exists; otherwise the step discards it and
 * installs.
 *
 * Usage:
 *   node scripts/ci-dependencies.mjs inputs <dir> <lifecycle-scripts: true|false>
 *     writes `key` and `paths` (relative to the current directory) to
 *     $GITHUB_OUTPUT, or prints them when it is unset
 *   node scripts/ci-dependencies.mjs verify <dir>
 *     names each problem and exits 1 when the restored tree is unusable, or
 *     prints that it is usable
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import { readManifest, workspaceDirs } from './workspaces.mjs';

const NODE_MODULES = 'node_modules';

/** The `node_modules` directory a lockfile key is installed in, or null for a manifest key. */
function treeRootOf(key) {
  if (key === NODE_MODULES || key.startsWith(`${NODE_MODULES}/`)) return NODE_MODULES;
  const at = key.indexOf(`/${NODE_MODULES}/`);
  return at === -1 ? null : `${key.slice(0, at)}/${NODE_MODULES}`;
}

/** The lockfile's keys for the packages `npm ci` reads a manifest of: root, workspaces, link targets. */
export function manifestKeys(lock) {
  return Object.keys(lock.packages ?? {})
    .filter((key) => treeRootOf(key) === null)
    .sort();
}

/**
 * The workspaces the `workspaces` globs of `dir`'s manifest match, relative to
 * `dir`, whether or not the lockfile lists them; none for a manifest without
 * workspaces (the docs site).
 */
export function globbedWorkspaceKeys(dir) {
  if (!Array.isArray(readManifest(dir).workspaces)) return [];
  return workspaceDirs(dir)
    .map((workspace) => relative(dir, workspace).split(sep).join(posix.sep))
    .sort();
}

/** Every `node_modules` directory the lockfile places, relative to its directory. */
export function treeRoots(lock) {
  const roots = new Set();
  for (const key of Object.keys(lock.packages ?? {})) {
    const root = treeRootOf(key);
    if (root !== null) roots.add(root);
  }
  return [...roots].sort();
}

/** The digest of everything the tree `npm ci` produces in `dir` depends on, besides the platform. */
export function installDigest(dir, { lifecycleScripts, nodeVersion = process.version }) {
  const hash = createHash('sha256');
  const part = (label, content) => {
    const bytes = content === null ? null : Buffer.from(content);
    hash.update(`${label}\0${bytes === null ? 'absent' : bytes.length}\0`);
    if (bytes !== null) hash.update(bytes);
  };
  const read = (file) => (existsSync(file) ? readFileSync(file) : null);
  const lockText = readFileSync(join(dir, 'package-lock.json'));
  part('node', nodeVersion);
  part('lifecycle-scripts', String(lifecycleScripts));
  part('package-lock.json', lockText);
  part('.npmrc', read(join(dir, '.npmrc')));
  const keys = new Set([
    ...manifestKeys(JSON.parse(lockText.toString('utf8'))),
    ...globbedWorkspaceKeys(dir),
  ]);
  for (const key of [...keys].sort()) {
    part(`${key}/package.json`, read(join(dir, key, 'package.json')));
  }
  return hash.digest('hex');
}

/** The cache key (without the platform, which the workflow adds) and paths for `dir`. */
export function cacheInputs(dir, { lifecycleScripts, cwd = process.cwd(), nodeVersion }) {
  const target = resolve(cwd, dir);
  const lock = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'));
  const base = relative(cwd, target).split(sep).join(posix.sep);
  const label = base === '' ? 'root' : base.replace(/[^\w.-]+/g, '-');
  const version = (nodeVersion ?? process.version).replace(/^v/, '');
  const digest = installDigest(target, { lifecycleScripts, nodeVersion: version });
  return {
    key: `${label}-node${version}-${digest}`,
    paths: treeRoots(lock).map((root) => posix.normalize(posix.join(base || '.', root))),
  };
}

/** Why the tree restored in `dir` is not the tree `npm ci` would produce there; empty when it is. */
export function treeProblems(dir) {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const problems = [];
  for (const root of treeRoots(lock)) {
    if (!existsSync(join(dir, root))) problems.push(`${root}: missing`);
  }
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.link !== true) continue;
    const path = join(dir, key);
    let isLink;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      problems.push(`${key}: missing`);
      continue;
    }
    if (!isLink) {
      problems.push(`${key}: not a link`);
      continue;
    }
    let resolved;
    try {
      resolved = realpathSync(path) === realpathSync(resolve(dir, entry.resolved));
    } catch {
      resolved = false;
    }
    if (!resolved) problems.push(`${key}: does not resolve to ${entry.resolved}`);
  }
  return problems;
}

/** How many workspace and `file:` links the lockfile in `dir` places. */
function linkCount(dir) {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  return Object.values(lock.packages ?? {}).filter((entry) => entry.link === true).length;
}

/** Writes `name=value` outputs to $GITHUB_OUTPUT, or prints them when it is unset. */
function writeOutputs(outputs, env) {
  const lines = [];
  for (const [name, value] of Object.entries(outputs)) {
    if (!value.includes('\n')) {
      lines.push(`${name}=${value}`);
      continue;
    }
    const delimiter = `EOF_${randomUUID()}`;
    lines.push(`${name}<<${delimiter}`, value, delimiter);
  }
  const text = `${lines.join('\n')}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

const USAGE = 'Usage: node scripts/ci-dependencies.mjs inputs <dir> <true|false> | verify <dir>';

/** Runs one command; returns the exit status. */
export function main(args, { env = process.env } = {}) {
  const [command, dir, lifecycle] = args;
  if (
    command === 'inputs' &&
    dir !== undefined &&
    (lifecycle === 'true' || lifecycle === 'false')
  ) {
    const { key, paths } = cacheInputs(dir, { lifecycleScripts: lifecycle === 'true' });
    writeOutputs({ key, paths: paths.join('\n') }, env);
    return 0;
  }
  if (command === 'verify' && dir !== undefined && lifecycle === undefined) {
    const problems = treeProblems(dir);
    for (const problem of problems) console.error(`restored tree: ${problem}`);
    if (problems.length > 0) return 1;
    // Said in so many words because the job log also shows the step's script,
    // whose failure branch holds the warning text.
    console.log(
      `restored tree: usable, each of its ${linkCount(dir)} links resolves to its target`,
    );
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
