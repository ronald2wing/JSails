/**
 * Tests for `scripts/test-reporter.mjs` against real `node --test` output, not
 * synthetic records: node's result for a whole file is recognised whether the
 * file was passed as an absolute or a relative path, a test's own result is
 * not, a failure carries its type, error class, and message, and a result is
 * credited to the test file that ran it even when a shared module declared it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { readResults } from '../run-tests.mjs';
import { run } from '../subprocess.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jsails-reporter-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'broken-import.test.mjs'), "import './missing.mjs';\n");
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

async function report(files) {
  runs += 1;
  const output = join(dir, `results-${runs}.jsonl`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await run(
    process.execPath,
    [
      '--test',
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
});
