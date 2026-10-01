/**
 * `MemoryDisk` beyond the shared contract: stored bytes are the disk's own
 * copies, the quota, the injected clock, and option validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DiskErrors, readBytes } from 'jsails/filesystem';

import { MemoryDisk } from '../src/index.js';

describe('MemoryDisk', () => {
  it('stores copies, so a caller mutating its buffer or a read chunk changes nothing', async () => {
    const disk = new MemoryDisk();
    const input = new Uint8Array([1, 2, 3]);
    await disk.write('k', input, { maxBytes: 3 });
    input[0] = 9;
    const read = await readBytes(disk, 'k', { maxBytes: 3 });
    read[1] = 9;
    assert.deepEqual(await readBytes(disk, 'k', { maxBytes: 3 }), new Uint8Array([1, 2, 3]));
  });

  it('enforces a total byte quota and frees space on delete', async () => {
    const disk = new MemoryDisk({ maxBytes: 4 });
    await disk.write('a', new Uint8Array(3), { maxBytes: 10 });
    await assert.rejects(disk.write('b', new Uint8Array(2), { maxBytes: 10 }), (error: unknown) =>
      DiskErrors.is(error, 'too_large'),
    );
    await disk.write('a', new Uint8Array(4), { maxBytes: 10 }); // an overwrite reuses its space
    await disk.deletePrefix('nothing');
    await disk.delete('a');
    await disk.write('b', new Uint8Array(4), { maxBytes: 10 });
  });

  it('stamps modifiedAt from the injected clock', async () => {
    const disk = new MemoryDisk({ now: () => new Date('2026-01-02T03:04:05Z') });
    await disk.write('k', new Uint8Array(1), { maxBytes: 1 });
    assert.equal((await disk.stat('k'))?.modifiedAt.toISOString(), '2026-01-02T03:04:05.000Z');
  });

  it('refuses malformed options', () => {
    for (const options of [{ maxBytes: -1 }, { now: 'yesterday' }, null]) {
      assert.throws(
        () => new MemoryDisk(options as never),
        (error: unknown) => DiskErrors.is(error, 'invalid_option'),
      );
    }
  });
});
