/**
 * Tests for `scripts/run-parallel.mjs`: every job runs to the end even after
 * another fails, each failure is named, and the group's status is the first
 * failure's.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { run } from '../subprocess.mjs';

const script = join(import.meta.dirname, '..', 'run-parallel.mjs');

describe('run-parallel', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsails-run-parallel-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  const finish = (marker, code) =>
    `node -e "setTimeout(() => { require('node:fs').writeFileSync('${marker}', ''); process.exit(${code}); }, 1500)"`;
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      scripts: {
        fast: 'node -e "process.exit(3)"',
        slow: finish('slow.done', 0),
        late: finish('late.done', 1),
        ok: 'node -e ""',
      },
    }),
  );
  const runIn = (scripts) =>
    run(process.execPath, ['--input-type=module', '-e', drive(scripts)], {
      cwd: root,
      capture: true,
    });
  // Drives main() with the fixture as its root, so the run never touches the repo.
  const drive = (scripts) =>
    `import { main } from ${JSON.stringify(pathToFileURL(script).href)};
process.exitCode = await main(${JSON.stringify(scripts)}, { cwd: ${JSON.stringify(root)} });`;

  it('lets every job finish after one fails and names each failure', async () => {
    const outcome = await runIn(['fast', 'slow', 'late']);
    assert.equal(outcome.code, 3, outcome.output);
    assert.ok(existsSync(join(root, 'slow.done')), outcome.output);
    assert.ok(existsSync(join(root, 'late.done')), outcome.output);
    assert.match(outcome.output, /"npm run fast" exited with code 3/);
    assert.match(outcome.output, /"npm run late" exited with code 1/);
    assert.match(outcome.output, /2 of 3 jobs failed: fast, late/);
  });

  it('passes when every job passes', async () => {
    const outcome = await runIn(['ok', 'ok']);
    assert.equal(outcome.code, 0, outcome.output);
  });

  it('refuses an empty job list', async () => {
    const outcome = await runIn([]);
    assert.equal(outcome.code, 2, outcome.output);
  });
});
