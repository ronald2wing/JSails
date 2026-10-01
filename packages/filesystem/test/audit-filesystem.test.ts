/**
 * Audit regressions for disks and derived variants (CNT-01): each test states
 * the correct behaviour for one audited defect. Those that fail today are
 * listed, with the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { auditCase, tempDir } from 'jsails/testing';
import { readText } from 'jsails/filesystem';

import { LocalDisk, MemoryDisk, S3Disk } from '../src/index.js';
import { DiskVariantResolver, defineVariant } from '../src/variants.js';
import { createFakeS3, MIN_PART_BYTES } from './fake-s3.js';

const MIB = 1024 * 1024;

function upper(input: Uint8Array): Uint8Array {
  return Buffer.from(Buffer.from(input).toString('utf8').toUpperCase(), 'utf8');
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test(
  ...auditCase(
    'filesystem/s3-put-stream-buffers',
    'S3Disk.write starts uploading before the source stream ends',
  ),
  async () => {
    // The object is never read back, so the fake keeps only sizes and digests.
    const fake = createFakeS3({ bucket: 'uploads', discardBodies: true });
    const commands = fake.commands;
    const disk = new S3Disk({ bucket: 'uploads', client: fake.client, partSize: MIN_PART_BYTES });
    let sentBeforeEnd = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(6 * MIB);
      yield new Uint8Array(6 * MIB);
      // Two parts' worth is buffered; a streaming upload has sent one by now.
      for (let waited = 0; waited < 500 && commands.length === 0; waited += 10) {
        await sleep(10);
      }
      sentBeforeEnd = commands.length > 0;
      yield new Uint8Array(1024);
    }
    await disk.write('large.bin', source(), { maxBytes: 16 * MIB });
    assert.ok(sentBeforeEnd, 'nothing was sent until the whole stream was held in memory');
  },
);

test(
  ...auditCase(
    'filesystem/s3-missing-bucket',
    'a missing bucket is an error, not a missing object',
  ),
  async () => {
    // The fake answers HEAD on a missing bucket with a bodiless 404, as S3
    // does, so the disk must find out some other way than the error's name.
    const fake = createFakeS3({ bucket: 'uploads' });
    const disk = new S3Disk({ bucket: 'misconfigured', client: fake.client });
    await assert.rejects(
      disk.stat('avatar.png'),
      'stat() answered null for a bucket that does not exist',
    );
  },
);

test(
  ...auditCase('filesystem/local-exists-directory', 'LocalDisk.stat is null for a directory'),
  async (t) => {
    const disk = new LocalDisk({ root: tempDir(t, 'jsails-audit-disk-') });
    await disk.write('photos/cat.jpg', new Uint8Array([1, 2, 3]), { maxBytes: 3 });
    assert.equal(await disk.stat('photos'), null, 'a directory was reported as a stored file');
  },
);

test(
  ...auditCase(
    'filesystem/variant-follows-source',
    'a variant is derived again when its source bytes change',
  ),
  async () => {
    const disk = new MemoryDisk();
    const resolver = new DiskVariantResolver({
      disk,
      variants: { loud: defineVariant({ name: 'loud', transform: upper, params: {} }) },
    });
    await disk.write('notes/a.txt', text('first'), { maxBytes: 100 });
    await resolver.resolve('notes/a.txt', 'loud');
    await disk.write('notes/a.txt', text('second'), { maxBytes: 100 });
    const key = await resolver.resolve('notes/a.txt', 'loud');
    assert.equal(
      await readText(disk, key, { maxBytes: 100 }),
      'SECOND',
      'the variant of the overwritten source is still served',
    );
  },
);

test(
  ...auditCase(
    'filesystem/variant-known-per-process',
    'a variant purged by one instance is not reported as present by another',
  ),
  async () => {
    const disk = new MemoryDisk();
    const variants = { loud: defineVariant({ name: 'loud', transform: upper, params: {} }) };
    const instanceA = new DiskVariantResolver({ disk, variants });
    const instanceB = new DiskVariantResolver({ disk, variants });
    await disk.write('notes/a.txt', text('text'), { maxBytes: 100 });
    await instanceA.resolve('notes/a.txt', 'loud');
    await instanceB.resolve('notes/a.txt', 'loud');
    await instanceA.purge('notes/a.txt');
    const key = await instanceB.resolve('notes/a.txt', 'loud');
    assert.notEqual(await disk.stat(key), null, 'instance B returned a key that no longer exists');
  },
);
