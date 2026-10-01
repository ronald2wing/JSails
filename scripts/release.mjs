/**
 * The one publish path: `npm run release`.
 *
 * 1. Refuses unless the git working tree is clean (no modified, staged, or
 *    untracked files), so what is published is exactly a commit and never a
 *    local edit compiled into `dist/`.
 * 2. Runs the full gate (`npm run check`), which builds every workspace from
 *    clean.
 * 3. Publishes every public workspace in dependency order (the order
 *    `scripts/workspaces.mjs` derives), so a package never reaches the
 *    registry before a first-party package it depends on (step 6 moves the
 *    digest consumer last).
 * 4. Resumes: a workspace whose exact version is already on the registry is
 *    skipped, so re-running after a failure (an expired OTP, a network error)
 *    publishes only what is missing instead of failing on E403.
 * 5. Packs every public workspace into a temporary directory and records the
 *    SHA-256 of each tarball. Before `@jsails/admin-plugin-manager` is packed,
 *    the digests are written into its build as
 *    `dist/src/directory/first-party-digests.json` (a map from
 *    `<name>@<version>` to the hex digest), which its first-party plugin
 *    directory reads, so a directory install verifies the exact bytes this
 *    release publishes. A version already on the registry is hashed from the
 *    registry's own tarball (`npm pack <name>@<version>`), so a resumed
 *    release records what consumers actually download.
 * 6. Publishes those tarball files rather than re-packing, so the published
 *    bytes are the hashed bytes. The publish order is the dependency order
 *    with `@jsails/admin-plugin-manager` moved last (no workspace may depend
 *    on it): its digests name tarballs this run has not published yet, so if
 *    any earlier publish fails, the consumer stays off the registry, and the
 *    resumed release re-hashes whatever did reach the registry from the
 *    registry itself instead of trusting digests of local tarballs that a
 *    re-pack might not reproduce byte for byte.
 *
 * Publishing always uses `--ignore-scripts`: no lifecycle hook runs, so the
 * gate in step 2 is the only code that runs. `--provenance` (an npm provenance
 * attestation linking each tarball to its source commit and build) is passed
 * when running in GitHub Actions, where npm can obtain the OIDC token it needs
 * (`.github/workflows/release.yml`); pass `--provenance` to force it elsewhere
 * or `--no-provenance` to omit it.
 *
 * Flags:
 *   --dry-run          check the tree, pack, write the digests, and print the
 *                      publish plan; publish nothing (needs an existing build)
 *   --skip-check       skip step 2 (only when the same commit just passed it)
 *   --provenance / --no-provenance
 *
 * Usage: node scripts/release.mjs [flags]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { exitStatus, npm, run } from './subprocess.mjs';
import { readWorkspaces, repoRoot, topologicalOrder, workspaceGraph } from './workspaces.mjs';

/** A release stop with the exit status to report; thrown so cleanup still runs. */
class ReleaseStop extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function fail(message, status = 1) {
  throw new ReleaseStop(message, status);
}

/** Run a command quietly and return its outcome with output. */
function capture(cmd, args) {
  return run(cmd, args, { cwd: repoRoot, capture: true, forwardSignals: false });
}

async function assertCleanTree() {
  const status = await capture('git', ['status', '--porcelain', '--untracked-files=all']);
  if (status.code !== 0) fail('could not read git status');
  if (status.stdout.trim() !== '') {
    fail('the working tree has uncommitted or untracked files; commit or remove them first');
  }
}

/**
 * Read the outcome of `npm view <name>@<version> version --json` as `true`
 * (that exact version is on the registry), `false` (it is not), or `null` (the
 * answer is unreadable, so the release must stop rather than guess). Only
 * stdout is parsed: npm prints warnings and notices on stderr even on success,
 * and treating one of those as "already published" would skip the package and
 * end a partial release with exit 0. An existing package without that version
 * exits 0 with empty stdout; an unknown package exits non-zero with E404.
 */
export function registryHasVersion({ code, stdout, stderr }, version) {
  if (code !== 0) return /\bE404\b/.test(stderr) || /\bE404\b/.test(stdout) ? false : null;
  const text = stdout.trim();
  if (text === '') return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === version) return true;
  if (Array.isArray(parsed)) return parsed.includes(version);
  // A JSON error object (npm reports some failures on stdout with `--json`).
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const errorCode = parsed.error?.code;
    return errorCode === 'E404' ? false : null;
  }
  return typeof parsed === 'string' ? false : null;
}

/** The workspace whose build receives the first-party tarball digests. */
export const DIGEST_CONSUMER = '@jsails/admin-plugin-manager';
/** Where, inside the consumer's directory, the digests are written. */
export const DIGEST_FILE = join('dist', 'src', 'directory', 'first-party-digests.json');

/**
 * The plan with the digest consumer moved last, the order both packing and
 * publishing use. Throws when the consumer is missing or another planned
 * workspace depends on it, since moving it last would then publish a
 * dependent before its dependency.
 */
export function consumerLast(plan, graph) {
  const consumer = plan.find((entry) => entry.name === DIGEST_CONSUMER);
  if (consumer === undefined) {
    throw new Error(`${DIGEST_CONSUMER} is not a public workspace; update DIGEST_CONSUMER`);
  }
  const rest = plan.filter((entry) => entry !== consumer);
  const dependent = rest.find((entry) => graph.get(entry.name)?.has(DIGEST_CONSUMER));
  if (dependent !== undefined) {
    throw new Error(`${dependent.name} depends on ${DIGEST_CONSUMER}, which must publish last`);
  }
  return [...rest, consumer];
}

