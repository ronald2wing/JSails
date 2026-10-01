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
 * SeaweedFS), so the store itself does not need to pre-create it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { S3Disk } from '../src/index.js';

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
    it('put/get/exists/size/list/delete round-trip against a real store', async () => {
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
      });

      // put + size + exists + get.
      await disk.put('hello.txt', 'hello, live store');
      assert.equal(await disk.exists('hello.txt'), true);
      assert.equal(await disk.size('hello.txt'), 'hello, live store'.length);
      assert.equal(Buffer.from(await disk.get('hello.txt')).toString('utf8'), 'hello, live store');

      // Nested prefix: list under a sub-prefix sees only those keys.
      await disk.put('nested/a.txt', 'a');
      await disk.put('nested/b.txt', 'b');
      const nested = await disk.list('nested');
      assert.deepEqual(nested, ['nested/a.txt', 'nested/b.txt']);

      // Full listing strips the disk prefix and is sorted.
      const all = await disk.list();
      assert.deepEqual(all, ['hello.txt', 'nested/a.txt', 'nested/b.txt']);

      // A missing key reports not-found, not an error.
      assert.equal(await disk.exists('absent.txt'), false);

      // delete, then absence.
      await disk.delete('nested/a.txt');
      assert.equal(await disk.exists('nested/a.txt'), false);
      assert.deepEqual(await disk.list('nested'), ['nested/b.txt']);

      // Cleanup: remove the remaining keys so re-runs start clean.
      await disk.delete('hello.txt');
      await disk.delete('nested/b.txt');
      assert.deepEqual(await disk.list(), []);
    });
  },
);
