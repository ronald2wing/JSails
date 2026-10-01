/**
 * Tests for `scripts/run-workspaces.mjs` scheduling: which scripts wait on the
 * dependency graph, the start order, the shares of the test slots (which never
 * add up to more than the slots), each lane's lease request and the
 * environment its grant becomes, what a failure stops, and the refusal of a
 * database suite with no database test in any workspace.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { run } from '../subprocess.mjs';
import {
  countDatabaseTests,
  countTestFiles,
  schedulingGraph,
  startOrder,
  nextShare,
  testLane,
  testWeights,
  timingsFileName,
  tscLease,
} from '../run-workspaces.mjs';

/** The runner and the modules it imports, copied into each fixture repository. */
const RUNNER_SCRIPTS = [
  'run-workspaces.mjs',
  'subprocess.mjs',
  'workspaces.mjs',
  'machine-budget.mjs',
  'process-tree.mjs',
  'test-budget.mjs',
];

const declared = new Map([
  ['jsails', new Set()],
  ['@jsails/auth', new Set(['jsails'])],
  ['@jsails/admin', new Set(['jsails', '@jsails/auth'])],
]);

describe('schedulingGraph', () => {
  it('keeps dependency edges for builds only', () => {
    assert.equal(schedulingGraph('build', declared), declared);
    assert.equal(schedulingGraph('build:clean', declared), declared);
    for (const script of ['test', 'typecheck']) {
      const graph = schedulingGraph(script, declared);
      assert.deepEqual([...graph.keys()], [...declared.keys()]);
      assert.ok(
        [...graph.values()].every((deps) => deps.size === 0),
        script,
      );
    }
  });
});

describe('startOrder', () => {
  const topological = ['jsails', '@jsails/auth', '@jsails/admin'];
  const weights = new Map([
    ['jsails', 400],
    ['@jsails/auth', 10],
    ['@jsails/admin', 30],
  ]);

  it('builds in dependency order', () => {
    assert.deepEqual(startOrder('build', topological, weights), topological);
  });

  it('starts the largest test suite first', () => {
    assert.deepEqual(startOrder('test', topological, weights), [
      'jsails',
      '@jsails/admin',
      '@jsails/auth',
    ]);
  });
});

describe('nextShare', () => {
  it('splits the free slots among the workspaces that can start now, at least one each', () => {
    assert.equal(nextShare({ free: 24, weight: 400, upcoming: [400, 40] }), 21);
    assert.equal(nextShare({ free: 3, weight: 40, upcoming: [40, 2] }), 2);
    assert.equal(nextShare({ free: 3, weight: 2, upcoming: [2] }), 3);
    assert.equal(nextShare({ free: 5, weight: 1, upcoming: [1000, 1] }), 1);
    assert.equal(nextShare({ free: 4, weight: 0, upcoming: [0, 0] }), 2);
  });

  it('starts nothing when no slot is free', () => {
    assert.equal(nextShare({ free: 0, weight: 10, upcoming: [10] }), 0);
    assert.equal(nextShare({ free: -2, weight: 10, upcoming: [10] }), 0);
  });

  it('never lets the running shares exceed the slots, whatever order workspaces finish in', () => {
    // A seeded generator, so a failure reproduces.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 200; round += 1) {
      const slots = 1 + Math.floor(random() * 24);
      const lanes = 1 + Math.floor(random() * 8);
      const pending = Array.from({ length: 1 + Math.floor(random() * 30) }, () =>
        Math.floor(random() * 1000),
      );
      const running = [];
      let worst = 0;
      while (pending.length > 0 || running.length > 0) {
        while (pending.length > 0 && running.length < lanes) {
          const free = slots - running.reduce((sum, share) => sum + share, 0);
          const upcoming = pending.slice(0, lanes - running.length);
          const share = nextShare({ free, weight: upcoming[0], upcoming });
          if (share === 0) break;
          running.push(share);
          pending.shift();
        }
        worst = Math.max(
          worst,
          running.reduce((sum, share) => sum + share, 0),
        );
        running.splice(Math.floor(random() * running.length), 1);
      }
      assert.ok(worst <= slots, `round ${round}: ${worst} running slots of ${slots}`);
    }
  });
});