/** Lowercase hex SHA-256 of a file's bytes. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The tarball file name from `npm pack --json` stdout, which is an array with
 * one entry per packed spec. Anything else throws: guessing a file name could
 * hash and publish the wrong tarball.
 */
export function packedFilename(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('npm pack printed no JSON');
  }
  const filename = Array.isArray(parsed) && parsed.length === 1 ? parsed[0]?.filename : undefined;
  if (typeof filename !== 'string' || filename === '' || /[\\/]/.test(filename)) {
    throw new Error('npm pack did not report exactly one tarball');
  }
  return filename;
}

/**
 * Packs `spec` (a directory or a `name@version` registry spec) into
 * `destination` and returns the tarball's path and SHA-256. Lifecycle scripts
 * never run, matching publish.
 */
export async function packTarball(spec, destination) {
  const outcome = await run(
    npm,
    ['pack', spec, '--pack-destination', destination, '--json', '--ignore-scripts'],
    { cwd: repoRoot, capture: true, forwardSignals: false },
  );
  if (outcome.code !== 0) throw new Error(`npm pack ${spec} failed`);
  const file = join(destination, packedFilename(outcome.stdout));
  if (!existsSync(file)) throw new Error(`npm pack ${spec} reported a tarball it did not write`);
  return { file, sha256: sha256File(file) };
}

/**
 * Writes the digest map into `<dir>/<DIGEST_FILE>` with sorted keys, so the
 * file is the same for the same release whatever order packing ran in.
 */
export function writeDigests(dir, digests) {
  const sorted = Object.fromEntries(
    Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const path = join(dir, DIGEST_FILE);
  if (!existsSync(join(dir, 'dist', 'src', 'directory'))) {
    throw new Error(`${DIGEST_FILE} has no directory to land in; build ${DIGEST_CONSUMER} first`);
  }
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
  return path;
}

/** Whether `name@version` is already on the registry; stops the release when unsure. */
async function isPublished(name, version) {
  const outcome = await capture(npm, ['view', `${name}@${version}`, 'version', '--json']);
  const state = registryHasVersion(outcome, version);
  if (state === null) fail(`could not query the registry for ${name}@${version}`);
  return state;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'skip-check': { type: 'boolean', default: false },
      provenance: { type: 'boolean' },
      'no-provenance': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const provenance =
    !values['no-provenance'] && (values.provenance ?? process.env.GITHUB_ACTIONS === 'true');

  await assertCleanTree();

  if (!values['skip-check'] && !values['dry-run']) {
    const gate = await run(npm, ['run', 'check'], { cwd: repoRoot });
    if (gate.code !== 0) fail('npm run check failed', exitStatus(gate));
    // The gate must not have produced tracked or unignored files either.
    await assertCleanTree();
  }

  const workspaces = readWorkspaces();
  const graph = workspaceGraph(workspaces);
  let order;
  try {
    order = topologicalOrder(graph);
  } catch (error) {
    fail(error.message);
  }

  const dependencyOrder = [];
  for (const name of order) {
    const { dir, manifest } = workspaces.get(name);
    if (manifest.private === true) continue;
    if (!existsSync(join(dir, 'dist', 'src'))) fail(`${name} has no dist/src; run a build first`);
    dependencyOrder.push({ name, dir, version: manifest.version, onRegistry: false });
  }
  let plan;
  try {
    plan = consumerLast(dependencyOrder, graph);
  } catch (error) {
    fail(error.message);
  }
  for (const entry of plan) entry.onRegistry = await isPublished(entry.name, entry.version);

  const staging = mkdtempSync(join(tmpdir(), 'jsails-release-'));
  try {
    // The consumer is last, so every tarball its catalog can point at is
    // hashed before it is packed.
    const digests = {};
    for (const entry of plan) {
      const spec = entry.onRegistry ? `${entry.name}@${entry.version}` : entry.dir;
      try {
        if (entry.name === DIGEST_CONSUMER && !entry.onRegistry) {
          const path = writeDigests(entry.dir, digests);
          console.log(`release: wrote ${Object.keys(digests).length} digests to ${path}`);
        }
        const tarball = await packTarball(spec, staging);
        entry.tarball = tarball.file;
        digests[`${entry.name}@${entry.version}`] = tarball.sha256;
      } catch (error) {
        fail(error.message);
      }
    }

    const published = [];
    const skipped = [];
    for (const entry of plan) {
      const id = `${entry.name}@${entry.version}`;
      if (entry.onRegistry) {
        skipped.push(id);
        continue;
      }
      const args = ['publish', entry.tarball, '--ignore-scripts'];
      if (provenance) args.push('--provenance');
      if (values['dry-run']) {
        console.log(`would publish ${id} (sha256 ${digests[id]})`);
        continue;
      }
      const outcome = await run(npm, args, { cwd: repoRoot });
      if (outcome.code !== 0) {
        fail(
          `publishing ${id} failed; re-run "npm run release" to resume ` +
            `(${published.length} published this run)`,
          exitStatus(outcome),
        );
      }
      published.push(id);
    }

    console.log(`release: published ${published.length}: ${published.join(', ') || 'none'}`);
    if (skipped.length > 0) {
      console.log(`release: already on the registry ${skipped.length}: ${skipped.join(', ')}`);
    }
    if (!provenance) console.log('release: published without a provenance attestation');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Imported, the module only defines its helpers, so the registry parsing,
// packing, and digest writing can be tested without publishing; run directly,
// it releases.
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof ReleaseStop)) throw error;
    console.error(`release: ${error.message}`);
    process.exitCode = error.status;
  }
}
