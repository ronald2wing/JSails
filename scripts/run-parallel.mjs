/**
 * Runs several root `npm run <script>` jobs concurrently and fails the whole
 * run if any of them fails. `check` uses it to overlap its phases (lint,
 * format:check, the gates, the tooling tests, the coverage run) that would
 * otherwise serialize. Each job inherits stdio, so its output stays live.
 *
 * Every job runs to the end, even after another has failed: the phases are
 * independent checks, so one run reports every phase that fails, and a phase
 * stopped early could not be told apart from a broken one. Each failure is
 * named, in the order the scripts were given, and the process exits with the
 * status of the first failed script in that order (`128 + signal` when a
 * signal ended that job), so a run's status and report do not depend on which
 * job a loaded machine happened to finish first.
 *
 * Usage: node scripts/run-parallel.mjs <script> <script> [...]
 */
import { exitStatus, npm, run } from './subprocess.mjs';
import { repoRoot } from './workspaces.mjs';

function describe({ code, signal }) {
  return signal === null ? `exited with code ${code}` : `was killed by ${signal}`;
}

/** Runs every script to the end; resolves with the exit status for the group. */
export async function main(scripts, { cwd = repoRoot } = {}) {
  if (scripts.length === 0) {
    console.error('Usage: node scripts/run-parallel.mjs <script> [<script> ...]');
    return 2;
  }
  const outcomes = await Promise.all(
    scripts.map(async (name) => {
      let outcome;
      try {
        outcome = await run(npm, ['run', name], { cwd });
      } catch (error) {
        console.error(`Failed to start "npm run ${name}": ${error.message}`);
        outcome = { code: 1, signal: null };
      }
      if (outcome.code !== 0 || outcome.signal !== null) {
        console.error(`"npm run ${name}" ${describe(outcome)}`);
      }
      return { name, outcome };
    }),
  );
  const failures = outcomes.filter(({ outcome }) => outcome.code !== 0 || outcome.signal !== null);
  if (failures.length === 0) return 0;
  if (failures.length > 1) {
    console.error(
      `\n${failures.length} of ${scripts.length} jobs failed: ${failures.map(({ name }) => name).join(', ')}`,
    );
  }
  return exitStatus(failures[0].outcome);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
