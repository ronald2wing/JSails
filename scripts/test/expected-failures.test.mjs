/**
 * Tests for `scripts/expected-failures.mjs`: the ledger shape, cross-ledger
 * ownership, reconciliation of a run's results, and the gate ratchet.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  applies,
  declaredServices,
  failureMatches,
  ratchet,
  readGateLedger,
  readLedgers,
  reconcile,
  validateLedger,
} from '../expected-failures.mjs';

const root = mkdtempSync(join(tmpdir(), 'jsails-ledgers-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const file of [
  'core/test/a.test.ts',
  'core/test/b.test.ts',
  'packages/demo/test/c.test.tsx',
  'packages/demo/test/d.database.test.tsx',
]) {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), '');
}
mkdirSync(join(root, 'scripts', 'gates'), { recursive: true });
writeFileSync(join(root, 'scripts', 'gates', 'import-graph.mjs'), '');

const entry = (extra = {}) => ({
  file: 'core/test/a.test.ts',
  test: ['suite', 'case'],
  failure: { message: 'tenant' },
  reason: 'Known defect.',
  fixedBy: 'REQ-05',
  ...extra,
});
const ledger = (entries, extra = {}) => ({
  description: 'Demo ledger.',
  kind: 'tests',
  entries,
  ...extra,
});

describe('validateLedger', () => {
  it('accepts a well-formed tests ledger', () => {
    assert.deepEqual(
      validateLedger(
        'request.json',
        ledger([
          entry(),
          entry({
            test: undefined,
            failure: undefined,
            file: 'core/test/b.test.ts',
            platforms: ['win32'],
          }),
          entry({
            file: 'packages/demo/test/d.database.test.tsx',
            databases: ['postgres', 'mariadb'],
            failure: { message: '^tenant$', name: 'AssertionError', type: 'testCodeFailure' },
          }),
          entry({ file: 'packages/demo/test/c.test.tsx', databases: ['sqlite'] }),
          entry({ file: 'packages/demo/test/c.test.tsx', test: ['live'], services: ['valkey'] }),
        ]),
        { root },
      ),
      [],
    );
  });

  it('accepts a gate ledger whose gate exists', () => {
    const gate = {
      description: 'Import direction violations.',
      kind: 'gate',
      gate: 'import-graph',
      entries: [{ id: 'core/src/x.ts -> database', reason: 'Old seam.', fixedBy: 'KRN-22' }],
    };
    assert.deepEqual(validateLedger('import-graph.json', gate, { root }), []);
    assert.match(
      validateLedger('x.json', { ...gate, gate: 'missing' }, { root }).join('\n'),
      /no scripts\/gates\/missing\.mjs/,
    );
  });

  it('names a gate ledger after its gate, so a gate has one ledger', () => {
    const gate = { description: 'Violations.', kind: 'gate', gate: 'import-graph', entries: [] };
    assert.match(
      validateLedger('imports.json', gate, { root }).join('\n'),
      /the ledger of gate "import-graph" is import-graph\.json/,
    );
  });

  const cases = [
    ['a non-kebab name', 'Request.json', ledger([entry()]), /kebab-case/],
    [
      'an unknown top-level key',
      'a.json',
      ledger([entry()], { owner: 'x' }),
      /unknown key "owner"/,
    ],
    ['a missing reason', 'a.json', ledger([entry({ reason: ' ' })]), /"reason" is required/],
    ['a free-text fixedBy', 'a.json', ledger([entry({ fixedBy: 'later' })]), /fixedBy/],
    ['a non-test file', 'a.json', ledger([entry({ file: 'core/src/a.ts' })]), /test source path/],
    [
      'a missing file',
      'a.json',
      ledger([entry({ file: 'core/test/gone.test.ts' })]),
      /does not exist/,
    ],
    ['an empty name path', 'a.json', ledger([entry({ test: [] })]), /non-empty list of names/],
    ['an unknown platform', 'a.json', ledger([entry({ platforms: ['macos'] })]), /platforms/],
    ['an unknown database', 'a.json', ledger([entry({ databases: ['mysql'] })]), /databases/],
    ['an unknown service', 'a.json', ledger([entry({ services: ['redis'] })]), /"services"/],
    ['an empty service scope', 'a.json', ledger([entry({ services: [] })]), /"services"/],
    ['an unknown entry key', 'a.json', ledger([entry({ todo: true })]), /unknown key "todo"/],
    [
      'a per-test entry without a failure',
      'a.json',
      ledger([entry({ failure: undefined })]),
      /"failure" is required/,
    ],
    [
      'a per-test failure without a message',
      'a.json',
      ledger([entry({ failure: { name: 'AssertionError' } })]),
      /"failure.message" is a non-empty regular expression/,
    ],
    [
      'an invalid failure regex',
      'a.json',
      ledger([entry({ failure: { message: '(' } })]),
      /not a valid regular expression/,
    ],
    [
      'an unknown failure type',
      'a.json',
      ledger([entry({ failure: { message: 'x', type: 'hookFailure' } })]),
      /"failure.type" must be one of/,
    ],
    [
      'a process failure on a single test',
      'a.json',
      ledger([entry({ failure: { message: 'x', type: 'processFailure' } })]),
      /belongs to the whole file/,
    ],
    [
      'an unknown failure key',
      'a.json',
      ledger([entry({ failure: { message: 'x', code: 'E' } })]),
      /unknown "failure" key "code"/,
    ],
    [
      'an empty whole-file failure',
      'a.json',
      ledger([entry({ test: undefined, failure: {} })]),
      /at least one of/,
    ],
    [
      'a bad error class name',
      'a.json',
      ledger([entry({ failure: { message: 'x', name: 'not a class' } })]),
      /error class name/,
    ],
    [
      'a server-database scope on a file the database suite never runs',
      'a.json',
      ledger([entry({ databases: ['sqlite', 'postgres'] })]),
      /could never apply/,
    ],
    ['a duplicate entry', 'a.json', ledger([entry(), entry()]), /duplicate entry/],
    [
      'a file listed whole and per test',
      'a.json',
      ledger([entry(), entry({ test: undefined })]),
      /both as a whole file and per test/,
    ],
    ['an unscoped entry in a platform ledger', 'windows.json', ledger([entry()]), /"win32"/],
    [
      'a wrongly scoped entry in a platform ledger',
      'macos.json',
      ledger([entry({ platforms: ['win32'] })]),
      /"darwin"/,
    ],
    [
      'a gate key on a tests ledger',
      'a.json',
      ledger([entry()], { gate: 'x' }),
      /gate ledgers only/,
    ],
  ];
  for (const [label, name, value, pattern] of cases) {
    it(`rejects ${label}`, () => {
      assert.match(validateLedger(name, value, { root }).join('\n'), pattern);
    });
  }
});

describe('readLedgers', () => {
  const dirFor = (files) => {
    const dir = mkdtempSync(join(root, 'ledgers-'));
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    }
    return dir;
  };

  it('reads every ledger in name order', () => {
    const dir = dirFor({
      'b.json': ledger([entry({ file: 'core/test/b.test.ts' })]),
      'a.json': ledger([entry()]),
    });
    assert.deepEqual(
      readLedgers({ dir, root }).map((item) => item.name),
      ['a', 'b'],
    );
  });

  it('refuses the same test in two ledgers', () => {
    const dir = dirFor({ 'a.json': ledger([entry()]), 'b.json': ledger([entry()]) });
    assert.throws(() => readLedgers({ dir, root }), /also listed in a/);
  });

  it('refuses a whole-file entry beside another ledger entry for that file', () => {
    const dir = dirFor({
      'a.json': ledger([entry()]),
      'b.json': ledger([entry({ test: undefined })]),
    });
    assert.throws(() => readLedgers({ dir, root }), /listed as a whole file in b/);
  });

  it('reports invalid JSON with the file name', () => {
    const dir = dirFor({ 'a.json': '{' });
    assert.throws(() => readLedgers({ dir, root }), /a\.json: not valid JSON/);
  });

  it('treats an absent gate ledger as empty', () => {
    const dir = dirFor({});
    assert.deepEqual(readGateLedger('import-graph', { dir, root }).entries, []);
  });

  it('reads the repository ledgers', () => {
    assert.ok(Array.isArray(readLedgers()));
  });
});

describe('applies', () => {
  it('scopes by platform and database', () => {
    const context = { platform: 'linux', database: 'sqlite' };
    assert.equal(applies(entry(), context), true);
    assert.equal(applies(entry({ platforms: ['win32'] }), context), false);
    assert.equal(applies(entry({ databases: ['postgres'] }), context), false);
    assert.equal(applies(entry({ databases: ['sqlite'] }), context), true);
  });

  it('applies a service-scoped entry only to a run that declares every service it names', () => {
    const live = entry({ services: ['valkey'] });
    assert.equal(applies(live, { platform: 'linux', database: 'sqlite' }), false);
    assert.equal(applies(live, { platform: 'linux', database: 'sqlite', services: [] }), false);
    assert.equal(
      applies(live, { platform: 'linux', database: 'sqlite', services: ['valkey'] }),
      true,
    );
    assert.equal(
      applies(entry(), { platform: 'linux', database: 'sqlite', services: ['valkey'] }),
      true,
      'an unscoped entry applies whatever the run declares',
    );
  });
});

describe('declaredServices', () => {
  it('reads a comma-separated declaration, trimmed, deduplicated, and sorted', () => {
    assert.deepEqual(declaredServices(), []);
    assert.deepEqual(declaredServices(''), []);
    assert.deepEqual(declaredServices(' valkey , valkey,'), ['valkey']);
  });

  it('refuses an unknown service, so a misspelt declaration cannot disable scoped entries', () => {
    assert.throws(() => declaredServices('valkey,redis'), /unknown service\(s\) redis/);
  });
});

describe('failureMatches', () => {
  const failing = {
    failureType: 'testCodeFailure',
    errorName: 'AssertionError',
    message: 'Expected the tenant scope',
  };

  it('matches the message regex, the error class, and the failure type', () => {
    assert.equal(failureMatches(entry({ failure: { message: 'tenant scope' } }), failing), true);
    assert.equal(failureMatches(entry({ failure: { message: '^tenant' } }), failing), false);
    assert.equal(
      failureMatches(entry({ failure: { message: 'tenant', name: 'TypeError' } }), failing),
      false,
    );
  });

  it('never expects a timeout or a failing hook of a single test unless named', () => {
    for (const failureType of ['testTimeoutFailure', 'hookFailed']) {
      const other = { ...failing, failureType };
      assert.equal(failureMatches(entry(), other), false, failureType);
      assert.equal(
        failureMatches(entry({ failure: { message: 'tenant', type: failureType } }), other),
        true,
        failureType,
      );
    }
  });

  it('lets an unqualified whole-file entry match anything but a timeout', () => {
    const whole = entry({ test: undefined, failure: undefined });
    assert.equal(failureMatches(whole, { failureType: 'processFailure', message: 'x' }), true);
    assert.equal(failureMatches(whole, { failureType: 'hookFailed', message: 'x' }), true);
    assert.equal(failureMatches(whole, { failureType: 'testTimeoutFailure', message: 'x' }), false);
  });
});

describe('reconcile', () => {
  const file = 'core/test/a.test.ts';
  const result = (path, outcome, extra = {}) => ({
    file,
    path,
    outcome,
    fileLevel: false,
    ...(outcome === 'fail'
      ? { failureType: 'testCodeFailure', errorName: 'AssertionError', message: 'no tenant' }
      : {}),
    ...extra,
  });
  const base = {
    files: new Set([file]),
    context: { platform: 'linux', database: 'sqlite' },
  };

  it('accepts a listed failure and nothing else failing', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry()],
      results: [
        result(['suite', 'case'], 'fail'),
        result(['suite'], 'fail', { failureType: 'subtestsFailed' }),
        result(['other'], 'pass'),
      ],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.expected.length, 1);
  });

  it('fails on an unlisted failure', () => {
    const verdict = reconcile({
      ...base,
      entries: [],
      results: [result(['suite', 'case'], 'fail')],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.unexpectedFailures.length, 1);
  });

  it('fails when a listed test passes', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry()],
      results: [result(['suite', 'case'], 'pass')],
    });
    assert.deepEqual(
      verdict.unexpectedPasses.map((item) => item.outcome),
      ['pass'],
    );
  });

  it('fails when a listed test is skipped', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry()],
      results: [result(['suite', 'case'], 'skip')],
    });
    assert.deepEqual(
      verdict.unexpectedPasses.map((item) => item.outcome),
      ['skip'],
    );
  });

  it('fails on a listed test that no longer exists, unless the run was filtered', () => {
    const args = { ...base, entries: [entry()], results: [result(['renamed'], 'pass')] };
    assert.equal(reconcile(args).stale.length, 1);
    assert.equal(reconcile({ ...args, filtered: true }).ok, true);
  });

  it('counts a failing todo test as a failure', () => {
    const verdict = reconcile({
      ...base,
      entries: [],
      results: [result(['later'], 'fail', { todo: true })],
    });
    assert.equal(verdict.unexpectedFailures.length, 1);
  });

  it('lets a whole-file entry absorb every failure, including file-level ones', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry({ test: undefined, failure: undefined })],
      results: [
        result(['/abs/a.test.js'], 'fail', { fileLevel: true, message: 'test failed' }),
        result(['(test process)'], 'fail', { fileLevel: true, failureType: 'processFailure' }),
        result(['x'], 'fail', { failureType: 'hookFailed' }),
      ],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.expected.length, 3);
  });

  it('does not let a per-test entry absorb a file-level failure', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry()],
      results: [
        result(['suite', 'case'], 'fail'),
        result(['/abs/a.test.js'], 'fail', { fileLevel: true }),
      ],
    });
    assert.equal(verdict.unexpectedFailures.length, 1);
  });

  it('reports a listed test that fails for another reason, not as passing', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry({ failure: { message: 'tenant', name: 'AssertionError' } })],
      results: [
        result(['suite', 'case'], 'fail', {
          errorName: 'TypeError',
          message: 'tenant is undefined',
        }),
      ],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.mismatched.length, 1);
    assert.equal(verdict.unexpectedPasses.length, 0);
    assert.equal(verdict.unexpectedFailures.length, 0);
  });

  it('reports a listed test cancelled by its parent as failing for another reason', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry()],
      results: [
        result(['suite', 'case'], 'fail', { failureType: 'cancelledByParent' }),
        result(['suite'], 'fail', { failureType: 'hookFailed', message: 'tenant' }),
      ],
    });
    assert.equal(verdict.mismatched.length, 1);
    assert.equal(verdict.unexpectedFailures.length, 1, 'the hook failure is not listed');
  });

  it('lets a whole-file entry name the failure it expects', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry({ test: undefined, failure: { type: 'processFailure' } })],
      results: [
        result(['(test process)'], 'fail', { fileLevel: true, failureType: 'processFailure' }),
        result(['x'], 'fail'),
      ],
    });
    assert.equal(verdict.expected.length, 1);
    assert.equal(verdict.mismatched.length, 1);
  });

  it('fails a whole-file entry whose file passes', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry({ test: undefined })],
      results: [result(['x'], 'pass')],
    });
    assert.equal(verdict.unexpectedPasses.length, 1);
  });

  it('expects a service-scoped failure only in a run that declares the service', () => {
    const live = entry({ services: ['valkey'] });
    const skipped = reconcile({
      ...base,
      entries: [live],
      results: [result(['suite', 'case'], 'skip')],
    });
    assert.equal(skipped.ok, true, 'out of scope where the service is not declared');
    const declared = reconcile({
      ...base,
      context: { ...base.context, services: ['valkey'] },
      entries: [live],
      results: [result(['suite', 'case'], 'fail')],
    });
    assert.equal(declared.ok, true);
    assert.equal(declared.expected.length, 1);
    const passing = reconcile({
      ...base,
      context: { ...base.context, services: ['valkey'] },
      entries: [live],
      results: [result(['suite', 'case'], 'pass')],
    });
    assert.equal(passing.unexpectedPasses.length, 1);
  });

  it('ignores entries for files outside the run and for other platforms', () => {
    const verdict = reconcile({
      ...base,
      entries: [entry({ file: 'core/test/b.test.ts' }), entry({ platforms: ['win32'] })],
      results: [result(['suite', 'case'], 'pass')],
    });
    assert.equal(verdict.ok, true);
  });
});

describe('ratchet', () => {
  it('reports new violations and listed ones that are fixed', () => {
    const gate = { entries: [{ id: 'a' }, { id: 'b' }] };
    assert.deepEqual(ratchet(gate, ['b', 'c']), { unlisted: ['c'], fixed: ['a'] });
    assert.deepEqual(ratchet(gate, ['a', 'b']), { unlisted: [], fixed: [] });
  });
});
