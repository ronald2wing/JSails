/**
 * Tests for `scripts/test-reporter.mjs` against real `node --test` output, not
 * synthetic records: node's result for a whole file is recognised whether the
 * file was passed as an absolute or a relative path or matched by the relative
 * glob `run-tests.mjs` passes, a test's own result is
 * not, a failure carries its type, error class, and message, and a result is
 * credited to the test file that ran it even when a shared module declared it,
 * and node's warning that it could not enable coverage, and its error that it
 * could not write a process's coverage dump, are reported.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { readResults, testFilePattern } from '../run-tests.mjs';
import { run } from '../subprocess.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jsails-reporter-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'broken-import.test.mjs'), "import './missing.mjs';\n");
// Laid out as a workspace's compiled tests, for the glob `run-tests.mjs` builds.
const compiled = join(dir, 'dist', 'test', 'a');
mkdirSync(compiled, { recursive: true });
const brokenCompiled = ['x', 'y'].map((name) => {
  const file = join(compiled, `${name}.test.js`);
  writeFileSync(file, "require('./missing.js');\n");
  return file;
});
writeFileSync(
  join(dir, 'kinds.test.mjs'),
  `import test from 'node:test';
import assert from 'node:assert/strict';
test('assertion', () => assert.equal(1, 2));
test('crash', () => { null.property; });
test('slow', { timeout: 20 }, () => new Promise((resolve) => setTimeout(resolve, 2000)));
test('fine', () => {});
`,
);

// A suite declared in a module that is not a test file, as a package's
// `src/testing` conformance suite is: each test file that calls it runs it.
mkdirSync(join(dir, 'src'));
writeFileSync(
  join(dir, 'src', 'suite.mjs'),
  `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
export function conformance(label) {
  describe(\`conformance: \${label}\`, () => {
    it('holds', () => {});
    it('breaks', () => assert.equal(label, 'never'));
  });
}
`,
);
for (const label of ['one', 'two']) {
  writeFileSync(
    join(dir, `${label}.test.mjs`),
    `import { conformance } from './src/suite.mjs';\nconformance('${label}');\n`,
  );
}

let runs = 0;

/**
 * The environment that points node's temporary directory at `path`:
 * `os.tmpdir()` reads `TMPDIR` on POSIX, and `TEMP`, then `TMP`, on Windows.
 */
function tempEnv(path) {
  return { TMPDIR: path, TEMP: path, TMP: path };
}

async function report(files, { flags = [], env: extra = {} } = {}) {
  runs += 1;
  const output = join(dir, `results-${runs}.jsonl`);
  const env = { ...process.env };
  if (process.platform === 'win32') {
    // Windows matches variable names without regard to case, so an inherited
    // `Temp` beside an override's `TEMP` would leave the child either one.
    const overridden = new Set(Object.keys(extra).map((key) => key.toUpperCase()));
    for (const key of Object.keys(env)) if (overridden.has(key.toUpperCase())) delete env[key];
  }
  Object.assign(env, extra);
  delete env.NODE_TEST_CONTEXT;
  await run(
    process.execPath,
    [
      '--test',
      ...flags,
      `--test-reporter=${pathToFileURL(join(import.meta.dirname, '..', 'test-reporter.mjs')).href}`,
      `--test-reporter-destination=${output}`,
      ...files,
    ],
    { cwd: dir, env, capture: true },
  );
  return readResults(readFileSync(output, 'utf8'));
}

