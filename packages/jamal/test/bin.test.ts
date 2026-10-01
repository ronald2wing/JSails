/**
 * Tests for the `jamal` executable: it runs a verb over the process arguments
 * and exits with that verb's code.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'jamal-bin-'));
after(() => rmSync(cwd, { recursive: true, force: true }));

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

describe('jamal bin', () => {
  it('prints the usage and exits 0 for --help', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jamal <verb> \[options\]/);
  });

  it('exits 2 with the jamal help hint for an unknown verb', () => {
    const result = run(['bogus']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^jamal: unknown subcommand "bogus"/);
    assert.match(result.stderr, /Run "jamal --help" for usage\./);
  });

  it('exits 1 without a stack trace when the project has no config', () => {
    const result = run(['up']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /jamal config not found/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});
