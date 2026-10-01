/**
 * Tests for `scripts/run-tests.mjs`: option parsing, sharding, suite selection,
 * coverage floors, and end-to-end runs in a throwaway repository that prove the
 * ledger contract (a listed failure passes the run; an unlisted failure, a
 * listed test that passes, a listed test failing for another reason, and a
 * stale entry fail it), and that a test process that does not end cleanly (a
 * late rejection or exception, `process.exit()`, a crash) fails the run even
 * in a file whose listed failure would otherwise make node stop reporting it.
 * A suite declared outside its test file is listed under the test file, a
 * service-scoped entry applies only when the run declares the service, and
 * every run writes a reconcile verdict whose drafts are exact ledger entries.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  COVERAGE_MIN_FREE_MB,
  checkCoverage,
  childEnvironment,
  interruptedRecord,
  draftEntry,
  escapeRegExp,
  inSuite,
  messagePattern,
  parseArgs,
  processFailures,
  readResults,
  runFileName,
  runRoots,
  shardFiles,
  testNodeFlags,
  timingsFileName,
  timingsOf,
  heaviestFirst,
  laneLease,
  WINDOWS_COMMAND_LINE_LIMIT,
  assertCommandFits,
  testCommand,
  testFilePattern,
  windowsCommandLineLength,
  unmeasuredCoverage,
  workspaceSlug,
} from '../run-tests.mjs';
import { acquire } from '../machine-budget.mjs';
import { run } from '../subprocess.mjs';

const SCRIPTS = [
  'run-tests.mjs',
  'expected-failures.mjs',
  'subprocess.mjs',
  'workspaces.mjs',
  'test-reporter.mjs',
  'test-preload.mjs',
  'disk-temp.mjs',
  'machine-budget.mjs',
  'process-tree.mjs',
  'test-budget.mjs',
];

const scratch = mkdtempSync(join(tmpdir(), 'jsails-run-tests-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('parseArgs', () => {
  it('separates runner options from forwarded flags', () => {
    assert.deepEqual(parseArgs(['--suite=database', '--shard=2/3', '--coverage', '--test-only']), {
      suite: 'database',
      shard: { index: 2, total: 3 },
      coverage: true,
      forwarded: ['--test-only'],
    });
  });

  it('rejects an unknown suite and a malformed shard', () => {
    assert.throws(() => parseArgs(['--suite=mysql']), /--suite/);
    assert.throws(() => parseArgs(['--shard=0/2']), /--shard/);
    assert.throws(() => parseArgs(['--shard=3/2']), /--shard/);
  });
});

describe('shardFiles', () => {
  it('places every file in exactly one shard, with balanced sizes', () => {
    const files = Array.from(
      { length: 23 },
      (_, index) => `f${String(index).padStart(2, '0')}.test.js`,
    );
    for (const total of [1, 2, 3, 4, 7, 30]) {
      const shards = Array.from({ length: total }, (_, index) =>
        shardFiles(files, { index: index + 1, total }),
      );
      const all = shards.flat();
      assert.equal(all.length, files.length, `total ${total}`);
      assert.deepEqual([...all].sort(), [...files].sort());
      const sizes = shards.map((shard) => shard.length);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    }
  });

  it('does not depend on the input order', () => {
    const files = ['c.test.js', 'a.test.js', 'b.test.js'];
    assert.deepEqual(shardFiles(files, { index: 1, total: 2 }), ['a.test.js', 'c.test.js']);
  });
});

describe('inSuite', () => {
  it('runs every file in the default suite and only database files in the database suite', () => {
    assert.equal(inSuite('/x/store.test.js', 'default'), true);
    assert.equal(inSuite('/x/store.database.test.js', 'default'), true);
    assert.equal(inSuite('/x/store.test.js', 'database'), false);
    assert.equal(inSuite('/x/store.database.test.js', 'database'), true);
  });
});

describe('readResults', () => {
  it('requires the end record to call a run complete', () => {
    const line = JSON.stringify({ type: 'result', file: 'a', path: ['x'], outcome: 'pass' });
    assert.equal(readResults(`${line}\n`).complete, false);
    const done = readResults(`${line}\n{"type":"coverage","totals":{"lines":1}}\n{"type":"end"}\n`);
    assert.equal(done.complete, true);
    assert.equal(done.results.length, 1);
    assert.deepEqual(done.coverage, { lines: 1 });
    assert.equal(done.coverageUnavailable, undefined);
  });

  it('carries the message of a coverage run node could not measure', () => {
    const text = `{"type":"coverage-unavailable","message":"Warning: Code coverage could not be enabled. Error: ENOSPC"}\n{"type":"end"}\n`;
    assert.match(readResults(text).coverageUnavailable, /ENOSPC/);
  });

  it('carries the error of a coverage dump node could not write', () => {
    const text = `{"type":"coverage-incomplete","message":"ENOSPC: Failed to write file /t/coverage-1.json"}\n{"type":"end"}\n`;
    assert.match(readResults(text).coverageIncomplete, /ENOSPC/);
  });
});

describe('unmeasuredCoverage', () => {
  it('rejects totals node could not measure, or measured over a lost dump', () => {
    assert.equal(unmeasuredCoverage({ lowestFreeMb: COVERAGE_MIN_FREE_MB }), undefined);
    assert.equal(unmeasuredCoverage({}), undefined);
    assert.match(unmeasuredCoverage({ unavailable: 'Warning: ENOENT' }), /ENOENT/);
    assert.match(
      unmeasuredCoverage({ incomplete: 'ENOSPC: Failed to write file /t/coverage-1.json' }),
      /a coverage dump was not written \(ENOSPC/,
    );
    // A disk that came this close to full may have lost a dump between two samples.
    assert.match(
      unmeasuredCoverage({ lowestFreeMb: COVERAGE_MIN_FREE_MB - 1 }),
      /came within 255 MiB of full/,
    );
  });
});

describe('checkCoverage', () => {
  const floor = { lines: 80, branches: 70, functions: 75 };

  it('passes at or above the floor', () => {
    assert.deepEqual(checkCoverage('w', { lines: 80, branches: 71, functions: 99 }, floor), []);
  });

  it('fails each metric below its floor', () => {
    const messages = checkCoverage('w', { lines: 79.99, branches: 70, functions: 10 }, floor);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /w lines coverage 79\.99% is below its floor of 80%/);
  });

  it('does not fail a workspace without a floor yet, but fails a missing measurement', () => {
    assert.deepEqual(checkCoverage('w', { lines: 1 }, undefined), []);
    assert.match(checkCoverage('w', undefined, floor)[0], /no coverage was reported/);
  });
});

describe('processFailures', () => {
  const clean = { errors: 0, exitCode: 0, exitCalls: [] };
  const messages = (records, failing = new Set()) =>
    processFailures(['/a.test.js'], new Map(Object.entries(records)), failing).map(
      (result) => result.message,
    );

  it('accepts a clean exit, and status 1 with a failing test', () => {
    assert.deepEqual(messages({ '/a.test.js': clean }), []);
    assert.deepEqual(
      messages({ '/a.test.js': { ...clean, exitCode: 1 } }, new Set(['/a.test.js'])),
      [],
    );
  });

  it('reports every way a process can end badly, as file-level process failures', () => {
    assert.match(messages({})[0], /no exit record/);
    assert.deepEqual(
      messages({
        '/a.test.js': {
          ...clean,
          errors: 3,
          events: [{ kind: 'unhandled rejection', message: 'late' }],
          exitCode: 1,
        },
      }),
      [
        'unhandled rejection: late',
        '2 more unhandled rejection(s) or uncaught exception(s); see "[run-tests]" in the output',
      ],
    );
    assert.deepEqual(messages({ '/a.test.js': { ...clean, exitCode: 7, exitCalls: [7] } }), [
      'test code called process.exit(7)',
      'the test process exited with status 7',
    ]);
    assert.match(
      messages({ '/a.test.js': { ...clean, exitCode: 1 } })[0],
      /without a failing test/,
    );
    const [result] = processFailures(['/a.test.js'], new Map(), new Set());
    assert.equal(result.fileLevel, true);
    assert.equal(result.failureType, 'processFailure');
  });
});

describe('workspaceSlug', () => {
  it('turns a scoped name into a file name', () => {
    assert.equal(workspaceSlug('@jsails/admin'), 'jsails-admin');
  });
});

describe('runFileName', () => {
  it('names a default run after its workspace and keeps database and shard runs apart', () => {
    assert.equal(runFileName('@jsails/jobs'), 'jsails-jobs.json');
    assert.equal(
      runFileName('jsails', { suite: 'database', database: 'mariadb' }),
      'jsails.database-mariadb.json',
    );
    assert.equal(
      runFileName('jsails', { suite: 'default', shard: { index: 2, total: 4 } }),
      'jsails.shard-2-of-4.json',
    );
  });

  it('keeps runs against different servers and with declared services apart', () => {
    const names = [
      runFileName('jsails', { suite: 'database', database: 'mariadb' }),
      runFileName('jsails', { suite: 'database', database: 'postgres' }),
      runFileName('@jsails/jobs', { services: [] }),
      runFileName('@jsails/jobs', { services: ['valkey'] }),
    ];
    assert.deepEqual(names, [
      'jsails.database-mariadb.json',
      'jsails.database-postgres.json',
      'jsails-jobs.json',
      'jsails-jobs.valkey.json',
    ]);
    assert.equal(
      runFileName('@jsails/jobs', {
        suite: 'database',
        database: 'postgres',
        services: ['zeta', 'valkey'],
        shard: { index: 1, total: 2 },
      }),
      'jsails-jobs.database-postgres.valkey.zeta.shard-1-of-2.json',
    );
  });
});

describe('messagePattern', () => {
  const roots = runRoots(['/home/runner/work/jsails/jsails', '/tmp', '/home/runner'], false);

  it('turns a path under the checkout, the temporary or the home directory into a wildcard', () => {
    const seen =
      "ENOENT: no such file or directory, open '/tmp/jsails-a1B2/app/config.js' from /home/runner/work/jsails/jsails/core/dist/x.js:12:3";
    const pattern = messagePattern(seen, roots);
    assert.equal(pattern, "ENOENT: no such file or directory, open '.*' from .*");
    const elsewhere =
      "ENOENT: no such file or directory, open '/tmp/jsails-Zz99/app/config.js' from /home/runner/work/jsails/jsails/core/dist/x.js:14:9";
    assert.match(elsewhere, new RegExp(pattern));
  });

  it('matches a forward-slash or file URL form of a Windows path', () => {
    const windows = runRoots(['C:\\Users\\runneradmin\\AppData\\Local\\Temp'], true);
    assert.ok(windows.includes('C:/Users/runneradmin/AppData/Local/Temp'));
    assert.equal(
      messagePattern(
        'cannot load C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x-1\\a.js or file:///C:/Users/runneradmin/AppData/Local/Temp/x-1/b.js',
        windows,
      ),
      'cannot load .* or .*',
    );
  });

  it('turns a loopback port into digits and leaves other numbers literal', () => {
    const pattern = messagePattern('connect ECONNREFUSED 127.0.0.1:34711 after 3 tries', roots);
    assert.equal(pattern, 'connect ECONNREFUSED 127\\.0\\.0\\.1:\\d+ after 3 tries');
    assert.match('connect ECONNREFUSED 127.0.0.1:50122 after 3 tries', new RegExp(pattern));
    assert.equal(messagePattern('http://localhost:8080/x', []), 'http://localhost:\\d+/x');
  });

  it('counts a root only as a whole path segment and never treats the file-system root as one', () => {
    assert.equal(messagePattern('mounted /tmpfs/a', roots), 'mounted /tmpfs/a');
    assert.deepEqual(runRoots(['/'], false), []);
    assert.deepEqual(runRoots(['C:\\'], true), []);
  });

  it('keeps at most the limit of the text without cutting a wildcard or an escape', () => {
    assert.equal(messagePattern('a.b.c.d', [], 3), 'a\\.b');
    assert.equal(messagePattern('ab /tmp/x/y cd', roots, 4), 'ab .*');
    assert.equal(messagePattern('ab /tmp/x/y cd', roots, 2), 'ab');
  });
});

describe('draftEntry', () => {
  const linux = { platform: 'linux', suite: 'default', database: 'sqlite', services: [] };
  const failure = {
    file: 'core/test/a.test.ts',
    path: ['outer', 'broken'],
    fileLevel: false,
    failureType: 'testCodeFailure',
    errorName: 'AssertionError',
    message: 'Expected values (1 + 2) to be equal:\n\n1 !== 2\n',
  };

  it('states the first message line literally, the error class, and no default type', () => {
    const entry = draftEntry(failure, linux);
    assert.deepEqual(entry, {
      file: 'core/test/a.test.ts',
      test: ['outer', 'broken'],
      failure: { message: 'Expected values \\(1 \\+ 2\\) to be equal:', name: 'AssertionError' },
    });
    assert.match(failure.message, new RegExp(entry.failure.message));
  });

  it('drafts a message that a run at another path and port still matches', () => {
    const roots = runRoots(['/work/one'], false);
    const entry = draftEntry(
      { ...failure, message: 'connect ECONNREFUSED 127.0.0.1:4100 (/work/one/core/x.js)' },
      linux,
      roots,
    );
    assert.equal(entry.failure.message, 'connect ECONNREFUSED 127\\.0\\.0\\.1:\\d+ \\(.*\\)');
    assert.match(
      'connect ECONNREFUSED 127.0.0.1:5200 (/work/two/core/x.js)',
      new RegExp(entry.failure.message),
    );
  });

  it('scopes the entry to the platform, server database, and services of the run', () => {
    const entry = draftEntry(failure, {
      platform: 'win32',
      suite: 'database',
      database: 'mariadb',
      services: ['valkey'],
    });
    assert.deepEqual(entry.platforms, ['win32']);
    assert.deepEqual(entry.databases, ['mariadb']);
    assert.deepEqual(entry.services, ['valkey']);
  });

  it('drafts a whole-file entry for a process failure, naming its type', () => {
    const entry = draftEntry(
      {
        file: 'core/test/a.test.ts',
        path: ['(test process)'],
        fileLevel: true,
        failureType: 'processFailure',
        message: 'unhandled rejection: late',
      },
      linux,
    );
    assert.deepEqual(entry, {
      file: 'core/test/a.test.ts',
      failure: { message: 'unhandled rejection: late', type: 'processFailure' },
    });
  });

  it('escapes every regular-expression metacharacter', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    assert.equal(new RegExp(`^${escapeRegExp(text)}$`).test(text), true);
  });
});

let repoCounter = 0;

/**
 * A throwaway repository holding copies of the runner scripts, one workspace
 * (`packages/demo`) with the given compiled tests (and empty sources), and
 * the given ledgers.
 */