describe('testLane', () => {
  const previous = {
    files: [
      { workspace: 'jsails', file: 'core/test/a.test.ts', wallMs: 300_000, treeMb: 400 },
      { workspace: 'jsails', file: 'core/test/b.test.ts', wallMs: 300_000, rssMb: 200 },
      { workspace: 'jsails', file: 'core/test/c.test.ts', wallMs: 300_000, treeMb: 100 },
    ],
    tasks: [{ workspace: 'jsails', runnerMb: 150 }],
  };

  it('asks for its share with the memory of its largest files, and enough to finish in time', () => {
    const lane = testLane({
      workspace: 'jsails',
      count: 4,
      share: 3,
      previous,
      coverage: true,
      runLimitMs: 900_000,
    });
    // Estimates: 480 (400 x 1.2), 200, 120, and the median 200 for the unrecorded file.
    // Overhead: 150 x 1.2 + 100 for npm. 900 s of files in half of a 900 s limit needs 2.
    assert.deepEqual(lane.request, {
      label: 'test:jsails',
      cpu: { need: 2, want: 3 },
      mb: { need: 280 + 480 + 200, want: 280 + 480 + 200 + 200 },
    });
    const { concurrency, env } = lane.environment({
      mb: 280 + 3 * 200,
      cpu: 3,
      env: { JSAILS_BUDGET_HOLDER: '1', JSAILS_JOBS: '3' },
    });
    assert.equal(concurrency, 3);
    assert.deepEqual(env, {
      JSAILS_BUDGET_HOLDER: '1',
      JSAILS_JOBS: '3',
      JSAILS_TEST_CONCURRENCY: '3',
    });
  });

  it('lowers the concurrency to what the memory grant holds', () => {
    const lane = testLane({
      workspace: 'jsails',
      count: 3,
      share: 8,
      previous,
      coverage: false,
      runLimitMs: 900_000,
    });
    // p75 of 480, 200, 120 is 480; 1300 - 280 holds two of them.
    assert.equal(lane.environment({ mb: 1300, cpu: 3, env: {} }).concurrency, 2);
    assert.equal(lane.environment({ mb: 100, cpu: 3, env: {} }).concurrency, 1);
  });

  it('falls back to defaults without a record, and keeps a fixed concurrency', () => {
    const fresh = testLane({ workspace: 'x', count: 2, share: 4, runLimitMs: 900_000 });
    assert.deepEqual(fresh.request.cpu, { need: 2, want: 2 });
    assert.deepEqual(fresh.request.mb, { need: 200 + 500, want: 200 + 500 });
    const fixed = testLane({ workspace: 'x', count: 9, share: 4, fixed: 3, runLimitMs: 900_000 });
    assert.deepEqual(fixed.request.cpu, { need: 3, want: 3 });
    assert.equal(fixed.environment({ mb: 1, cpu: 1, env: {} }).concurrency, 3);
  });

  it('needs its whole share without a recorded wall time, so a narrow grant cannot outrun the run limit', () => {
    // Core under coverage on a CI runner, which never has a timing record:
    // 501 files whose serial wall is past the 900 s run limit.
    const lane = testLane({
      workspace: 'jsails',
      count: 501,
      share: 5,
      coverage: true,
      runLimitMs: 900_000,
    });
    assert.deepEqual(lane.request.cpu, { need: 5, want: 5 });
    assert.deepEqual(lane.request.mb, { need: 450 + 5 * 250, want: 450 + 5 * 250 });
    // The smallest grant the budget may give still runs at the whole share.
    const least = { mb: lane.request.mb.need, cpu: lane.request.cpu.need, env: {} };
    assert.equal(lane.environment(least).concurrency, 5);
  });
});

describe('tscLease', () => {
  it('leases the recorded tsc peak with a margin, else the core or package default', () => {
    assert.deepEqual(tscLease('jsails', {}), { label: 'build:jsails', mb: 2000 });
    assert.deepEqual(tscLease('@jsails/flags', {}), { label: 'build:@jsails/flags', mb: 450 });
    assert.deepEqual(tscLease('jsails', { 'build:jsails': [1500, 1900] }), {
      label: 'build:jsails',
      mb: 2280,
    });
  });
});

