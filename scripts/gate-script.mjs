/**
 * Runs an existing repo-tooling script as a gate: the gate passes when the
 * script exits 0. The script's own output explains a failure, so the gate adds
 * only one line naming the script.
 */
import { join } from 'node:path';

import { exitStatus, run } from './subprocess.mjs';

/** Runs `node scripts/<script> ...args` from `repoRoot` and returns gate failures. */
export async function scriptGate(repoRoot, script, args = []) {
  const outcome = await run(process.execPath, [join(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
  });
  const status = exitStatus(outcome);
  return status === 0
    ? []
    : [`scripts/${script} ${args.join(' ')}`.trim() + ` exited with ${status}`];
}
