/**
 * Tests for `scripts/process-tree.mjs`: parsing `/proc` stat and status
 * text, tree snapshots and memory samples over a fixture `/proc`, the
 * sampler's peaks (none for a tree it never sampled), and the peak records
 * leases are sized from. The cases that read the real `/proc` are Linux-only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  PEAK_HISTORY,
  parseProcStat,
  parseStatusMemory,
  peakEstimate,
  readPeaks,
  recordPeaks,
  sampleTreeMemory,
  snapshotProcessTree,
  startTreeSampler,
  withPeak,
} from '../process-tree.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-process-tree-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A fixture `/proc`: `{ pid: [ppid, anonKiB, shmemKiB, comm?] }`. */
function fakeProc(processes) {
  const proc = mkdtempSync(join(scratch, 'proc-'));
  for (const [pid, [ppid, anon, shmem, comm = 'node']] of Object.entries(processes)) {
    mkdirSync(join(proc, pid));
    const rest = ['S', ppid, ...Array.from({ length: 17 }, () => 0), 1000 + Number(pid)];
    writeFileSync(join(proc, pid, 'stat'), `${pid} (${comm}) ${rest.join(' ')}\n`);
    writeFileSync(
      join(proc, pid, 'status'),
      `Name:\t${comm}\nVmRSS:\t  99999 kB\nRssAnon:\t ${anon} kB\nRssFile:\t 40000 kB\nRssShmem:\t ${shmem} kB\n`,
    );
  }
  mkdirSync(join(proc, 'self'));
  return proc;
}

describe('parsing', () => {
  it('reads the parent and start time past a command name with spaces and parentheses', () => {
    const fields = ['S', '7', ...Array.from({ length: 17 }, () => '0'), '12345', '0'];
    assert.deepEqual(parseProcStat(9, `9 (a (b) c) ${fields.join(' ')}`), {
      pid: 9,
      ppid: 7,
      starttime: 12345,
    });
    assert.equal(parseProcStat(9, 'garbage'), null);
  });

  it('counts anonymous and shared-memory pages, not file-backed ones', () => {
    assert.equal(
      parseStatusMemory(
        'VmRSS:\t 500 kB\nRssAnon:\t 300 kB\nRssFile:\t 150 kB\nRssShmem:\t 50 kB\n',
      ),
      350,
    );
    assert.equal(parseStatusMemory('Name:\tkthreadd\n'), 0);
  });
});

