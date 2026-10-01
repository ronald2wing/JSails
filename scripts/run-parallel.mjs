/**
 * Runs several root `npm run <script>` jobs concurrently and fails the whole
 * run if any of them fails. `check` uses it to overlap the read-only phases
 * (lint, format:check, the structure gates) that would otherwise serialize.
 * Each job inherits stdio, so its output stays live and ordered per job.
 *
 * The first job to fail terminates its siblings; those terminations are the
 * script's own doing and are not reported as failures. Any other non-zero
 * exit, or an exit by signal, is a failure, and the process exits with the
 * first failure's status (`128 + signal` when a signal ended that job).
 *
 * Usage: node scripts/run-parallel.mjs <script> <script> [...]
 */
import { exitStatus, npm, run } from './subprocess.mjs';
import { repoRoot } from './workspaces.mjs';

const scripts = process.argv.slice(2);
if (scripts.length === 0) {
  console.error('Usage: node scripts/run-parallel.mjs <script> [<script> ...]');
  process.exit(2);
}

const jobs = scripts.map((name) => {
  const controller = new AbortController();
  return {
    name,
    controller,
    outcome: run(npm, ['run', name], { cwd: repoRoot, signal: controller.signal }),
  };
});

let firstFailure;

function describe({ code, signal }) {
  return signal === null ? `exited with code ${code}` : `was killed by ${signal}`;
}

function settle(job, outcome) {
  if (job.controller.signal.aborted) return;
  if (outcome.code === 0) return;
  console.error(`"npm run ${job.name}" ${describe(outcome)}`);
  firstFailure ??= outcome;
  for (const sibling of jobs) {
    if (sibling !== job) sibling.controller.abort();
  }
}

await Promise.allSettled(
  jobs.map((job) =>
    job.outcome.then(
      (outcome) => settle(job, outcome),
      (error) => {
        console.error(`Failed to start "npm run ${job.name}": ${error.message}`);
        settle(job, { code: 1, signal: null });
      },
    ),
  ),
);

process.exit(firstFailure === undefined ? 0 : exitStatus(firstFailure));
