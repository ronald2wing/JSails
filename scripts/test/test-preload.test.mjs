/**
 * Tests for `scripts/test-preload.mjs`: each test-file process leaves its own
 * exit record, even when two processes get the same process id, as Windows
 * gives a finished process's id to the next one.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { run } from '../subprocess.mjs';

const preload = pathToFileURL(join(import.meta.dirname, '..', 'test-preload.mjs')).href;

describe('test-preload', () => {
  it('keeps one record per process when two processes share an id', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-preload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const records = join(dir, 'records');
    mkdirSync(records);
    // Loaded before the preload, so both processes report the same id.
    const samePid = join(dir, 'same-pid.mjs');
    writeFileSync(samePid, "Object.defineProperty(process, 'pid', { value: 4242 });\n");
    const env = {
      ...process.env,
      NODE_TEST_CONTEXT: 'child-v8',
      JSAILS_TEST_RECORD_DIR: records,
      JSAILS_TEST_FILE_PID: '',
    };
    delete env.JSAILS_TEST_FILE_PID;
    for (const name of ['first.mjs', 'second.mjs']) {
      const file = join(dir, name);
      writeFileSync(file, '');
      const outcome = await run(
        process.execPath,
        ['--import', pathToFileURL(samePid).href, '--import', preload, file],
        { env, capture: true },
      );
      assert.equal(outcome.code, 0, outcome.output);
    }
    const files = readdirSync(records)
      .map((name) => JSON.parse(readFileSync(join(records, name), 'utf8')).file)
      .sort();
    assert.deepEqual(files, [join(dir, 'first.mjs'), join(dir, 'second.mjs')]);
  });
});
