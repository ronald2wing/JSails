/**
 * Tests for `scripts/run-workspaces.mjs` scheduling: which scripts wait on the
 * dependency graph, the start order, the shared test-concurrency budget, what
 * a failure stops, and the refusal of a database suite with no database test
 * in any workspace.
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
  testConcurrency,
  testWeights,
  timingsFileName,
} from '../run-workspaces.mjs';

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

describe('testConcurrency', () => {
  it('shares the budget in proportion to weight, rounded up, at least one each', () => {
    const shares = testConcurrency(
      new Map([
        ['jsails', 400],
        ['@jsails/ai', 40],
        ['@jsails/flags', 2],
      ]),
      12,
    );
    assert.deepEqual(Object.fromEntries(shares), {
      jsails: 11,
      '@jsails/ai': 2,
      '@jsails/flags': 1,
    });
  });

  it('never exceeds the budget and handles no tests', () => {
    assert.equal(testConcurrency(new Map([['only', 5]]), 4).get('only'), 4);
    assert.equal(testConcurrency(new Map([['none', 0]]), 4).get('none'), 1);
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
    for (const script of ['run-workspaces.mjs', 'subprocess.mjs', 'workspaces.mjs']) {
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
    assert.equal(timingsFileName('test', ['--coverage']), 'timings.json');
    assert.equal(timingsFileName('test', ['--suite=database']), 'timings-test-database.json');
    assert.equal(timingsFileName('build:clean', []), 'timings-build-clean.json');
  });
});

describe('a failing workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsails-workspace-failure-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  // Three independent workspaces: `fast` fails at once, `slow` succeeds after a
  // while, and `late` fails after a while. Run one at a time, `fast` first.
  const fixture = (name) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    for (const script of ['run-workspaces.mjs', 'subprocess.mjs', 'workspaces.mjs']) {
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
      `setTimeout(() => { require('node:fs').writeFileSync('${marker}', ''); process.exit(${code}); }, 1500)`;
    workspace('a-fast', 'process.exit(1)');
    workspace('b-slow', finish('slow.done', 0));
    workspace('c-late', finish('late.done', 1));
    return dir;
  };
  const runIn = (dir, script) =>
    run(process.execPath, [join(dir, 'scripts', 'run-workspaces.mjs'), script], {
      cwd: dir,
      capture: true,
      env: { ...process.env, JSAILS_WORKSPACE_JOBS: '3', JSAILS_TEST_CONCURRENCY: '1' },
    });

  it('lets every test run finish and names each failed workspace', async () => {
    const dir = fixture('test');
    const outcome = await runIn(dir, 'test');
    assert.equal(outcome.code, 1, outcome.output);
    assert.ok(existsSync(join(dir, 'packages', 'b-slow', 'slow.done')), outcome.output);
    assert.ok(existsSync(join(dir, 'packages', 'c-late', 'late.done')), outcome.output);
    assert.match(outcome.output, /"test" failed in @fixture\/a-fast/);
    assert.match(outcome.output, /"test" failed in @fixture\/c-late/);
    assert.match(outcome.output, /failed in 2 workspaces: @fixture\/a-fast, @fixture\/c-late/);
  });

  it('stops a build at the first failure', async () => {
    const dir = fixture('build');
    const outcome = await runIn(dir, 'build');
    assert.equal(outcome.code, 1, outcome.output);
    assert.equal(existsSync(join(dir, 'packages', 'b-slow', 'slow.done')), false);
    assert.equal(existsSync(join(dir, 'packages', 'c-late', 'late.done')), false);
    assert.match(outcome.output, /"build" failed in @fixture\/a-fast/);
  });
});
