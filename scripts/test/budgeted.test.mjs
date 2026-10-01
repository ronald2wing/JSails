/**
 * Tests for `scripts/budgeted.mjs`: argument parsing and `{jobs}`
 * substitution, the command's exit status passed through, a nested holder
 * running the command without a lease, leases that queue when they do not fit
 * together, and the peak recorded for the next lease.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseArgs, runBudgeted, substituteJobs } from '../budgeted.mjs';
import { acquire } from '../machine-budget.mjs';
import { readPeaks } from '../process-tree.mjs';
import { run } from '../subprocess.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-budgeted-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const wrapper = join(import.meta.dirname, '..', 'budgeted.mjs');

describe('parseArgs', () => {
  it('splits the options from the command', () => {
    assert.deepEqual(
      parseArgs(
        ['--label', 'test:scripts', '--mb', '1100', '--cpu', '4', '--', 'node', '-e', '0'],
        12,
      ),
      { label: 'test:scripts', mb: 1100, cpu: 4, command: 'node', args: ['-e', '0'] },
    );
    assert.equal(parseArgs(['--label', 'x', '--mb', '1', '--', 'true'], 12).cpu, 12);
  });

  it('refuses a missing command, label or size, and a malformed number', () => {
    assert.throws(() => parseArgs(['--label', 'x', '--mb', '1']), /after --/);
    assert.throws(() => parseArgs(['--label', 'x', '--mb', '1', '--']), /after --/);
    assert.throws(() => parseArgs(['--mb', '1', '--', 'true']), /required/);
    assert.throws(() => parseArgs(['--label', 'x', '--mb', '0', '--', 'true']), /malformed/);
    assert.throws(
      () => parseArgs(['--label', 'x', '--mb', '1', '--cpus', '2', '--', 'true']),
      /unknown/,
    );
  });
});

describe('substituteJobs', () => {
  it('replaces every {jobs} with the CPU grant', () => {
    assert.deepEqual(substituteJobs(['--test-concurrency={jobs}', 'x', '{jobs}{jobs}'], 3), [
      '--test-concurrency=3',
      'x',
      '33',
    ]);
  });
});

describe('the wrapper', () => {
  const env = (extra) => ({
    ...process.env,
    JSAILS_BUDGET_DIR: join(scratch, 'cli-budget'),
    JSAILS_BUDGET_HOLDER: '',
    JSAILS_JOBS: '',
    ...extra,
  });
  const print =
    'process.stdout.write(JSON.stringify([process.argv[1], process.env.JSAILS_BUDGET_HOLDER ?? null, process.env.JSAILS_JOBS ?? null])); process.exitCode = 3;';

  it('passes the command its grant and returns its exit status', async () => {
    const outcome = await run(
      process.execPath,
      [
        wrapper,
        '--label',
        'fixture',
        '--mb',
        '10',
        '--cpu',
        '2',
        '--',
        process.execPath,
        '-e',
        print,
        '{jobs}',
      ],
      { capture: true, env: env({ JSAILS_BUDGET: 'off' }) },
    );
    assert.equal(outcome.code, 3, outcome.output);
    assert.deepEqual(JSON.parse(outcome.stdout), ['2', '', '']);
  });

  it('runs the command without a lease inside a live holder', async () => {
    const outcome = await run(
      process.execPath,
      [
        wrapper,
        '--label',
        'fixture',
        '--mb',
        '10',
        '--cpu',
        '8',
        '--',
        process.execPath,
        '-e',
        print,
        '{jobs}',
      ],
      { capture: true, env: env({ JSAILS_BUDGET_HOLDER: String(process.pid), JSAILS_JOBS: '3' }) },
    );
    assert.equal(outcome.code, 3, outcome.output);
    // The holder's own variables pass through unchanged; {jobs} is its share.
    assert.deepEqual(JSON.parse(outcome.stdout), ['3', String(process.pid), '3']);
    const dir = join(scratch, 'cli-budget');
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, 'a nested run took a lease');
  });

  it('queues runs whose leases do not fit together, and records the peak', async () => {
    const dir = join(scratch, 'queue-budget');
    const peaksFile = join(scratch, 'peaks.json');
    const config = { enabled: true, memoryMb: 600, cpu: 8, reserveMb: 0 };
    const acquireLease = (request, deps) => acquire(request, { ...deps, dir, env: {}, config });
    const step = () =>
      runBudgeted({
        label: 'fixture:queue',
        defaultMb: 500,
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 300)'],
        options: { capture: true },
        peaksFile,
        acquireLease,
      });
    const started = Date.now();
    const outcomes = await Promise.all([step(), step()]);
    assert.ok(Date.now() - started >= 600, 'the two runs overlapped');
    assert.ok(outcomes.every((outcome) => outcome.code === 0));
    assert.deepEqual(readdirSync(dir), [], 'a lease was left behind');
    if (process.platform === 'linux') {
      const recorded = readPeaks(peaksFile)['fixture:queue'];
      assert.equal(recorded.length, 2);
      assert.ok(
        recorded.every((mb) => mb > 0),
        JSON.stringify(recorded),
      );
      assert.ok(outcomes.every((outcome) => outcome.peakMb > 0));
    } else {
      assert.equal(readPeaks(peaksFile)['fixture:queue'], undefined);
    }
  });
});