describe('testWeights', () => {
  const counts = new Map([
    ['jsails', 10],
    ['@jsails/mcp', 2],
    ['@jsails/new', 4],
  ]);

  it('uses file counts without a record', () => {
    assert.deepEqual(Object.fromEntries(testWeights(counts, undefined)), {
      jsails: 10,
      '@jsails/mcp': 2,
      '@jsails/new': 4,
    });
  });

  it('uses recorded wall time, scaling unrecorded workspaces by the average file', () => {
    const previous = {
      files: [
        { workspace: 'jsails', wallMs: 100 },
        { workspace: 'jsails', wallMs: 100 },
        { workspace: '@jsails/mcp', wallMs: 400 },
      ],
    };
    assert.deepEqual(Object.fromEntries(testWeights(counts, previous)), {
      jsails: 200,
      '@jsails/mcp': 400,
      '@jsails/new': 800,
    });
  });
});

describe('countTestFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-count-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('counts compiled test files only', () => {
    mkdirSync(join(dir, 'dist', 'test', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'test', 'a.test.js'), '');
    writeFileSync(join(dir, 'dist', 'test', 'nested', 'b.test.js'), '');
    writeFileSync(join(dir, 'dist', 'test', 'nested', 'helper.js'), '');
    assert.equal(countTestFiles(dir), 2);
    assert.equal(countTestFiles(join(dir, 'missing')), 0);
  });
});

describe('countDatabaseTests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-count-db-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('counts *.database.test.ts(x) sources across workspaces, and nothing misnamed', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(join(a, 'test', 'nested'), { recursive: true });
    mkdirSync(join(b, 'test'), { recursive: true });
    writeFileSync(join(a, 'test', 'store.test.ts'), '');
    writeFileSync(join(a, 'test', 'store.db.test.ts'), '');
    writeFileSync(join(a, 'test', 'nested', 'store.database.test.ts'), '');
    writeFileSync(join(b, 'test', 'view.database.test.tsx'), '');
    assert.equal(countDatabaseTests([a]), 1);
    assert.equal(countDatabaseTests([a, b, join(dir, 'missing')]), 2);
    assert.equal(countDatabaseTests([join(dir, 'missing')]), 0);
  });
});

describe('the database suite with no database test', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsails-empty-db-suite-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('fails before running any workspace', async () => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'packages', 'demo', 'test'), { recursive: true });
    for (const script of RUNNER_SCRIPTS) {
      writeFileSync(
        join(root, 'scripts', script),
        readFileSync(join(import.meta.dirname, '..', script)),
      );
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'module',
        workspaces: ['packages/*'],
      }),
    );
    writeFileSync(
      join(root, 'packages', 'demo', 'package.json'),
      JSON.stringify({ name: '@fixture/demo', scripts: { test: 'node -e ""' } }),
    );
    writeFileSync(join(root, 'packages', 'demo', 'test', 'store.db.test.ts'), '');
    const outcome = await run(
      process.execPath,
      [join(root, 'scripts', 'run-workspaces.mjs'), 'test', '--', '--suite=database'],
      { cwd: root, capture: true },
    );
    assert.equal(outcome.code, 1, outcome.output);
    assert.match(
      outcome.output,
      /database suite has no test\/\*\*\/\*\.database\.test\.ts\(x\) file/,
    );
  });
});

describe('timingsFileName', () => {
  it('keeps the default-suite record apart from other runs', () => {
    assert.equal(timingsFileName('test', []), 'timings.json');
    assert.equal(timingsFileName('test', ['--coverage']), 'timings-test-coverage.json');
    assert.equal(timingsFileName('test', ['--suite=database']), 'timings-test-database.json');
    assert.equal(timingsFileName('build:clean', []), 'timings-build-clean.json');
  });
});

