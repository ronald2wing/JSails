/**
 * Tests for the in-memory S3 fake: it serves the disk's own reads and writes,
 * and it enforces the conditional-put and multipart rules later streaming and
 * create-only writes are built against.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { DiskError } from 'jsails/filesystem';

import { S3Disk } from '../src/index.js';
import { createFakeS3, MIN_PART_BYTES } from './fake-s3.js';

function errorNamed(name: string, status: number): (error: unknown) => boolean {
  return (error) => {
    const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    return candidate.name === name && candidate.$metadata?.httpStatusCode === status;
  };
}

describe('createFakeS3', () => {
  it('serves S3Disk reads, ranged streams, listing, and deletes', async () => {
    const fake = createFakeS3({ bucket: 'media' });
    const disk = new S3Disk({ bucket: 'media', prefix: 'site', client: fake.client });

    await disk.put('a/one.txt', 'hello world', { contentType: 'text/plain' });
    await disk.put('a/two.txt', 'second');
    await disk.put('b/three.txt', 'third');

    assert.equal(Buffer.from(await disk.get('a/one.txt')).toString(), 'hello world');
    assert.equal(await disk.size('a/one.txt'), 11);
    assert.equal(await disk.exists('a/missing.txt'), false);
    await assert.rejects(
      disk.get('a/missing.txt'),
      (error: unknown) => error instanceof DiskError && error.code === 'not_found',
    );

    const ranged = await disk.stream('a/one.txt', { range: { start: 6, end: 10 } });
    assert.equal(await new Response(ranged.stream).text(), 'world');
    assert.deepEqual([ranged.start, ranged.end, ranged.size], [6, 10, 11]);

    assert.deepEqual(await disk.list('a'), ['a/one.txt', 'a/two.txt']);
    const first = await disk.listPage('', { limit: 2 });
    assert.deepEqual(first.keys, ['a/one.txt', 'a/two.txt']);
    assert.ok(first.cursor !== undefined);
    assert.deepEqual(await disk.listPage('', { cursor: first.cursor }), {
      keys: ['b/three.txt'],
      cursor: undefined,
    });

    await disk.delete('a/two.txt');
    await disk.delete('a/two.txt');
    assert.deepEqual([...fake.objects.keys()].sort(), ['site/a/one.txt', 'site/b/three.txt']);
    assert.equal(fake.objects.get('site/a/one.txt')?.contentType, 'text/plain');
    assert.equal(fake.commands[0]?.name, 'PutObjectCommand');
    assert.equal(fake.commands[0]?.input.Key, 'site/a/one.txt');
  });

  it('refuses a create-only put over an existing key and honours If-Match', async () => {
    const fake = createFakeS3();
    const put = (body: string, condition: Record<string, string>) =>
      fake.client.send(
        new PutObjectCommand({ Bucket: fake.bucket, Key: 'claim', Body: body, ...condition }),
      );

    const created = (await put('first', { IfNoneMatch: '*' })) as { ETag: string };
    await assert.rejects(
      put('second', { IfNoneMatch: '*' }),
      errorNamed('PreconditionFailed', 412),
    );
    assert.equal(Buffer.from(fake.objects.get('claim')?.bytes ?? []).toString(), 'first');

    await assert.rejects(put('stale', { IfMatch: '"0"' }), errorNamed('PreconditionFailed', 412));
    await put('replaced', { IfMatch: created.ETag });
    assert.equal(Buffer.from(fake.objects.get('claim')?.bytes ?? []).toString(), 'replaced');
  });

  it('assembles a multipart upload and enforces part order, ETags, and size', async () => {
    const fake = createFakeS3();
    const Bucket = fake.bucket;
    const start = async (Key: string) =>
      (
        (await fake.client.send(new CreateMultipartUploadCommand({ Bucket, Key }))) as {
          UploadId: string;
        }
      ).UploadId;
    const part = async (Key: string, UploadId: string, PartNumber: number, Body: Uint8Array) =>
      (
        (await fake.client.send(
          new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body }),
        )) as { ETag: string }
      ).ETag;

    const uploadId = await start('big.bin');
    const one = await part('big.bin', uploadId, 1, new Uint8Array(MIN_PART_BYTES).fill(1));
    const two = await part('big.bin', uploadId, 2, new Uint8Array([2, 2]));
    assert.equal(fake.openUploads, 1);
    assert.equal(fake.objects.has('big.bin'), false, 'parts are invisible until completion');

    await assert.rejects(
      fake.client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: 'big.bin',
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 2, ETag: two },
              { PartNumber: 1, ETag: one },
            ],
          },
        }),
      ),
      errorNamed('InvalidPartOrder', 400),
    );
    await fake.client.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: 'big.bin',
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: one },
            { PartNumber: 2, ETag: two },
          ],
        },
      }),
    );
    assert.equal(fake.objects.get('big.bin')?.bytes.byteLength, MIN_PART_BYTES + 2);
    assert.match(fake.objects.get('big.bin')?.etag ?? '', /-2"$/);
    assert.equal(fake.openUploads, 0);

    const small = await start('small.bin');
    const tiny = await part('small.bin', small, 1, new Uint8Array(10));
    const tail = await part('small.bin', small, 2, new Uint8Array(10));
    await assert.rejects(
      fake.client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: 'small.bin',
          UploadId: small,
          MultipartUpload: {
            Parts: [
              { PartNumber: 1, ETag: tiny },
              { PartNumber: 2, ETag: tail },
            ],
          },
        }),
      ),
      errorNamed('EntityTooSmall', 400),
    );
    await fake.client.send(
      new AbortMultipartUploadCommand({ Bucket, Key: 'small.bin', UploadId: small }),
    );
    assert.equal(fake.openUploads, 0);
    await assert.rejects(
      part('small.bin', small, 3, new Uint8Array(1)),
      errorNamed('NoSuchUpload', 404),
    );

    const guarded = await start('big.bin');
    const only = await part('big.bin', guarded, 1, new Uint8Array(3));
    await assert.rejects(
      fake.client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: 'big.bin',
          UploadId: guarded,
          IfNoneMatch: '*',
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: only }] },
        }),
      ),
      errorNamed('PreconditionFailed', 412),
    );
  });

  it('reports a missing bucket the way the SDK does, and rejects unknown commands', async () => {
    const fake = createFakeS3({ bucket: 'real' });
    const disk = new S3Disk({ bucket: 'typo', client: fake.client });
    await assert.rejects(
      fake.client.send(new PutObjectCommand({ Bucket: 'typo', Key: 'k' })),
      errorNamed('NoSuchBucket', 404),
    );
    // HEAD has no error body: the SDK sees a bare 404, indistinguishable from a missing key.
    assert.equal(await disk.exists('k'), false);
    await assert.rejects(
      fake.client.send(
        new (class ListBucketsCommand {
          readonly input = { Bucket: 'real' };
        })(),
      ),
      /does not implement ListBucketsCommand/,
    );
  });

  it('lets a test inject a failure before a command is applied', async () => {
    const fake = createFakeS3({
      beforeCommand: (command) => {
        if (command.name === 'PutObjectCommand') {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
      },
    });
    const disk = new S3Disk({ bucket: fake.bucket, client: fake.client });
    await assert.rejects(disk.put('k', 'v'), DiskError);
    assert.equal(fake.objects.size, 0);
    assert.deepEqual(fake.commandNames(), ['PutObjectCommand']);
  });
});
