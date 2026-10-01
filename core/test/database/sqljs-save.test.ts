/**
 * The sqljs atomic save writer: coalescing bursts, and recovery after a failed
 * write instead of latching off.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { atomicSaveCallback } from '../../src/database/data-source.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'sqljs-save-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('atomicSaveCallback', () => {
  it('keeps writing after a failed save once the fault clears', async () => {
    const dir = join(tmpRoot, 'gone');
    const location = join(dir, 'db.sqlite');
    const save = atomicSaveCallback(location);

    // The directory does not exist yet: the write fails.
    await assert.rejects(save(new Uint8Array([1])));

    mkdirSync(dir);
    await save(new Uint8Array([2, 3]));
    assert.deepEqual([...readFileSync(location)], [2, 3]);
  });

  it('coalesces a burst: every caller settles and the newest export lands', async () => {
    const location = join(tmpRoot, 'burst.sqlite');
    const save = atomicSaveCallback(location);
    const saves = Array.from({ length: 20 }, (_, i) => save(new Uint8Array([i])));
    await Promise.all(saves);
    assert.deepEqual([...readFileSync(location)], [19]);
  });
});