function fixtureRepo({ tests, ledgers = {}, src = {}, modules = {}, floors }) {
  repoCounter += 1;
  const root = join(scratch, `repo-${repoCounter}`);
  const ws = join(root, 'packages', 'demo');
  mkdirSync(join(root, 'scripts', 'expected-failures'), { recursive: true });
  for (const script of SCRIPTS) {
    copyFileSync(join(import.meta.dirname, '..', script), join(root, 'scripts', script));
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: ['packages/*'] }),
  );
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    join(ws, 'package.json'),
    JSON.stringify({ name: '@fixture/demo', type: 'module' }),
  );
  for (const [name, body] of Object.entries(tests)) {
    const compiled = join(ws, 'dist', 'test', `${name}.js`);
    mkdirSync(dirname(compiled), { recursive: true });
    writeFileSync(compiled, body);
    mkdirSync(dirname(join(ws, 'test', name)), { recursive: true });
    writeFileSync(join(ws, 'test', `${name}.ts`), '');
  }
  for (const [name, body] of Object.entries(src)) {
    mkdirSync(join(ws, 'dist', 'src'), { recursive: true });
    writeFileSync(join(ws, 'dist', 'src', name), body);
  }
  // Compiled test modules that are not test files (shared scenario modules).
  for (const [name, body] of Object.entries(modules)) {
    mkdirSync(dirname(join(ws, 'dist', 'test', name)), { recursive: true });
    writeFileSync(join(ws, 'dist', 'test', name), body);
  }
  for (const [name, entries] of Object.entries(ledgers)) {
    writeFileSync(
      join(root, 'scripts', 'expected-failures', `${name}.json`),
      JSON.stringify({ description: 'Fixture ledger.', kind: 'tests', entries }),
    );
  }
  if (floors !== undefined) {
    writeFileSync(
      join(root, 'coverage-floors.json'),
      JSON.stringify({ workspaces: { '@fixture/demo': floors } }),
    );
  }
  return { root, ws };
}

