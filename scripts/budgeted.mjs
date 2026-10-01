/**
 * Runs a command under a lease from the machine budget
 * (`scripts/machine-budget.mjs`), so steps that size nothing themselves
 * (`test:scripts`, `format:check`, `verify:starter`, `verify:integrations`,
 * the docs site check) share the machine with every other checkout's checks.
 *
 * The lease asks for the command's recorded peak (`scripts/process-tree.mjs`)
 * or `--mb` when there is no record yet, and `--cpu` slots (default: the
 * available parallelism; at least one is enough to start). The command runs
 * with `JSAILS_BUDGET_HOLDER` and `JSAILS_JOBS` set, so what it starts takes
 * no lease of its own and inner pools take a share of the grant; `{jobs}` in
 * its arguments is replaced with the CPU grant. On Linux its process tree is
 * sampled and the peak recorded for the next run; a run that ends before its
 * tree was sampled records nothing, so the next lease keeps the older record
 * or `--mb`. The exit status is the command's.
 *
 * Usage: node scripts/budgeted.mjs --label <label> --mb <MiB> [--cpu <n>] -- <command> [args...]
 */
import { availableParallelism } from 'node:os';

import { acquire } from './machine-budget.mjs';
import {
  PEAKS_FILE,
  peakEstimate,
  readPeaks,
  recordPeaks,
  startTreeSampler,
} from './process-tree.mjs';
import { exitStatus, run } from './subprocess.mjs';

class UsageError extends Error {}

/** `args` with every `{jobs}` replaced by `jobs`. */
export function substituteJobs(args, jobs) {
  return args.map((arg) => arg.replaceAll('{jobs}', String(jobs)));
}

/** Parses the wrapper's own options; everything after `--` is the command. */
export function parseArgs(argv, parallelism = availableParallelism()) {
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) {
    throw new UsageError('budgeted: give the command after --');
  }
  const own = argv.slice(0, separator);
  const options = { label: undefined, mb: undefined, cpu: parallelism };
  for (let index = 0; index < own.length; index += 2) {
    const [flag, value] = [own[index], own[index + 1]];
    if (flag === '--label' && value) options.label = value;
    else if ((flag === '--mb' || flag === '--cpu') && /^[1-9]\d*$/.test(value ?? '')) {
      options[flag.slice(2)] = Number(value);
    } else throw new UsageError(`budgeted: unknown or malformed option ${flag}`);
  }
  if (options.label === undefined || options.mb === undefined) {
    throw new UsageError('budgeted: --label and --mb are required');
  }
  const [command, ...args] = argv.slice(separator + 1);
  return { ...options, command, args };
}

/** The default tree sampler: `/proc` on Linux, none elsewhere. */
function platformSampler(pid) {
  return process.platform === 'linux' ? startTreeSampler(pid) : undefined;
}

/**
 * Runs `command` under a lease for `label` (its recorded peak, else
 * `defaultMb`; `cpu` slots wanted, or `{ need, want }`) and resolves with its
 * outcome, the grant, and `peakMb` (undefined when the tree was never
 * sampled). `options` go to `run`; the grant's variables are added to its
 * `env`. `startSampler(pid)` returns a sampler as `startTreeSampler` does, or
 * undefined to sample nothing.
 */
export async function runBudgeted({
  label,
  defaultMb,
  cpu = 1,
  command,
  args,
  options = {},
  peaksFile = PEAKS_FILE,
  acquireLease = acquire,
  startSampler = platformSampler,
  signal,
}) {
  const mb = peakEstimate(readPeaks(peaksFile), label, defaultMb);
  const slots = typeof cpu === 'number' ? { need: 1, want: cpu } : cpu;
  const grant = await acquireLease({ label, mb: { need: mb, want: mb }, cpu: slots }, { signal });
  let sampler;
  let outcome;
  let peakMb;
  try {
    outcome = await run(command, substituteJobs(args, grant.cpu), {
      ...options,
      env: { ...(options.env ?? process.env), ...grant.env },
      onSpawn: (child) => {
        sampler = startSampler(child.pid);
      },
    });
  } finally {
    peakMb = sampler?.stop().peakMb;
    grant.release();
  }
  // Inside another holder's lease (or with the budget off) the step is not
  // what was leased, so its peak is not this label's to record.
  const leased = Object.keys(grant.env).length > 0;
  if (leased && peakMb !== undefined) recordPeaks([[label, peakMb]], peaksFile);
  return { ...outcome, grant, peakMb };
}

if (import.meta.main) {
  try {
    const { label, mb, cpu, command, args } = parseArgs(process.argv.slice(2));
    const outcome = await runBudgeted({ label, defaultMb: mb, cpu, command, args });
    process.exitCode = exitStatus(outcome);
  } catch (error) {
    console.error(
      error instanceof UsageError ? error.message : `budgeted: ${error.stack ?? error}`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
