/**
 * The evidence a run leaves behind: a unique directory under the git-ignored
 * `test-results/verify-starter/`, deliberately outside the temp root that is
 * deleted on exit, holding copies of the failure artifacts and the structured
 * `summary.json`. Only the current run's directory is ever created; foreign
 * contents are never deleted, so a run stays auditable after its fixture is
 * torn down.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot } from '../workspaces.mjs';

const EVIDENCE_ROOT = join(repoRoot, 'test-results', 'verify-starter');

/** Creates this run's evidence directory and returns the handle that writes into it. */
export function createEvidence() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = join(EVIDENCE_ROOT, runId);
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  const startedAtMs = Date.now();
  const artifacts = [];

  return {
    runId,
    /** The run directory, relative to the repo root, for the final report. */
    location: relative(repoRoot, runDir),
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    artifacts,

    /** Copies a file into the run's `artifacts/` and records it; the source must exist. */
    copyArtifact(sourcePath, name, description) {
      if (!existsSync(sourcePath)) {
        throw new Error(`evidence artifact missing at ${sourcePath}`);
      }
      const destination = join(runDir, 'artifacts', name);
      copyFileSync(sourcePath, destination);
      artifacts.push({ name, relativePath: relative(runDir, destination), description });
      return destination;
    },

    /** Writes the structured summary beside the artifacts. */
    writeSummary(summary) {
      writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    },
  };
}