describe('a failing workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsails-workspace-failure-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  // Three independent workspaces run at once: `fast` fails at once, `slow`
  // succeeds and `late` fails, each `settleMs` after `fast` has failed. They
  // wait for `fast`'s marker rather than for a fixed time, so the order holds
  // however slowly a loaded machine starts the processes. `slow` and `late`
  // leave a `started` marker as soon as they run.
  const fixture = (name, settleMs) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    for (const script of RUNNER_SCRIPTS) {
      writeFileSync(
        join(dir, 'scripts', script),
        readFileSync(join(import.meta.dirname, '..', script)),
      );
    }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'module',
        workspaces: ['packages/*'],
      }),
    );
    const workspace = (pkg, body) => {
      mkdirSync(join(dir, 'packages', pkg), { recursive: true });
      const command = `node -e "${body}"`;
      writeFileSync(
        join(dir, 'packages', pkg, 'package.json'),
        JSON.stringify({ name: `@fixture/${pkg}`, scripts: { test: command, build: command } }),
      );
    };
    const finish = (marker, code) =>
      `const fs = require('node:fs'); fs.writeFileSync('started', ''); const settle = () => { fs.writeFileSync('${marker}', ''); process.exit(${code}); }; const wait = () => (fs.existsSync('../a-fast/failed') ? setTimeout(settle, ${settleMs}) : setTimeout(wait, 20)); wait();`;
    workspace('a-fast', `require('node:fs').writeFileSync('failed', ''); process.exit(1)`);
    workspace('b-slow', finish('slow.done', 0));
    workspace('c-late', finish('late.done', 1));
    return dir;
  };
  const runIn = (dir, script, env = {}) =>
    run(process.execPath, [join(dir, 'scripts', 'run-workspaces.mjs'), script], {
      cwd: dir,
      capture: true,
      env: {
        ...process.env,
        JSAILS_WORKSPACE_JOBS: '3',
        JSAILS_TEST_CONCURRENCY: '1',
        JSAILS_BUDGET: '',
        JSAILS_BUDGET_DIR: join(dir, 'budget'),
        JSAILS_BUDGET_HOLDER: '',
        ...env,
      },
    });

  it('lets every test run finish and names each failed workspace', async () => {
    const dir = fixture('test', 100);
    const outcome = await runIn(dir, 'test');
    assert.equal(outcome.code, 1, outcome.output);
    assert.ok(existsSync(join(dir, 'packages', 'b-slow', 'slow.done')), outcome.output);
    assert.ok(existsSync(join(dir, 'packages', 'c-late', 'late.done')), outcome.output);
    assert.match(outcome.output, /"test" failed in @fixture\/a-fast/);
    assert.match(outcome.output, /"test" failed in @fixture\/c-late/);
    assert.match(outcome.output, /failed in 2 workspaces: @fixture\/a-fast, @fixture\/c-late/);
  });

  it('stops a build at the first failure', async () => {
    // Far longer than stopping them takes, so a finished sibling means the
    // build did not stop it.
    const dir = fixture('build', 60_000);
    const outcome = await runIn(dir, 'build');
    assert.equal(outcome.code, 1, outcome.output);
    assert.equal(existsSync(join(dir, 'packages', 'b-slow', 'slow.done')), false);
    assert.equal(existsSync(join(dir, 'packages', 'c-late', 'late.done')), false);
    assert.match(outcome.output, /"build" failed in @fixture\/a-fast/);
  });

  it('starts no build that was waiting for its lease when the first one failed', async () => {
    // One CPU slot: `fast` holds it while the next lane waits for its lease,
    // and `fast` failing frees the slot. Starting `slow` then would mean the
    // failure went unseen during the wait.
    const dir = fixture('build-queued', 0);
    const outcome = await runIn(dir, 'build', { JSAILS_CPU_BUDGET: '1' });
    assert.equal(outcome.code, 1, outcome.output);
    assert.equal(existsSync(join(dir, 'packages', 'b-slow', 'started')), false, outcome.output);
    assert.equal(existsSync(join(dir, 'packages', 'c-late', 'started')), false, outcome.output);
    assert.match(outcome.output, /"build" failed in @fixture\/a-fast/);
  });
});
