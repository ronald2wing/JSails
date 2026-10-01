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
 *    registry before a first-party package it depends on.
 * 4. Resumes: a workspace whose exact version is already on the registry is
 *    skipped, so re-running after a failure (an expired OTP, a network error)
 *    publishes only what is missing instead of failing on E403.
 *
 * Publishing always uses `--ignore-scripts`: no lifecycle hook runs, so the
 * gate in step 2 is the only code that runs. `--provenance` (an npm provenance
 * attestation linking each tarball to its source commit and build) is passed
 * when running in GitHub Actions, where npm can obtain the OIDC token it needs
 * (`.github/workflows/release.yml`); pass `--provenance` to force it elsewhere
 * or `--no-provenance` to omit it.
 *
 * Flags:
 *   --dry-run          check the tree and print the publish plan; publish nothing
 *   --skip-check       skip step 2 (only when the same commit just passed it)
 *   --provenance / --no-provenance
 *
 * Usage: node scripts/release.mjs [flags]
 */
import { parseArgs } from 'node:util';

import { exitStatus, npm, run } from './subprocess.mjs';
import { readWorkspaces, repoRoot, topologicalOrder, workspaceGraph } from './workspaces.mjs';

function fail(message, status = 1) {
  console.error(`release: ${message}`);
  process.exit(status);
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
  let order;
  try {
    order = topologicalOrder(workspaceGraph(workspaces));
  } catch (error) {
    fail(error.message);
  }

  const published = [];
  const skipped = [];
  for (const name of order) {
    const { manifest } = workspaces.get(name);
    if (manifest.private === true) continue;
    if (await isPublished(name, manifest.version)) {
      skipped.push(`${name}@${manifest.version}`);
      continue;
    }
    const args = ['publish', '--workspace', name, '--ignore-scripts'];
    if (provenance) args.push('--provenance');
    if (values['dry-run']) {
      console.log(`would run: npm ${args.join(' ')}`);
      continue;
    }
    const outcome = await run(npm, args, { cwd: repoRoot });
    if (outcome.code !== 0) {
      fail(
        `publishing ${name}@${manifest.version} failed; re-run "npm run release" to resume ` +
          `(${published.length} published this run)`,
        exitStatus(outcome),
      );
    }
    published.push(`${name}@${manifest.version}`);
  }

  console.log(`release: published ${published.length}: ${published.join(', ') || 'none'}`);
  if (skipped.length > 0) {
    console.log(`release: already on the registry ${skipped.length}: ${skipped.join(', ')}`);
  }
  if (!provenance) console.log('release: published without a provenance attestation');
}

// Imported, the module only defines `registryHasVersion`, so the registry
// parsing can be exercised without publishing; run directly, it releases.
if (import.meta.main) await main();
