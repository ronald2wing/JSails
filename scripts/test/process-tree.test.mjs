/**
 * Tests for `scripts/process-tree.mjs`: parsing `/proc` stat and status
 * text, tree snapshots and memory samples over a fixture `/proc`, the
 * sampler's peaks, and the peak records leases are sized from. One case reads
 * the real `/proc` and is Linux-only.
 */
import assert from 'node:assert/strict';
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

  it('keeps the peaks of the tree, the root and each child', () => {
    const samples = [
      { totalMb: 200, byChild: new Map([[12, 150]]) },
      {
        totalMb: 500,
        byChild: new Map([
          [12, 100],
          [14, 300],
        ]),
      },
      undefined,
    ];
    let index = 0;
    const sampler = startTreeSampler(11, { intervalMs: 60_000, sample: () => samples[index++] });
    sampler.stop();
    index = 1;
    const peaks = startTreeSampler(11, { intervalMs: 60_000, sample: () => samples[index++] });
    const { peakMb, rootPeakMb, childPeaks } = peaks.stop();
    assert.equal(peakMb, 500);
    assert.equal(rootPeakMb, 100);
    assert.deepEqual(
      [...childPeaks],
      [
        [12, 100],
        [14, 300],
      ],
    );
    const empty = startTreeSampler(11, { intervalMs: 60_000, sample: () => undefined }).stop();
    assert.equal(empty.peakMb, undefined);
  });

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
    assert.deepEqual(readPeaks(file), { 'lint:core': [3700, 3500] });
    writeFileSync(file, 'not json');
    assert.deepEqual(readPeaks(file), {});
    recordPeaks([['lint:core', 10]], file);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'lint:core': [10] });
  });
});