async function runIn(ws, args = [], env = {}) {
  const outcome = await run(
    process.execPath,
    [join(ws, '..', '..', 'scripts', 'run-tests.mjs'), ...args],
    {
      cwd: ws,
      capture: true,
      env: {
        ...process.env,
        JSAILS_TEST_CONCURRENCY: '',
        // Each fixture run leases from a budget of its own, never the machine's.
        JSAILS_BUDGET_DIR: join(ws, '..', '..', 'budget'),
        JSAILS_BUDGET_HOLDER: '',
        ...env,
      },
    },
  );
  return outcome;
}

const FAILING = `import test from 'node:test';
import assert from 'node:assert/strict';
test('outer', async (t) => {
  await t.test('broken', () => assert.equal(1, 2));
  await t.test('fine', () => {});
});
`;
const PASSING = `import test from 'node:test';
test('outer', async (t) => {
  await t.test('broken', () => {});
});
`;
const listed = {
  file: 'packages/demo/test/a.test.ts',
  test: ['outer', 'broken'],
  failure: { message: '1 !== 2', name: 'AssertionError' },
  reason: 'Fixture defect.',
  fixedBy: 'KRN-01',
};

// Each case starts a runner, node --test and its test processes: a few at a
// time, not every case at once.
describe('run-tests end to end', { concurrency: 4 }, () => {
  it('passes when the only failure is listed', async () => {
    const { ws } = fixtureRepo({ tests: { 'a.test': FAILING }, ledgers: { demo: [listed] } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 0, outcome.output);
    assert.match(outcome.output, /1 expected failure\(s\)/);
  });

  it('fails on a failure no ledger lists', async () => {
    const { ws } = fixtureRepo({ tests: { 'a.test': FAILING } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1);
    assert.match(
      outcome.output,
      /unexpected failure: packages\/demo\/test\/a\.test\.ts > outer > broken/,
    );
  });

  it('fails when a listed test passes', async () => {
    const { ws } = fixtureRepo({ tests: { 'a.test': PASSING }, ledgers: { demo: [listed] } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1);
    assert.match(outcome.output, /listed as failing but passes: .*demo\.json/);
  });

  it('fails when a listed test no longer exists', async () => {
    const { ws } = fixtureRepo({
      tests: { 'a.test': FAILING },
      ledgers: { demo: [listed, { ...listed, test: ['outer', 'renamed'] }] },
    });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1);
    assert.match(outcome.output, /listed test did not run: .*outer > renamed/);
  });

  it('fails when a listed test fails for another reason than its entry states', async () => {
    const crashing = FAILING.replace('assert.equal(1, 2)', 'null.property');
    const { ws } = fixtureRepo({ tests: { 'a.test': crashing }, ledgers: { demo: [listed] } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1);
    assert.match(
      outcome.output,
      /listed test fails for another reason: .*got testCodeFailure: TypeError/,
    );
    assert.doesNotMatch(outcome.output, /listed as failing but passes/);
  });

  it('does not expect a listed test that times out', async () => {
    const slow = FAILING.replace(
      "t.test('broken', () => assert.equal(1, 2))",
      "t.test('broken', { timeout: 20 }, () => new Promise((resolve) => setTimeout(resolve, 2000)))",
    );
    const { ws } = fixtureRepo({ tests: { 'a.test': slow }, ledgers: { demo: [listed] } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1);
    assert.match(outcome.output, /fails for another reason: .*got testTimeoutFailure/);
  });

  // node:test stops reporting a file once one of its tests has failed, so in a
  // file with a listed failure only the preload's record can catch these.
  // Each message below comes from the preload's record; node itself reports
  // nothing for these files beyond the listed failure.
  const lateAfterListed = {
    'late rejection': [
      `setTimeout(() => { Promise.reject(new Error('late')); }, 30);`,
      /\(test process\) \(unhandled rejection: late\)/,
    ],
    'late uncaught exception': [
      `setTimeout(() => { throw new Error('late'); }, 30);`,
      /\(test process\) \(uncaught exception: late\)/,
    ],
    'late process.exit(7)': [
      `setTimeout(() => process.exit(7), 200);`,
      /\(test process\) \(test code called process\.exit\(7\)\)/,
    ],
    'late process.exit(1)': [
      `setTimeout(() => process.exit(1), 200);`,
      /\(test process\) \(test code called process\.exit\(1\)\)/,
    ],
  };
  for (const [label, [body, expected]] of Object.entries(lateAfterListed)) {
    it(`fails on a ${label} in a file whose only failure is listed`, async () => {
      const source = `${FAILING}test('ends first', () => { ${body} });\n`;
      const { ws } = fixtureRepo({ tests: { 'a.test': source }, ledgers: { demo: [listed] } });
      const outcome = await runIn(ws);
      assert.equal(outcome.code, 1, outcome.output);
      assert.match(outcome.output, expected);
      assert.match(outcome.output, /1 expected failure/, 'the listed failure itself still matches');
    });
  }

  it('fails a test file that never reaches its exit handler', async () => {
    const source = `import test from 'node:test';
test('killed', () => { process.kill(process.pid, 'SIGKILL'); });
`;
    const { ws } = fixtureRepo({ tests: { 'a.test': source } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1, outcome.output);
    assert.match(outcome.output, /no exit record/);
  });

  it('lets a whole-file entry expect a process failure', async () => {
    const source = `import test from 'node:test';
test('ends first', () => { setTimeout(() => { Promise.reject(new Error('late')); }, 30); });
`;
    const { ws } = fixtureRepo({
      tests: { 'a.test': source },
      ledgers: {
        demo: [
          {
            file: 'packages/demo/test/a.test.ts',
            failure: { message: 'unhandled' },
            reason: 'Fixture leak.',
            fixedBy: 'KRN-01',
          },
        ],
      },
    });
    const outcome = await runIn(ws);
    // node's own file-level "test failed" for the file is the same event and
    // is not reported beside the preload's record of it.
    assert.equal(outcome.code, 0, outcome.output);
    assert.match(outcome.output, /\(test process\) \[demo: KRN-01\]/);
  });

  it('does not let a process a test spawns write a record in its name', async () => {
    const source = `import test from 'node:test';
import { spawnSync } from 'node:child_process';
test('spawns itself', () => {
  if (process.env.FIXTURE_CHILD === '1') return;
  spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
    env: { ...process.env, FIXTURE_CHILD: '1' },
    stdio: 'ignore',
  });
});
if (process.env.FIXTURE_CHILD === '1') setTimeout(() => process.exit(9), 10);
`;
    const { ws } = fixtureRepo({ tests: { 'a.test': source } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 0, outcome.output);
  });

  it('fails a file whose rejection arrives after its tests ended', async () => {
    const late = `import test from 'node:test';
test('ends first', () => {
  setTimeout(() => { Promise.reject(new Error('late')); }, 30);
});
`;
    const { ws } = fixtureRepo({ tests: { 'late.test': late } });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 1);
    assert.match(outcome.output, /unexpected failure: packages\/demo\/test\/late\.test\.ts/);
  });

  it('applies a platform-scoped entry only on that platform', async () => {
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    const { ws } = fixtureRepo({
      tests: { 'a.test': FAILING },
      ledgers: { demo: [{ ...listed, platforms: [other] }] },
    });
    assert.equal((await runIn(ws)).code, 1);
  });

  it('enforces the coverage floor of the workspace', async () => {
    const tests = {
      'a.test': `import test from 'node:test';
import { used } from '../src/lib.js';
test('covers half', () => { used(); });
`,
    };
    const src = {
      'lib.js': `export function used() { return 1; }
export function unused() { return 2; }
`,
    };
    const low = fixtureRepo({ tests, src, floors: { lines: 0, branches: 0, functions: 0 } });
    const lowRun = await runIn(low.ws, ['--coverage']);
    assert.equal(lowRun.code, 0, lowRun.output);
    const measured = JSON.parse(
      readFileSync(join(low.root, 'test-results', 'coverage', 'fixture-demo.json'), 'utf8'),
    );
    assert.equal(measured.functions, 50);

    const high = fixtureRepo({ tests, src, floors: { lines: 0, branches: 0, functions: 51 } });
    const highRun = await runIn(high.ws, ['--coverage']);
    assert.equal(highRun.code, 1);
    assert.match(highRun.output, /functions coverage 50\.00% is below its floor of 51%/);
  });

  it('fails a coverage run in which a dump was not written, and records no totals', async () => {
    // node's own line for a dump it could not write (a full disk mid-run); it
    // then merges the dumps that exist and reports totals as usual.
    const { root, ws } = fixtureRepo({
      tests: {
        'a.test': `import test from 'node:test';
test('loses its dump', () => {
  process.on('exit', () => process.stderr.write('ENOSPC: Failed to write file /t/coverage-1-2-3.json\\n'));
});
`,
      },
      floors: { lines: 0, branches: 0, functions: 0 },
    });
    const outcome = await runIn(ws, ['--coverage']);
    assert.equal(outcome.code, 1, outcome.output);
    assert.match(
      outcome.output,
      /coverage was not measured: a coverage dump was not written \(ENOSPC: Failed to write file/,
    );
    assert.equal(existsSync(join(root, 'test-results', 'coverage', 'fixture-demo.json')), false);
  });

  it(
    'records an interrupted run as interrupted, with no stale entries or drafts',
    { skip: process.platform === 'win32' && 'SIGTERM cannot be handled on Windows' },
    async () => {
      // The listed test never gets to run, which a reconciled verdict would
      // report as stale; an interrupted run must not.
      const { root, ws } = fixtureRepo({
        tests: {
          'a.test': `import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('slow', async () => {
  writeFileSync(process.env.STARTED_MARKER, '');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`,
          'b.test': PASSING,
        },
        ledgers: {
          demo: [{ ...listed, file: 'packages/demo/test/missing.test.ts', test: ['gone'] }],
        },
      });
      const marker = join(root, 'started');
      const child = spawn(process.execPath, [join(root, 'scripts', 'run-tests.mjs')], {
        cwd: ws,
        env: { ...process.env, JSAILS_TEST_CONCURRENCY: '', STARTED_MARKER: marker },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 50));
      child.kill('SIGTERM');
      assert.equal(await exited, 143, output);
      assert.match(output, /test run interrupted by SIGTERM; its results were not reconciled/);
      assert.doesNotMatch(output, /listed test did not run/);
      const record = JSON.parse(
        readFileSync(join(root, 'test-results', 'reconcile', 'fixture-demo.json'), 'utf8'),
      );
      assert.equal(record.ok, false);
      assert.equal(record.interrupted, 'SIGTERM');
      assert.deepEqual(record.stale, []);
      assert.deepEqual(record.drafts, []);
    },
  );

  it('stops a run that passes its limit and names the file still running', async () => {
    // The test passes, but its process keeps an interval alive, so node --test
    // would wait on it forever.
    const { ws } = fixtureRepo({
      tests: {
        'hang.test': `import test from 'node:test';
test('passes but leaks a handle', () => { setInterval(() => {}, 1000); });
`,
        'b.test': PASSING,
      },
    });
    // The limit must leave b.test time to start and finish on a loaded
    // four-core runner (3 s did not, with the other suites running alongside);
    // the run then always lasts the full limit, because hang.test never ends.
    const started = Date.now();
    const outcome = await runIn(ws, [], { JSAILS_TEST_RUN_TIMEOUT_MS: '10000' });
    assert.equal(outcome.code, 1, outcome.output);
    assert.ok(Date.now() - started < 60_000, 'the run was not stopped at its limit');
    assert.match(outcome.output, /passed its 10000 ms limit \(JSAILS_TEST_RUN_TIMEOUT_MS\)/);
    assert.match(outcome.output, /unexpected failure: packages\/demo\/test\/hang\.test\.ts/);
    assert.doesNotMatch(outcome.output, /unexpected failure: packages\/demo\/test\/b\.test\.ts/);
  });

  it('keeps an interrupted record free of results', () => {
    const record = interruptedRecord({ workspace: '@fixture/demo', suite: 'default' }, 'SIGINT');
    assert.equal(record.ok, false);
    assert.equal(record.interrupted, 'SIGINT');
    for (const key of ['unexpectedFailures', 'mismatched', 'unexpectedPasses', 'stale', 'drafts']) {
      assert.deepEqual(record[key], [], key);
    }
  });

  it('measures the same coverage on a warm compile cache as on a cold one', async () => {
    // V8 reports no counts for code compiled from the cache, so a coverage run
    // that used one would measure fewer covered branches on its second run.
    const { root, ws } = fixtureRepo({
      tests: {
        'a.test': `import test from 'node:test';
import { DemoError } from '../src/errors.js';
test('constructs', () => { new DemoError('c', 'x'); });
`,
      },
      src: {
        'base.js': `export class BaseError extends Error {
  constructor(message, options) { super(message); this.context = options?.context; }
}
`,
        'errors.js': `import { BaseError } from './base.js';
export class DemoError extends BaseError {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}
`,
      },
      floors: { lines: 0, branches: 0, functions: 0 },
    });
    const cache = join(root, 'compile-cache');
    const measure = async () => {
      const outcome = await runIn(ws, ['--coverage'], { NODE_COMPILE_CACHE: cache });
      assert.equal(outcome.code, 0, outcome.output);
      const { lines, branches, functions } = JSON.parse(
        readFileSync(join(root, 'test-results', 'coverage', 'fixture-demo.json'), 'utf8'),
      );
      return { lines, branches, functions };
    };
    const cold = await measure();
    assert.deepEqual(await measure(), cold);
  });

  it('gives the test child a compile cache only when it does not measure coverage', () => {
    const inherited = { NODE_COMPILE_CACHE: '/elsewhere', NODE_TEST_CONTEXT: 'child' };
    const plain = childEnvironment(inherited, { suite: 'default', coverage: false });
    assert.equal(plain.NODE_COMPILE_CACHE, '/elsewhere');
    assert.equal(plain.NODE_TEST_CONTEXT, undefined);
    assert.equal(plain.NODE_ENV, 'test');
    assert.equal(plain.JSAILS_TEST_SUITE, 'default');
    assert.ok(childEnvironment({}, { suite: 'default', coverage: false }).NODE_COMPILE_CACHE);
    const measured = childEnvironment(inherited, { suite: 'default', coverage: true });
    assert.equal('NODE_COMPILE_CACHE' in measured, false);
  });

  it('passes VALKEY_URL to the test child only when the run declares the valkey service', () => {
    const inherited = { VALKEY_URL: 'redis://127.0.0.1:6379' };
    const plain = childEnvironment(inherited, { suite: 'default', coverage: false });
    assert.equal('VALKEY_URL' in plain, false);
    const declared = childEnvironment(inherited, {
      suite: 'default',
      coverage: false,
      services: ['valkey'],
    });
    assert.equal(declared.VALKEY_URL, 'redis://127.0.0.1:6379');
  });

  it('runs the test child as the test environment, never an inherited resolution', () => {
    const fresh = childEnvironment(
      { JSAILS_ENV_RESOLVED: 'development:none:none' },
      { suite: 'default', coverage: false },
    );
    assert.equal(fresh.JSAILS_ENV, 'test');
    assert.equal(fresh.NODE_ENV, 'test');
    assert.equal('JSAILS_ENV_RESOLVED' in fresh, false);
    const chosen = childEnvironment(
      { NODE_ENV: 'production' },
      { suite: 'default', coverage: false },
    );
    assert.equal('JSAILS_ENV' in chosen, false);
  });

  it('runs only database files in the database suite, and needs a server type', async () => {
    const { ws } = fixtureRepo({ tests: { 'a.test': FAILING, 'store.database.test': PASSING } });
    const refused = await runIn(ws, ['--suite=database'], { DATABASE_TYPE: '' });
    assert.equal(refused.code, 2);
    const ok = await runIn(ws, ['--suite=database'], { DATABASE_TYPE: 'postgres' });
    assert.equal(ok.code, 0, ok.output);
    assert.doesNotMatch(ok.output, /a\.test/);
  });

  it('lists a suite declared in src/ or a shared test module under the test file that ran it', async () => {
    const suite = `import test from 'node:test';
import assert from 'node:assert/strict';
export function conformance(label) {
  test(\`conformance: \${label}\`, async (t) => {
    await t.test('broken', () => assert.equal(1, 2));
    await t.test('fine', () => {});
  });
}
`;
    const entryFor = (name, label) => ({
      ...listed,
      file: `packages/demo/test/${name}.test.ts`,
      test: [`conformance: ${label}`, 'broken'],
    });
    const { ws } = fixtureRepo({
      tests: {
        'a.test': `import { conformance } from '../src/suite.js';\nconformance('a');\n`,
        'b.test': `import { conformance } from './scenarios.js';\nconformance('b');\n`,
      },
      src: { 'suite.js': suite },
      modules: { 'scenarios.js': suite },
      ledgers: { demo: [entryFor('a', 'a'), entryFor('b', 'b')] },
    });
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 0, outcome.output);
    assert.match(outcome.output, /2 expected failure\(s\)/);
    assert.doesNotMatch(outcome.output, /without a failing test/);
  });

  it('applies a service-scoped entry only when the run declares the service', async () => {
    const live = `import test from 'node:test';
import assert from 'node:assert/strict';
const enabled = process.env.FIXTURE_LIVE === '1';
test('outer', async (t) => {
  await t.test('broken', { skip: enabled ? false : 'needs the service' }, () => assert.equal(1, 2));
});
`;
    const { root, ws } = fixtureRepo({
      tests: { 'a.test': live },
      ledgers: { demo: [{ ...listed, services: ['valkey'] }] },
    });
    const without = await runIn(ws, [], { JSAILS_TEST_SERVICES: '' });
    assert.equal(without.code, 0, without.output);
    const declared = await runIn(ws, [], { JSAILS_TEST_SERVICES: 'valkey', FIXTURE_LIVE: '1' });
    assert.equal(declared.code, 0, declared.output);
    assert.match(declared.output, /1 expected failure\(s\)/);
    // Each run keeps its own verdict and timings: the service run does not
    // overwrite the default run's.
    for (const dir of [['reconcile'], ['timings', 'tests']]) {
      const read = (name) =>
        JSON.parse(readFileSync(join(root, 'test-results', ...dir, name), 'utf8'));
      if (dir[0] === 'reconcile') {
        assert.deepEqual(read('fixture-demo.json').services, []);
        assert.deepEqual(read('fixture-demo.valkey.json').services, ['valkey']);
      } else {
        assert.equal(read('fixture-demo.valkey.json').workspace, '@fixture/demo');
        assert.equal(read('fixture-demo.json').workspace, '@fixture/demo');
      }
    }
    const undeclared = await runIn(ws, [], { JSAILS_TEST_SERVICES: '', FIXTURE_LIVE: '1' });
    assert.equal(undeclared.code, 1);
    assert.match(undeclared.output, /unexpected failure: packages\/demo\/test\/a\.test\.ts/);
    const unknown = await runIn(ws, [], { JSAILS_TEST_SERVICES: 'redis' });
    assert.equal(unknown.code, 2);
    assert.match(unknown.output, /unknown service\(s\) redis/);
  });

  it('writes a reconcile verdict whose drafts, given a reason, reconcile the run', async () => {
    // The second run is in another checkout and sees another port, as the next
    // CI run does: the drafts must still match it.
    const tests = {
      'a.test': FAILING,
      'late.test': `import test from 'node:test';
test('ends first', () => {
  setTimeout(() => { Promise.reject(new Error('late in ' + import.meta.filename)); }, 30);
});
`,
      'port.test': `import test from 'node:test';
test('outer', async (t) => {
  await t.test('refused', () => {
    const port = 20000 + Math.floor(Math.random() * 40000);
    throw new Error(\`connect ECONNREFUSED 127.0.0.1:\${port} from \${process.cwd()}\`);
  });
});
`,
    };
    const first = fixtureRepo({ tests });
    assert.equal((await runIn(first.ws, [], { JSAILS_TEST_SERVICES: '' })).code, 1);
    const verdict = JSON.parse(
      readFileSync(join(first.root, 'test-results', 'reconcile', 'fixture-demo.json'), 'utf8'),
    );
    assert.equal(verdict.workspace, '@fixture/demo');
    assert.equal(verdict.ok, false);
    assert.deepEqual(
      verdict.unexpectedFailures.map((failure) => [
        failure.file,
        failure.path.join(' > '),
        failure.failureType,
      ]),
      [
        ['packages/demo/test/a.test.ts', 'outer > broken', 'testCodeFailure'],
        ['packages/demo/test/port.test.ts', 'outer > refused', 'testCodeFailure'],
        ['packages/demo/test/late.test.ts', '(test process)', 'processFailure'],
      ],
    );
    for (const draft of verdict.drafts) {
      assert.doesNotMatch(draft.failure.message, /repo-\d/, 'no checkout path in a draft');
    }
    assert.equal(verdict.unexpectedFailures[0].errorName, 'AssertionError');
    assert.match(verdict.unexpectedFailures[0].message, /1 !== 2/);

    const entries = verdict.drafts.map((draft) => ({
      ...draft,
      reason: 'Fixture defect.',
      fixedBy: 'KRN-01',
    }));
    const second = fixtureRepo({ tests, ledgers: { demo: entries } });
    const rerun = await runIn(second.ws, [], { JSAILS_TEST_SERVICES: '' });
    assert.equal(rerun.code, 0, rerun.output);
    const clean = JSON.parse(
      readFileSync(join(second.root, 'test-results', 'reconcile', 'fixture-demo.json'), 'utf8'),
    );
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.unexpectedFailures, []);
  });

  it('writes per-file timings', async () => {
    const { root, ws } = fixtureRepo({ tests: { 'a.test': PASSING } });
    assert.equal((await runIn(ws)).code, 0);
    const record = JSON.parse(
      readFileSync(join(root, 'test-results', 'timings', 'tests', 'fixture-demo.json'), 'utf8'),
    );
    assert.deepEqual(
      record.files.map((file) => file.file),
      ['packages/demo/test/a.test.ts'],
    );
    assert.equal(typeof record.files[0].cpuMs, 'number');
  });

  it('runs exactly its selected files from nested directories', async () => {
    const { root, ws } = fixtureRepo({
      tests: {
        'cli.test': PASSING,
        'cli/serve.test': PASSING,
        'cli/deep/broken.test': `throw new Error('import failed');\n`,
      },
      ledgers: {
        demo: [
          {
            file: 'packages/demo/test/cli/deep/broken.test.ts',
            failure: { message: 'import failed' },
            reason: 'Fixture import error.',
            fixedBy: 'KRN-01',
          },
        ],
      },
    });
    // Compiled output whose source is gone is not selected, so it must not run.
    writeFileSync(join(ws, 'dist', 'test', 'cli', 'stale.test.js'), FAILING);
    const outcome = await runIn(ws);
    assert.equal(outcome.code, 0, outcome.output);
    // node names a file-level result after the relative path the glob matched.
    assert.match(outcome.output, /cli\/deep\/broken\.test\.ts > .*\[demo: KRN-01\]/);
    const record = JSON.parse(
      readFileSync(join(root, 'test-results', 'timings', 'tests', 'fixture-demo.json'), 'utf8'),
    );
    assert.deepEqual(record.files.map((file) => file.file).sort(), [
      'packages/demo/test/cli.test.ts',
      'packages/demo/test/cli/deep/broken.test.ts',
      'packages/demo/test/cli/serve.test.ts',
    ]);
  });
});

describe('memory settings of the test child', () => {
  it('runs node with a smaller young generation and a heap ceiling unless told otherwise', () => {
    assert.deepEqual(testNodeFlags({}), ['--max-semi-space-size=8', '--max-old-space-size=2048']);
    assert.deepEqual(testNodeFlags({ JSAILS_TEST_NODE_FLAGS: ' --optimize-for-size  ' }), [
      '--optimize-for-size',
    ]);
    assert.deepEqual(testNodeFlags({ JSAILS_TEST_NODE_FLAGS: '' }), []);
  });

  it('gives a coverage run a disk-backed TMPDIR and the original one to hand back', () => {
    const covered = childEnvironment(
      { TMPDIR: '/tmp' },
      { suite: 'default', coverage: true, coverageTemp: '/disk/coverage-1-abcdef' },
    );
    assert.equal(covered.TMPDIR, '/disk/coverage-1-abcdef');
    assert.equal(covered.JSAILS_TEST_TMPDIR, '/tmp');
    const unset = childEnvironment(
      {},
      { suite: 'default', coverage: true, coverageTemp: '/disk/x' },
    );
    assert.equal(unset.JSAILS_TEST_TMPDIR, '');
    const plain = childEnvironment(
      { TMPDIR: '/tmp' },
      { suite: 'default', coverage: false, coverageTemp: '/disk/x' },
    );
    assert.equal(plain.TMPDIR, '/tmp');
    assert.equal('JSAILS_TEST_TMPDIR' in plain, false);
  });

  it('caps the processes one test file starts at once', () => {
    const plain = childEnvironment({}, { suite: 'default', coverage: false });
    assert.equal(plain.JSAILS_TEST_SPAWN_CONCURRENCY, '2');
    const chosen = childEnvironment(
      { JSAILS_TEST_SPAWN_CONCURRENCY: '5' },
      { suite: 'default', coverage: false },
    );
    assert.equal(chosen.JSAILS_TEST_SPAWN_CONCURRENCY, '5');
  });

  it('keeps coverage timings apart from a plain run', () => {
    assert.equal(timingsFileName('@jsails/mcp'), 'jsails-mcp.json');
    assert.equal(timingsFileName('@jsails/mcp', { coverage: true }), 'jsails-mcp.coverage.json');
    assert.equal(
      timingsFileName('jsails', { coverage: true, suite: 'database', database: 'postgres' }),
      'jsails.database-postgres.coverage.json',
    );
  });

  it('records each file peak RSS and its process-tree peak', () => {
    const a = join('/r', 'core', 'dist', 'test', 'a.test.js');
    const b = join('/r', 'core', 'dist', 'test', 'b.test.js');
    const records = new Map([
      [a, { file: a, pid: 11, wallMs: 5, cpuMs: 2, rssMb: 90 }],
      [b, { file: b, pid: 12, wallMs: 9, cpuMs: 3 }],
    ]);
    const timings = timingsOf(records, join('/r', 'core'), new Map([[11, 140.4]]));
    assert.deepEqual(
      timings.map(({ wallMs, rssMb, treeMb }) => ({ wallMs, rssMb, treeMb })),
      [
        { wallMs: 9, rssMb: undefined, treeMb: undefined },
        { wallMs: 5, rssMb: 90, treeMb: 140 },
      ],
    );
  });
});

describe('laneLease', () => {
  const previous = {
    files: [
      { workspace: '@fixture/demo', file: 'packages/demo/test/a.test.ts', wallMs: 10, treeMb: 100 },
    ],
  };
  const files = ['packages/demo/test/a.test.ts', 'packages/demo/test/b.test.ts'];
  const fake = (grant) => {
    const calls = [];
    return {
      calls,
      acquireLease: async (request) => {
        calls.push(request);
        return { env: {}, nested: false, waitedMs: 0, release() {}, ...grant(request) };
      },
    };
  };

  it('takes a lane of its own when run directly and runs at what the grant allows', async () => {
    const { calls, acquireLease } = fake(() => ({ mb: 200 + 120 + 120, cpu: 4 }));
    const { concurrency } = await laneLease({
      workspace: '@fixture/demo',
      files,
      coverage: false,
      env: {},
      previous,
      acquireLease,
      parallelism: 12,
    });
    // a.test.ts: 100 x 1.2; b.test.ts has no record and takes the median.
    assert.deepEqual(calls, [
      {
        label: 'test:@fixture/demo',
        cpu: { need: 1, want: 2 },
        mb: { need: 200 + 120, want: 200 + 120 + 120 },
      },
    ]);
    assert.equal(concurrency, 2);
  });

  it('keeps a fixed concurrency, and the runner-given one under a holder', async () => {
    const { calls, acquireLease } = fake((request) => ({
      mb: request.mb.want,
      cpu: request.cpu.want,
    }));
    const fixed = await laneLease({
      workspace: '@fixture/demo',
      files,
      coverage: false,
      env: { JSAILS_TEST_CONCURRENCY: '3' },
      previous,
      acquireLease,
    });
    assert.equal(fixed.concurrency, 3);
    assert.deepEqual(calls[0].cpu, { need: 3, want: 3 });
    const forwarded = await laneLease({
      workspace: '@fixture/demo',
      files,
      coverage: false,
      forwarded: ['--test-concurrency=1'],
      env: {},
      previous,
      acquireLease,
    });
    assert.equal(forwarded.concurrency, 1);
    const nested = await laneLease({
      workspace: '@fixture/demo',
      files,
      coverage: false,
      env: {},
      previous,
      acquireLease: async () => ({ nested: true, mb: 1, cpu: 1, env: {}, release() {} }),
    });
    assert.equal(nested.concurrency, undefined);
  });

  it('returns each file estimate, by which the files start heaviest first', async () => {
    const { acquireLease } = fake((request) => ({ mb: request.mb.want, cpu: request.cpu.want }));
    const heavy = {
      files: [
        { workspace: '@fixture/demo', file: 'packages/demo/test/a.test.ts', treeMb: 100 },
        { workspace: '@fixture/demo', file: 'packages/demo/test/c.test.ts', treeMb: 300 },
      ],
    };
    const ordered = [...files, 'packages/demo/test/c.test.ts'];
    const { estimates } = await laneLease({
      workspace: '@fixture/demo',
      files: ordered,
      coverage: false,
      env: {},
      previous: heavy,
      acquireLease,
    });
    // b.test.ts has no record and takes the median of a (120) and c (360).
    assert.deepEqual(estimates, [120, 240, 360]);
    assert.deepEqual(heaviestFirst(ordered, estimates), [
      'packages/demo/test/c.test.ts',
      'packages/demo/test/b.test.ts',
      'packages/demo/test/a.test.ts',
    ]);
  });
});

describe('heaviestFirst', () => {
  it('orders by estimate, keeps the given order on ties, and treats a missing one as 0', () => {
    assert.deepEqual(heaviestFirst(['a', 'b', 'c', 'd'], [50, 90, 50]), ['b', 'a', 'c', 'd']);
    assert.deepEqual(heaviestFirst([], []), []);
  });
});

describe('testFilePattern', () => {
  const tree = join(scratch, 'pattern-tree');
  const ws = join(tree, 'ws');
  const compiled = (path) => join(ws, 'dist', 'test', ...path.split('/'));
  const all = [
    'cli.test.js',
    'cli/serve.test.js',
    'cli/serve-all.test.js',
    'cli/deep/one.test.js',
    'a.b.test.js',
    'app/starter.test.js',
    'app/starter.database.test.js',
    'solo/only.test.js',
  ];
  for (const path of all) {
    mkdirSync(dirname(compiled(path)), { recursive: true });
    writeFileSync(compiled(path), '');
  }
  const matched = (pattern) =>
    globSync(pattern, { cwd: ws })
      .map((path) => resolve(ws, path))
      .sort();

  it('writes each shared directory once and leaves no single alternative in braces', () => {
    assert.equal(
      testFilePattern([compiled('cli/serve.test.js'), compiled('cli/deep/one.test.js')], ws),
      'dist/test/cli/{serve,deep/one}.test.js',
    );
    assert.equal(
      testFilePattern([compiled('solo/only.test.js')], ws),
      'dist/test/solo/only.test.js',
    );
    assert.equal(
      testFilePattern([compiled('cli.test.js'), compiled('cli/serve.test.js')], ws),
      'dist/test/cli{,/serve}.test.js',
    );
  });

  it("matches exactly the selected files, through node's own glob", () => {
    const selections = [
      all,
      ['cli.test.js', 'cli/serve.test.js'],
      ['cli/serve-all.test.js', 'app/starter.database.test.js', 'a.b.test.js'],
      ['cli/deep/one.test.js'],
    ];
    for (const selection of selections) {
      const files = selection.map(compiled);
      assert.deepEqual(matched(testFilePattern(files, ws)), [...files].sort(), selection.join());
    }
  });

  it('does not grow with the checkout path', () => {
    const deep = join(scratch, 'a'.repeat(60), 'b'.repeat(60), 'ws');
    const at = (root) => all.map((path) => join(root, 'dist', 'test', ...path.split('/')));
    assert.equal(testFilePattern(at(deep), deep), testFilePattern(at(ws), ws));
  });

  it('refuses a name a glob would read as syntax, and a file outside the workspace', () => {
    for (const name of ['a{b,c}.test.js', 'a[1].test.js', 'a*.test.js', 'a b.test.js']) {
      assert.throws(() => testFilePattern([compiled(name)], ws), /glob syntax/);
    }
    assert.throws(
      () => testFilePattern([join(tree, 'other', 'x.test.js')], ws),
      /not a \*\.test\.js file under the workspace/,
    );
    assert.throws(() => testFilePattern([compiled('x.spec.js')], ws), /not a \*\.test\.js file/);
    assert.throws(() => testFilePattern([], ws), /no test files/);
  });
});

describe('the node --test command line', () => {
  it('measures it as libuv quotes it on Windows', () => {
    // command + space + arg for each argument.
    assert.equal(windowsCommandLineLength('node.exe', ['--test', 'a']), 8 + 1 + 6 + 1 + 1);
    assert.equal(windowsCommandLineLength('C:\\Program Files\\node.exe', []), 2 + 25);
    assert.equal(windowsCommandLineLength('n', ['']), 1 + 1 + 2);
    // "a \"b\"" : the quote escaped, the whole wrapped.
    assert.equal(windowsCommandLineLength('n', ['a "b"']), 1 + 1 + 9);
    // A trailing backslash before the closing quote is doubled.
    assert.equal(windowsCommandLineLength('n', ['a b\\']), 1 + 1 + 7);
  });

  it('accepts twice the largest suite today, named as briefly as its files are', () => {
    // core: 508 files, 13.9 pattern characters each; these take about 13.
    const ws = join(scratch, 'x'.repeat(200), 'ws');
    const files = Array.from({ length: 1500 }, (_, index) =>
      join(ws, 'dist', 'test', `area-${index % 40}`, `feature-${index}.test.js`),
    );
    const flags = ['--max-old-space-size=2048', '--test', `--import=${'p'.repeat(400)}`];
    const command = 'C:\\hostedtoolcache\\windows\\node\\26.0.0\\x64\\node.exe';
    const args = testCommand(files, { flags, workspaceDir: ws, command });
    assert.equal(args.length, flags.length + 1);
    assert.ok(windowsCommandLineLength(command, args) < WINDOWS_COMMAND_LINE_LIMIT);
  });

  it('refuses, naming the limit and the file count but no path, a command over the limit', () => {
    const secret = 'secret-checkout-path';
    const args = ['--test', `${secret}/${'x'.repeat(WINDOWS_COMMAND_LINE_LIMIT)}`];
    assert.throws(
      () => assertCommandFits('node.exe', args, 7),
      (error) => {
        assert.match(error.message, /for 7 test files .* over the 32767-character Windows limit/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
    // One character under the limit, with its NUL, still starts.
    const fits = ['x'.repeat(WINDOWS_COMMAND_LINE_LIMIT - 'n'.length - 1 - 1)];
    assert.doesNotThrow(() => assertCommandFits('n', fits, 1));
    assert.throws(() => assertCommandFits('n', [`${fits[0]}x`], 1), /Windows limit/);
  });
});

describe('run-tests under the machine budget', () => {
  it('waits for its lease before its run limit starts', async (t) => {
    const { root, ws } = fixtureRepo({ tests: { 'a.test': PASSING } });
    const holder = await acquire(
      { label: 'blocker', mb: { need: 500 } },
      {
        dir: join(root, 'budget'),
        env: {},
        config: { enabled: true, memoryMb: 500, cpu: 8, reserveMb: 0 },
      },
    );
    const released = setTimeout(() => holder.release(), 3000);
    t.after(() => {
      clearTimeout(released);
      holder.release();
    });
    // The lease waits about three seconds; a run limit counting the wait would stop the run.
    const outcome = await runIn(ws, [], {
      JSAILS_MEMORY_BUDGET_MB: '500',
      JSAILS_TEST_RUN_TIMEOUT_MS: '2000',
    });
    assert.equal(outcome.code, 0, outcome.output);
    assert.match(outcome.output, /\[budget\] test:@fixture\/demo is waiting/);
    const record = JSON.parse(
      readFileSync(join(root, 'test-results', 'timings', 'tests', 'fixture-demo.json'), 'utf8'),
    );
    assert.ok(record.waitMs >= 2000, `waited ${record.waitMs} ms`);
    assert.equal(typeof record.files[0].rssMb, 'number');
  });

  it('hands each test process of a coverage run the caller TMPDIR', async () => {
    const probe = `import test from 'node:test';
import assert from 'node:assert/strict';
test('sees the usual temporary directory', () => {
  assert.equal(process.env.TMPDIR, process.env.FIXTURE_TMPDIR || undefined);
  assert.equal(process.env.JSAILS_TEST_TMPDIR, undefined);
});
`;
    const { ws } = fixtureRepo({
      tests: { 'a.test': probe },
      src: { 'lib.js': 'export const x = 1;\n' },
      floors: { lines: 0, branches: 0, functions: 0 },
    });
    const outcome = await runIn(ws, ['--coverage'], { FIXTURE_TMPDIR: process.env.TMPDIR ?? '' });
    assert.equal(outcome.code, 0, outcome.output);
  });
});