describe('trees over a fixture /proc', () => {
  // 10 runner -> 11 orchestrator -> 12 test file -> 13 CLI child; 11 -> 14 test file; 20 unrelated.
  const proc = fakeProc({
    10: [1, 51_200, 0],
    11: [10, 102_400, 10_240],
    12: [11, 204_800, 0],
    13: [12, 102_400, 0, 'jsails cli (x)'],
    14: [11, 51_200, 0],
    20: [1, 999_999, 0],
  });

  it('snapshots the roots and every descendant', () => {
    assert.deepEqual([...snapshotProcessTree([11], { proc }).keys()].sort(), [11, 12, 13, 14]);
    assert.deepEqual([...snapshotProcessTree([12, 20], { proc }).keys()].sort(), [12, 13, 20]);
    assert.equal(snapshotProcessTree([11], { proc: join(scratch, 'none') }).size, 0);
  });

  it('samples the private memory of the tree and of each child subtree', () => {
    const sample = sampleTreeMemory(11, { proc });
    assert.equal(sample.totalMb, 460);
    assert.deepEqual(
      [...sample.byChild],
      [
        [12, 300],
        [14, 50],
      ],
    );
    assert.equal(sampleTreeMemory(99, { proc }), undefined);
    assert.equal(sampleTreeMemory(11, { proc: join(scratch, 'none') }), undefined);
  });

  it('keeps the peaks of the tree, the root and each child over its samples', async () => {
    const samples = [
      { totalMb: 200, byChild: new Map([[12, 150]]) },
      {
        totalMb: 500,
        byChild: new Map([
          [12, 100],
          [14, 300],
        ]),
      },
    ];
    // The test waits on the sampler's calls, not on time: the timer runs
    // until both samples were taken, and stop()'s last one finds the root gone.
    const { promise: sampled, resolve } = Promise.withResolvers();
    let index = 0;
    const sampler = startTreeSampler(11, {
      intervalMs: 1,
      sample: () => {
        const now = samples[index++];
        if (index === samples.length) resolve();
        return now;
      },
    });
    await sampled;
    const { peakMb, rootPeakMb, childPeaks } = sampler.stop();
    assert.equal(peakMb, 500);
    assert.equal(rootPeakMb, 100);
    assert.deepEqual(
      [...childPeaks],
      [
        [12, 150],
        [14, 300],
      ],
    );
  });

  it('samples nothing at the start, so a tree gone before its first sample has no peak', () => {
    const calls = [];
    const sampler = startTreeSampler(11, {
      intervalMs: 60_000,
      sample: (pid) => {
        calls.push(pid);
        return undefined;
      },
    });
    assert.deepEqual(calls, [], 'sampled the tree as it was spawned');
    const { peakMb, rootPeakMb, childPeaks } = sampler.stop();
    assert.deepEqual(calls, [11]);
    assert.equal(peakMb, undefined);
    assert.equal(rootPeakMb, undefined);
    assert.equal(childPeaks.size, 0);
  });

  it(
    'reports no peak for a real process that exits before its first sample',
    { skip: process.platform !== 'linux' && 'reads /proc, which only Linux has' },
    async () => {
      const outcome = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
        const sampler = startTreeSampler(child.pid, { intervalMs: 60_000 });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, peaks: sampler.stop() }));
      });
      assert.equal(outcome.code, 0);
      assert.equal(outcome.peaks.peakMb, undefined);
    },
  );

  it(
    'samples this process from the real /proc',
    { skip: process.platform !== 'linux' && 'reads /proc, which only Linux has' },
    () => {
      const sample = sampleTreeMemory(process.pid);
      assert.ok(sample.totalMb > 10, `sampled ${sample.totalMb} MiB`);
    },
  );
});

describe('peak records', () => {
  it('keeps the last few peaks per label and asks for the largest with a margin', () => {
    let peaks = {};
    for (const mb of [100, 400, 300, 200]) peaks = withPeak(peaks, 'gate:bench', mb);
    assert.deepEqual(peaks['gate:bench'], [400, 300, 200].slice(-PEAK_HISTORY));
    assert.equal(peakEstimate(peaks, 'gate:bench', 999), 480);
    assert.equal(peakEstimate(peaks, 'gate:docs', 500), 500);
  });

  it('rounds a peak up, and leases from positive entries only', () => {
    assert.deepEqual(withPeak({}, 'fixture', 0.4).fixture, [1]);
    assert.deepEqual(withPeak({}, 'fixture', 12.01).fixture, [13]);
    // A 0 or a malformed entry in an existing record is no measurement.
    assert.equal(peakEstimate({ fixture: [0, -5, 'x', null] }, 'fixture', 500), 500);
    assert.equal(peakEstimate({ fixture: [0, 100] }, 'fixture', 500), 120);
  });

  it('records several labels at once and survives a missing or corrupt file', () => {
    const file = join(scratch, 'peaks', 'peaks.json');
    assert.deepEqual(readPeaks(file), {});
    recordPeaks(
      [
        ['lint:core', 3700.4],
        ['gate:docs', undefined],
        ['gate:x', 0],
      ],
      file,
    );
    recordPeaks([['lint:core', 3500]], file);
    assert.deepEqual(readPeaks(file), { 'lint:core': [3701, 3500] });
    writeFileSync(file, 'not json');
    assert.deepEqual(readPeaks(file), {});
    recordPeaks([['lint:core', 10]], file);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'lint:core': [10] });
  });
});
