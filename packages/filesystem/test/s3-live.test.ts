/**
 * Live `S3Disk` integration test against a real S3-compatible object store.
 *
 * Opt-in, env-gated: it runs only when `JSAILS_TEST_S3` is `"1"` and the store
 * coordinates are set. When the gate is unset, the suite is reported skipped
 * (`node:test` `skip`) and no network is touched — the default unit suite
 * (which fakes the SDK) is unaffected. The store under test is the SeaweedFS
 * backing service Jamal provisions (`jamal up` with `s3: { type: 's3' }`);
 * the fixed credentials match the S3 gateway's `S3_ACCESS_KEY_ID`/
 * `S3_SECRET_ACCESS_KEY` identity.
 *
 * Env contract (the same names `createDiskFromEnv` reads):
 *   S3_ENDPOINT           http://127.0.0.1:8333
 *   S3_BUCKET             the bucket to create and exercise
 *   S3_REGION             e.g. us-east-1
 *   S3_ACCESS_KEY_ID      the access key matching the gateway identity
 *   S3_SECRET_ACCESS_KEY  the matching secret key
 *   S3_FORCE_PATH_STYLE   any truthy value; must be `true` for SeaweedFS
 *
 * The bucket is created here via the SDK `CreateBucket` API (idempotent against
 * SeaweedFS), so the store itself does not need to pre-create it. Writes use
 * S3's 5 MiB minimum part size, and a 512 MiB streamed write checks that the
 * disk holds one part at a time over real HTTP.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { readText } from 'jsails/filesystem';

import { S3Disk } from '../src/index.js';

const MIB = 1024 * 1024;
const MIN_PART_BYTES = 5 * MIB;

/** Trimmed value of `name` in `env`, or `undefined` when absent/blank. */
function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function gated(): boolean {
  return read('JSAILS_TEST_S3') === '1';
}

/** The S3 coordinates, or `null` when the test is not enabled. */
function options(): {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  if (!gated()) {
    return null;
  }
  const endpoint = read('S3_ENDPOINT');
  const bucket = read('S3_BUCKET');
  const accessKeyId = read('S3_ACCESS_KEY_ID');
  const secretAccessKey = read('S3_SECRET_ACCESS_KEY');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    // Enabled but incomplete: skip rather than fail with incomplete config.
    return null;
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

const coordinates = options();

describe(
  'S3Disk (live)',
  { skip: coordinates === null ? 'JSAILS_TEST_S3 is not "1" or S3_* vars are unset' : false },
  () => {
    it('write/read/stat/list/delete, multipart writes and a signed URL against a real store', async () => {
      const coords = coordinates!;
      const client = new S3Client({
        region: 'us-east-1',
        endpoint: coords.endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: coords.accessKeyId,
          secretAccessKey: coords.secretAccessKey,
        },
      });

      // Create the bucket, tolerating a pre-existing one (a prior run may have
      // left it; SeaweedFS reports a bucket that maps to an existing
      // collection as a non-idempotent error rather than a no-op success).
      try {
        await client.send(new CreateBucketCommand({ Bucket: coords.bucket }));
      } catch (error) {
        const code = (error as { name?: string })?.name;
        if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
          throw error;
        }
      }

      const disk = new S3Disk({
        bucket: coords.bucket,
        region: 'us-east-1',
        endpoint: coords.endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: coords.accessKeyId,
          secretAccessKey: coords.secretAccessKey,
        },
        prefix: 'live',
        partSize: MIN_PART_BYTES,
      });

      const text = (value: string) => new TextEncoder().encode(value);
      const write = (key: string, value: string) =>
        disk.write(key, text(value), { maxBytes: 1024 });

      // write + stat + read.
      const written = await write('hello.txt', 'hello, live store');
      assert.equal(written.size, 'hello, live store'.length);
      assert.equal((await disk.stat('hello.txt'))?.size, 'hello, live store'.length);
      assert.equal(await readText(disk, 'hello.txt', { maxBytes: 1024 }), 'hello, live store');
      const ranged = await disk.read('hello.txt', { range: { start: 7, end: 10 } });
      assert.equal(await new Response(ranged.stream).text(), 'live');

      // Nested prefix: a listing under a sub-prefix sees only those keys.
      await write('nested/a.txt', 'a');
      await write('nested/b.txt', 'b');
      assert.deepEqual((await disk.list('nested', { limit: 100 })).keys, [
        'nested/a.txt',
        'nested/b.txt',
      ]);
      assert.deepEqual((await disk.list('', { limit: 100 })).keys, [
        'hello.txt',
        'nested/a.txt',
        'nested/b.txt',
      ]);

      // A missing key is null, not an error.
      assert.equal(await disk.stat('absent.txt'), null);

      // A multipart write (two 5 MiB parts and a remainder) round-trips.
      const large = new Uint8Array(11 * 1024 * 1024).fill(42);
      const result = await disk.write('large.bin', large, { maxBytes: large.byteLength });
      assert.equal((await disk.stat('large.bin'))?.size, large.byteLength);
      assert.equal(result.sha256, createHash('sha256').update(large).digest('hex'));

      // A signed URL reads the object directly, with the signed disposition.
      const signed = await fetch(
        await disk.signedUrl('hello.txt', {
          expiresInMs: 60_000,
          contentDisposition: { type: 'attachment', filename: 'h.txt' },
          contentType: 'text/plain',
        }),
      );
      assert.equal(signed.status, 200);
      assert.equal(await signed.text(), 'hello, live store');
      assert.equal(signed.headers.get('content-disposition'), 'attachment; filename="h.txt"');

      // 512 MiB streamed through real HTTP holds one part at a time: memory
      // retained after a full collection stays within a part and a fixed margin.
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const retained = (): number => {
        gc();
        const { heapUsed, arrayBuffers } = process.memoryUsage();
        return heapUsed + arrayBuffers;
      };
      const baseline = retained();
      let peak = baseline;
      async function* huge(): AsyncGenerator<Uint8Array> {
        for (let index = 0; index < 512; index += 1) {
          if (index % 16 === 0) peak = Math.max(peak, retained());
          yield new Uint8Array(MIB).fill(index);
        }
      }
      const streamed = await disk.write('huge.bin', huge(), { maxBytes: 512 * MIB });
      assert.equal(streamed.size, 512 * MIB);
      assert.equal((await disk.stat('huge.bin'))?.size, 512 * MIB);
      assert.ok(
        peak - baseline < MIN_PART_BYTES + 32 * MIB,
        `peak grew by ${peak - baseline} bytes`,
      );

      // Cleanup: remove everything so re-runs start clean.
      await disk.delete('hello.txt');
      await disk.delete('large.bin');
      await disk.delete('huge.bin');
      await disk.deletePrefix('nested');
      assert.deepEqual((await disk.list('', { limit: 100 })).keys, []);
    });
  },
);
