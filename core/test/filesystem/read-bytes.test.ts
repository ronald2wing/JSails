/**
 * `readBytes` and `readText` over any disk: bounded by a required `maxBytes`,
 * refusing an oversized object before reading it, and rejecting a stream that
 * delivers more or fewer bytes than the object's declared size.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Disk, DiskObject } from '../../src/filesystem/disk.js';
import { DiskErrors } from '../../src/filesystem/disk-errors.js';
import { readBytes, readText } from '../../src/filesystem/read-bytes.js';

/** A disk whose reads answer with `object()`; every other method is unused. */
function diskReading(object: () => DiskObject): Disk {
  const unused = (): never => assert.fail('not used');
  return {
    write: unused,
    stat: unused,
    delete: unused,
    deletePrefix: unused,
    list: unused,
    read: () => Promise.resolve(object()),
  };
}

function objectOf(bytes: Uint8Array, size = bytes.byteLength): DiskObject {
  return { stream: new Blob([new Uint8Array(bytes)]).stream(), size, start: 0, end: size - 1 };
}

describe('readBytes', () => {
  it('collects the object', async () => {
    const bytes = new TextEncoder().encode('héllo');
    const disk = diskReading(() => objectOf(bytes));
    assert.deepEqual(await readBytes(disk, 'a', { maxBytes: bytes.byteLength }), bytes);
    assert.equal(await readText(disk, 'a', { maxBytes: 100 }), 'héllo');
  });

  it('refuses an object larger than maxBytes before reading it', async () => {
    let pulled = 0;
    let cancelled = false;
    const disk = diskReading(() => ({
      stream: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      size: 1_000,
      start: 0,
      end: 999,
    }));
    await assert.rejects(readBytes(disk, 'a', { maxBytes: 10 }), (error: unknown) =>
      DiskErrors.is(error, 'too_large'),
    );
    assert.equal(pulled, 0);
    assert.equal(cancelled, true);
  });

  it('cuts off a stream that delivers more than its declared size', async () => {
    const disk = diskReading(() => objectOf(new Uint8Array(8), 4));
    await assert.rejects(readBytes(disk, 'a', { maxBytes: 100 }), (error: unknown) =>
      DiskErrors.is(error, 'too_large'),
    );
  });

  it('rejects a stream that ends short of its declared size', async () => {
    const disk = diskReading(() => objectOf(new Uint8Array(2), 4));
    await assert.rejects(readBytes(disk, 'a', { maxBytes: 100 }), (error: unknown) =>
      DiskErrors.is(error, 'io_failed'),
    );
  });

  it('requires maxBytes', async () => {
    const disk = diskReading(() => objectOf(new Uint8Array(1)));
    await assert.rejects(readBytes(disk, 'a', {} as { maxBytes: number }), (error: unknown) =>
      DiskErrors.is(error, 'invalid_option'),
    );
  });
});
