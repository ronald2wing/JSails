/**
 * Tests for `scripts/run-gates.mjs`: the gate module contract (with an inner
 * pool's `jobs`), how a gate's result becomes an exit status, the start order
 * from the timing record, each gate's lease (a small budget makes gates queue
 * instead of overlapping) and the record a run writes, and that every gate in
 * `scripts/gates/` loads.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { gateDefaultMb, gateFiles, gateOrder, loadGate, runGate } from '../run-gates.mjs';
import { run } from '../subprocess.mjs';

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

  it('takes an inner pool size as jobs, one slot by default', async () => {
    const pooled = `${VALID('pooled', '[]')}export const jobs = { need: 1, want: 4 };\n`;
    assert.deepEqual((await loadGate(gateFile('pooled', pooled))).jobs, { need: 1, want: 4 });
    assert.deepEqual((await loadGate(gateFile('single', VALID('single', '[]')))).jobs, {
      need: 1,
      want: 1,
    });
    const broken = `${VALID('broken', '[]')}export const jobs = { need: 3, want: 2 };\n`;
    await assert.rejects(loadGate(gateFile('broken', broken)), /`jobs` must be/);
  });
});

describe('gateOrder', () => {
  it('starts the longest recorded gates first and the unrecorded last', () => {
    const gates = ['a', 'bench', 'docs', 'new', 'z'].map((name) => ({ name }));
    const timings = { a: { wallMs: 100 }, bench: { wallMs: 16_000 }, docs: { wallMs: 7_000 } };
    assert.deepEqual(
      gateOrder(gates, timings).map((gate) => gate.name),
      ['bench', 'docs', 'a', 'new', 'z'],
    );
  });

  it('leases more for a gate with an inner pool', () => {
    assert.equal(gateDefaultMb({ jobs: { need: 1, want: 1 } }), 500);
    assert.equal(gateDefaultMb({ jobs: { need: 1, want: 8 } }), 1000);
  });
});

describe('gates under the machine budget', () => {
  it('queues gates whose leases do not fit together and records each run', async () => {
    const root = mkdtempSync(join(dir, 'repo-'));
    mkdirSync(join(root, 'scripts', 'gates'), { recursive: true });
    for (const script of [
      'run-gates.mjs',
      'budgeted.mjs',
      'machine-budget.mjs',
      'process-tree.mjs',
      'subprocess.mjs',
      'workspaces.mjs',
    ]) {
      copyFileSync(join(import.meta.dirname, '..', script), join(root, 'scripts', script));
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: [] }),
    );
    const log = join(root, 'gates.log');
    writeFileSync(log, '');
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(
        join(root, 'scripts', 'gates', `${name}.mjs`),
        `import { appendFileSync } from 'node:fs';
export const name = '${name}';
export const description = 'A fixture gate.';
export const needsBuild = false;
export async function run() {
  appendFileSync(${JSON.stringify(log)}, \`+ \${Date.now()} ${name} \${process.env.JSAILS_JOBS}\\n\`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  appendFileSync(${JSON.stringify(log)}, \`- \${Date.now()} ${name}\\n\`);
  return [];
}
`,
      );
    }
    const outcome = await run(process.execPath, [join(root, 'scripts', 'run-gates.mjs')], {
      cwd: root,
      capture: true,
      env: {
        ...process.env,
        JSAILS_BUDGET_DIR: join(root, 'budget'),
        // Each gate asks for 500 MiB: two never fit together.
        JSAILS_MEMORY_BUDGET_MB: '600',
        JSAILS_BUDGET_HOLDER: '',
        JSAILS_JOBS: '',
        JSAILS_BUDGET: '',
      },
    });
    assert.equal(outcome.code, 0, outcome.output);
    let running = 0;
    let widest = 0;
    const events = readFileSync(log, 'utf8').trim().split('\n');
    for (const line of events) {
      running += line.startsWith('+') ? 1 : -1;
      widest = Math.max(widest, running);
      if (line.startsWith('+')) assert.match(line, / 1$/, 'the CPU grant reaches the gate');
    }
    assert.equal(events.length, 6);
    assert.equal(widest, 1, `gates overlapped:\n${events.join('\n')}`);
    const record = JSON.parse(
      readFileSync(join(root, 'test-results', 'timings-gates.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(record.gates).sort(), ['one', 'three', 'two']);
    assert.ok(Object.values(record.gates).every((entry) => entry.wallMs >= 200));
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
