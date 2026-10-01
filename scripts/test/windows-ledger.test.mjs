/**
 * The scope rule of the Windows ledger (`scripts/expected-failures/windows.json`):
 * Windows is supported for development, so no expected failure may sit in the
 * app kernel tests (core/test/app), the CLI tests (core/test/cli, which hold
 * create, dev, build and test), or a starter. Every entry names a later package
 * that empties it; KRN-02, which put the leg in place, is never one. A test of a
 * POSIX-only fact states its platform with a win32 skip instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readLedgers } from '../expected-failures.mjs';

/** Test paths that may never be expected to fail on Windows. */
const FORBIDDEN = [
  { pattern: /^core\/test\/app\//, why: 'the app kernel runs on Windows' },
  { pattern: /^core\/test\/cli\//, why: 'create, dev, build and test run on Windows' },
  { pattern: /starter/i, why: 'every starter installs, builds and tests on Windows' },
];

/** The scope violations of `entries`, one line each; empty when the ledger is in scope. */
function windowsLedgerViolations(entries) {
  const violations = [];
  for (const entry of entries) {
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(entry.file)) violations.push(`${entry.file}: ${why}`);
    }
    if (entry.fixedBy === 'KRN-02') {
      violations.push(`${entry.file}: KRN-02 empties nothing later; name the package that does`);
    }
  }
  return violations;
}

const entry = (file, fixedBy = 'JOB-09') => ({ file, fixedBy, platforms: ['win32'] });

describe('windows ledger scope', () => {
  it('rejects app, CLI and starter entries', () => {
    for (const file of [
      'core/test/app/starter.test.ts',
      'core/test/app/assemble.test.ts',
      'core/test/cli/create-cli.test.ts',
      'core/test/cli/commands/create.test.ts',
      'core/test/cli/commands/credentials.test.ts',
      'core/test/support/starter-files.test.ts',
    ]) {
      assert.notDeepEqual(windowsLedgerViolations([entry(file)]), [], file);
    }
  });

  it('rejects an entry that KRN-02 is said to fix', () => {
    assert.deepEqual(windowsLedgerViolations([entry('core/test/mcp/mcp.test.ts', 'KRN-02')]), [
      'core/test/mcp/mcp.test.ts: KRN-02 empties nothing later; name the package that does',
    ]);
  });

  it('accepts an entry elsewhere owned by a later package', () => {
    assert.deepEqual(
      windowsLedgerViolations([
        entry('packages/jamal/test/production/plan.test.ts'),
        entry('packages/filesystem/test/filesystem.test.ts', 'CNT-17'),
      ]),
      [],
    );
  });

  it('holds for the repository ledger', () => {
    const windows = readLedgers().find((ledger) => ledger.name === 'windows');
    assert.ok(windows !== undefined, 'scripts/expected-failures/windows.json exists');
    assert.deepEqual(windowsLedgerViolations(windows.entries), []);
  });
});