describe('test-reporter on real node output', () => {
  for (const [label, file] of [
    ['an absolute', join(dir, 'broken-import.test.mjs')],
    ['a relative', 'broken-import.test.mjs'],
  ]) {
    it(`marks node's result for a file passed as ${label} path as file-level`, async () => {
      const { results, complete } = await report([file]);
      assert.equal(complete, true);
      assert.equal(results.length, 1);
      assert.equal(results[0].fileLevel, true);
      assert.equal(results[0].outcome, 'fail');
    });
  }

  it("marks node's result for each file the run-tests glob matches as file-level", async () => {
    const { results, complete } = await report([testFilePattern(brokenCompiled, dir)]);
    assert.equal(complete, true);
    assert.deepEqual(
      results.map((result) => [result.file, result.fileLevel, result.outcome]),
      // node resolves the glob against its working directory, which the OS
      // reports by its real path (`/private/var/…` for macOS's `/var/…`).
      brokenCompiled.map((file) => [realpathSync(file), true, 'fail']),
    );
  });

  it('records each test result with its failure type, error class, and message', async () => {
    const { results } = await report([join(dir, 'kinds.test.mjs')]);
    const byName = new Map(results.map((result) => [result.path.join(' > '), result]));
    assert.ok(results.every((result) => result.fileLevel === false));
    assert.equal(byName.get('assertion').failureType, 'testCodeFailure');
    assert.equal(byName.get('assertion').errorName, 'AssertionError');
    assert.match(byName.get('assertion').message, /1 !== 2/);
    assert.equal(byName.get('crash').errorName, 'TypeError');
    assert.equal(byName.get('slow').failureType, 'testTimeoutFailure');
    assert.equal(byName.get('fine').outcome, 'pass');
    assert.equal(byName.get('fine').errorName, undefined);
  });

  it('credits a result declared in a shared module to the test file that ran it', async () => {
    const files = ['one', 'two'].map((label) => join(dir, `${label}.test.mjs`));
    const { results } = await report(files);
    const seen = results
      .map((result) => `${result.file} | ${result.path.join(' > ')} | ${result.outcome}`)
      .sort();
    const expected = [
      `${files[0]} | conformance: one | fail`,
      `${files[0]} | conformance: one > breaks | fail`,
      `${files[0]} | conformance: one > holds | pass`,
      `${files[1]} | conformance: two | fail`,
      `${files[1]} | conformance: two > breaks | fail`,
      `${files[1]} | conformance: two > holds | pass`,
    ];
    assert.deepEqual(seen, expected.sort());
    assert.ok(results.every((result) => result.fileLevel === false));
  });

  it('reports that coverage could not be enabled, and only then', async () => {
    const file = join(dir, 'one.test.mjs');
    const flags = ['--experimental-test-coverage'];
    // node keeps the dumps under its temporary directory; a missing one (as a
    // full disk) leaves it measuring nothing, while it still reports totals.
    const broken = await report([file], { flags, env: tempEnv(join(dir, 'missing')) });
    assert.match(broken.coverageUnavailable, /Code coverage could not be enabled/);
    const working = await report([file], { flags });
    assert.equal(working.coverageUnavailable, undefined);
    assert.equal(working.coverageIncomplete, undefined);
    assert.notEqual(working.coverage, undefined);
  });

  it(
    'reports a coverage dump that could not be written',
    {
      skip:
        (process.platform === 'win32' && 'a read-only directory still takes files on Windows') ||
        (process.getuid?.() === 0 && 'root writes into a read-only directory'),
    },
    async () => {
      // As on a disk that fills up mid-run: the process's dump fails to write,
      // node merges the others and reports totals without a warning.
      const temp = join(dir, 'blocked-tmp');
      mkdirSync(temp);
      const file = join(dir, 'blocks-its-dump.test.mjs');
      writeFileSync(
        file,
        `import test from 'node:test';
import { chmodSync } from 'node:fs';
test('blocks its own coverage dump', () => { chmodSync(process.env.NODE_V8_COVERAGE, 0o555); });
`,
      );
      try {
        const blocked = await report([file], {
          flags: ['--experimental-test-coverage'],
          env: tempEnv(temp),
        });
        assert.match(blocked.coverageIncomplete, /^\w+: Failed to write file .*coverage-.*\.json$/);
        assert.equal(blocked.coverageUnavailable, undefined);
      } finally {
        // node may leave its read-only dump directory behind.
        for (const name of readdirSync(temp)) chmodSync(join(temp, name), 0o755);
      }
    },
  );
});
