/**
 * Tests for `scripts/budgeted.mjs`: argument parsing and `{jobs}`
 * substitution, the command's exit status passed through, a nested holder
 * running the command without a lease, leases that queue when they do not fit
 * together, the peak recorded for the next lease when the process tree was
 * sampled, and nothing recorded when it never was.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseArgs, runBudgeted, substituteJobs } from '../budgeted.mjs';
import { acquire } from '../machine-budget.mjs';
import { readPeaks, sampleTreeMemory, startTreeSampler } from '../process-tree.mjs';
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

  const queueConfig = { enabled: true, memoryMb: 600, cpu: 8, reserveMb: 0 };
  const leaseIn = (dir) => (request, deps) =>
    acquire(request, { ...deps, dir, env: {}, config: queueConfig });
  /** A sampler that saw the tree at `peakMb` (undefined: never sampled it). */
  const fixedSampler = (peakMb) => () => ({
    stop: () => ({ peakMb, rootPeakMb: peakMb, childPeaks: new Map() }),
  });

  it('queues runs whose leases do not fit together, and records each sampled peak', async () => {
    const dir = join(scratch, 'queue-budget');
    const peaksFile = join(scratch, 'queue-peaks.json');
    const step = (peakMb) =>
      runBudgeted({
        label: 'fixture:queue',
        defaultMb: 500,
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 300)'],
        options: { capture: true },
        peaksFile,
        acquireLease: leaseIn(dir),
        startSampler: fixedSampler(peakMb),
      });
    const started = Date.now();
    const outcomes = await Promise.all([step(41.2), step(57)]);
    assert.ok(Date.now() - started >= 600, 'the two runs overlapped');
    assert.ok(outcomes.every((outcome) => outcome.code === 0));
    assert.deepEqual(readdirSync(dir), [], 'a lease was left behind');
    assert.deepEqual(
      outcomes.map((outcome) => outcome.peakMb),
      [41.2, 57],
    );
    assert.deepEqual(
      readPeaks(peaksFile)['fixture:queue'].toSorted((a, b) => a - b),
      [42, 57],
    );
  });

  it('records nothing for a run whose tree was never sampled', async () => {
    const peaksFile = join(scratch, 'unsampled-peaks.json');
    writeFileSync(peaksFile, `${JSON.stringify({ 'fixture:unsampled': [80] })}\n`);
    const step = (startSampler) =>
      runBudgeted({
        label: 'fixture:unsampled',
        defaultMb: 500,
        command: process.execPath,
        args: ['-e', '0'],
        options: { capture: true },
        peaksFile,
        acquireLease: leaseIn(join(scratch, 'unsampled-budget')),
        startSampler,
      });
    const outcomes = [
      await step(fixedSampler(undefined)),
      await step(() => undefined),
      // The real sampler with no interval inside the run: its only sample
      // comes after the child was reaped.
      await step((pid) => startTreeSampler(pid, { intervalMs: 60_000 })),
    ];
    for (const outcome of outcomes) {
      assert.equal(outcome.code, 0);
      assert.equal(outcome.peakMb, undefined);
    }
    assert.deepEqual(readPeaks(peaksFile), { 'fixture:unsampled': [80] });
  });

  it(
    'records the private memory of a real process tree that was sampled while it ran',
    { skip: process.platform !== 'linux' && 'reads /proc, which only Linux has' },
    async () => {
      const peaksFile = join(scratch, 'sampled-peaks.json');
      const ready = join(scratch, 'sampled-ready');
      const go = join(scratch, 'sampled-go');
      // The child holds 64 MiB of touched memory until a sample has seen it:
      // the sampler checks for `ready` (written after the allocation) before
      // it reads /proc, so the sample that releases the child includes it.
      const child = [
        "const fs = require('node:fs');",
        'const held = Buffer.alloc(64 * 1024 * 1024, 1);',
        'fs.writeFileSync(process.argv[1], "");',
        'const wait = setInterval(() => {',
        '  if (fs.existsSync(process.argv[2])) { clearInterval(wait); held.fill(0); }',
        '}, 5);',
      ].join('\n');
      let sawReady = false;
      const sample = (pid) => {
        const wasReady = existsSync(ready);
        const now = sampleTreeMemory(pid);
        if (wasReady && now !== undefined) {
          sawReady = true;
          writeFileSync(go, '');
        }
        return now;
      };
      const outcome = await runBudgeted({
        label: 'fixture:sampled',
        defaultMb: 500,
        command: process.execPath,
        args: ['-e', child, ready, go],
        options: { capture: true },
        peaksFile,
        acquireLease: leaseIn(join(scratch, 'sampled-budget')),
        startSampler: (pid) => startTreeSampler(pid, { intervalMs: 10, sample }),
      });
      assert.equal(outcome.code, 0, outcome.output);
      assert.ok(sawReady);
      assert.ok(outcome.peakMb >= 64, `peak ${outcome.peakMb} MiB`);
      assert.deepEqual(readPeaks(peaksFile), { 'fixture:sampled': [Math.ceil(outcome.peakMb)] });
    },
  );
});
