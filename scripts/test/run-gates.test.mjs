/**
 * Tests for `scripts/run-gates.mjs`: the gate module contract, how a gate's
 * result becomes an exit status, and that every gate in `scripts/gates/` loads.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { gateFiles, loadGate, runGate } from '../run-gates.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jsails-gates-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function gateFile(name, body) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

const VALID = (name, result) => `export const name = '${name}';
export const description = 'A fixture gate.';
export const needsBuild = false;
export function run() { return ${result}; }
`;

describe('loadGate', () => {
  it('loads a gate that meets the contract', async () => {
    const gate = await loadGate(gateFile('fine', VALID('fine', '[]')));
    assert.equal(gate.name, 'fine');
    assert.equal(gate.needsBuild, false);
  });

  it('rejects a name that differs from the file and missing fields', async () => {
    await assert.rejects(
      loadGate(gateFile('other', VALID('wrong', '[]'))),
      /`name` must be "other"/,
    );
    await assert.rejects(
      loadGate(gateFile('bare', "export const name = 'bare';")),
      /`description` is required.*`needsBuild` must be a boolean.*`run` must be a function/,
    );
  });
});

describe('runGate', () => {
  it('passes on an empty failure list and fails on messages', async () => {
    assert.equal(await runGate(await loadGate(gateFile('pass', VALID('pass', '[]')))), 0);
    assert.equal(await runGate(await loadGate(gateFile('fail', VALID('fail', "['broken']")))), 1);
  });

  it('fails a gate that does not return a list', async () => {
    assert.equal(await runGate(await loadGate(gateFile('odd', VALID('odd', 'true')))), 1);
  });

  it('fails a build gate when the build is missing', async () => {
    const gate = { ...(await loadGate(gateFile('built', VALID('built', '[]')))), needsBuild: true };
    assert.equal(await runGate(gate, { built: () => false }), 1);
    assert.equal(await runGate(gate, { built: () => true }), 0);
  });
});

describe('scripts/gates', () => {
  it('every registered gate meets the contract', async () => {
    const files = gateFiles();
    assert.ok(files.length > 0);
    for (const file of files) await loadGate(file);
  });
});
