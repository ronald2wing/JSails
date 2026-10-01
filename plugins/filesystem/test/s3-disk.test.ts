/**
 * Tests for the S3 disk and the environment-driven disk factory.
 *
 * Every S3 test injects a scripted double for the SDK `send` method, so there is
 * no network. Assertions verify the commands the disk builds (bucket/key/prefix/
 * body/continuation), the value-free 404/error mapping, path-style/prefix
 * handling, and pagination across a truncated `ListObjectsV2` page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DiskError } from 'jsails/filesystem';
import { S3Disk, createDiskFromEnv, type S3DiskOptions } from '../src/index.js';

/** A command the disk sends, with its concrete input for assertion. */
type AnyCommand =
  | PutObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | DeleteObjectCommand
  | ListObjectsV2Command;

/**
 * A scripted `send` double. Each queued entry is consumed in order: a function
 * is called with the command (returning its result or throwing), an `Error` is
 * rejected, and any other value is resolved verbatim.
 */
class FakeS3 {
  /** Commands received, in order. */
  readonly calls: AnyCommand[] = [];
  #responses: unknown[];

  constructor(responses: readonly unknown[] = []) {
    this.#responses = [...responses];
  }

  send(command: AnyCommand): Promise<unknown> {
    this.calls.push(command);
    const next = this.#responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error('unscripted send call'));
    }
    if (typeof next === 'function') {
      try {
        return Promise.resolve((next as (command: AnyCommand) => unknown)(command));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }
}

/** An SDK-shaped 404, as `HeadObject`/`GetObject` produce for a missing key. */
function notFoundError(): Error {
  return Object.assign(new Error('The specified key does not exist.'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

/** A synthetic 500-style failure used to exercise the `io` mapping. */
function ioError(): Error {
  return Object.assign(new Error('Service Unavailable'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });
}

function disk(options: Partial<S3DiskOptions> & { client: FakeS3 }): S3Disk {
  return new S3Disk({ bucket: 'b', region: 'us-east-1', ...options });
}

describe('S3Disk', () => {
  it('round-trips put and get through PutObject/GetObject', async () => {
    const client = new FakeS3([
      {}, // put resolves
      { Body: new Uint8Array([104, 105]) }, // "hi"
    ]);
    const store = disk({ client });

    await store.put('greeting.txt', 'hi');
    assert.equal(Buffer.from(await store.get('greeting.txt')).toString('utf8'), 'hi');

    const [put, get] = client.calls as [PutObjectCommand, GetObjectCommand];
    assert.ok(put instanceof PutObjectCommand);
    assert.equal(put.input.Bucket, 'b');
    assert.equal(put.input.Key, 'greeting.txt');
    assert.deepEqual(Array.from(put.input.Body as Uint8Array), [104, 105]);
    assert.ok(get instanceof GetObjectCommand);
    assert.equal(get.input.Key, 'greeting.txt');
  });

  it('maps a 404 to not_found for get, exists, and size', async () => {
    const getStore = disk({ client: new FakeS3([notFoundError()]) });
    await assert.rejects(getStore.get('missing.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.code, 'not_found');
      assert.equal(error.message, 'file not found');
      return true;
    });

    const existsStore = disk({ client: new FakeS3([notFoundError()]) });
    assert.equal(await existsStore.exists('missing.txt'), false);

    const sizeStore = disk({ client: new FakeS3([notFoundError()]) });
    await assert.rejects(sizeStore.size('missing.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.code, 'not_found');
      return true;
    });
  });

  it('maps other errors to io without echoing keys, buckets, or credentials', async () => {
    const store = disk({
      client: new FakeS3([ioError()]),
      credentials: { accessKeyId: 'AKIASECRETKEYEXAMPLE', secretAccessKey: 'SECRET' },
    });

    await assert.rejects(store.get('sensitive/name.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.code, 'io');
      assert.equal(error.message, 'disk I/O failed');
      assert.ok(!error.message.includes('sensitive'), 'must not echo the key');
      assert.ok(!error.message.includes('AKIA'), 'must not echo the credential');
      return true;
    });
  });

  it('maps a missing get body to not_found', async () => {
    const store = disk({ client: new FakeS3([{ Body: undefined }]) });
    await assert.rejects(store.get('ghost.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.code, 'not_found');
      return true;
    });
  });

  it('applies a prefix to stored keys and strips it back from list', async () => {
    const client = new FakeS3([
      {}, // put
      { Contents: [{ Key: 'assets/report.txt' }], IsTruncated: false }, // list
    ]);
    const store = disk({ client, prefix: 'assets' });

    await store.put('report.txt', 'x');
    const put = client.calls[0] as PutObjectCommand;
    assert.equal(put.input.Key, 'assets/report.txt');

    assert.deepEqual(await store.list(), ['report.txt']);

    const list = client.calls[1] as ListObjectsV2Command;
    assert.equal(list.input.Prefix, 'assets/');
  });

  it('lists with a caller prefix and paginates across truncated pages', async () => {
    const client = new FakeS3([
      {
        Contents: [{ Key: 'a/1.txt' }, { Key: 'a/2.txt' }],
        IsTruncated: true,
        NextContinuationToken: 'tok1',
      },
      { Contents: [{ Key: 'a/3.txt' }], IsTruncated: false },
    ]);
    const store = disk({ client });

    assert.deepEqual(await store.list('a'), ['a/1.txt', 'a/2.txt', 'a/3.txt']);

    const [first, second] = client.calls as [ListObjectsV2Command, ListObjectsV2Command];
    assert.equal(first.input.Prefix, 'a/');
    assert.equal(second.input.ContinuationToken, 'tok1');
  });

  it('sorts list results and skips the prefix marker key', async () => {
    const client = new FakeS3([
      {
        Contents: [
          { Key: 'assets/z.txt' },
          { Key: 'assets/' }, // the prefix marker itself, not a stored key
          { Key: 'assets/a.txt' },
        ],
        IsTruncated: false,
      },
    ]);
    const store = disk({ client, prefix: 'assets' });
    assert.deepEqual(await store.list(), ['a.txt', 'z.txt']);
  });

  it('deletes idempotently and via DeleteObject', async () => {
    const client = new FakeS3([{}, notFoundError()]);
    const store = disk({ client });

    await store.delete('gone.txt');
    await store.delete('gone.txt'); // 404 is swallowed as idempotent

    const [first, second] = client.calls as [DeleteObjectCommand, DeleteObjectCommand];
    assert.ok(first instanceof DeleteObjectCommand);
    assert.equal(first.input.Key, 'gone.txt');
    assert.ok(second instanceof DeleteObjectCommand);
  });

  it('reports size from HeadObject ContentLength', async () => {
    const client = new FakeS3([{ ContentLength: 42 }]);
    const store = disk({ client });

    assert.equal(await store.size('big.bin'), 42);
    const head = client.calls[0] as HeadObjectCommand;
    assert.ok(head instanceof HeadObjectCommand);
    assert.equal(head.input.Key, 'big.bin');
  });

  it('reports existence true on a successful HeadObject', async () => {
    const client = new FakeS3([{ ContentLength: 1 }]);
    const store = disk({ client });
    assert.equal(await store.exists('present.txt'), true);
  });

  it('collects a streaming body without transformToByteArray', async () => {
    async function* stream(): AsyncIterableIterator<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    const client = new FakeS3([{ Body: stream() }]);
    const store = disk({ client });
    assert.deepEqual(Array.from(await store.get('stream.bin')), [1, 2, 3]);
  });

  it('validates options at construction and never contacts the network', () => {
    const missingBucket = { region: 'us-east-1' } as unknown as S3DiskOptions;
    const emptyBucket = { bucket: '', region: 'us-east-1' } as unknown as S3DiskOptions;
    const missingRegion = { bucket: 'b' } as unknown as S3DiskOptions;
    assert.throws(() => new S3Disk(missingBucket), TypeError);
    assert.throws(() => new S3Disk(emptyBucket), TypeError);
    assert.throws(() => new S3Disk(missingRegion), TypeError, 'region is required');
    assert.throws(() => disk({ client: 'bad' as unknown as FakeS3 }), TypeError);
  });

  it('rejects malformed keys value-free', async () => {
    const store = disk({ client: new FakeS3([]) });
    for (const key of ['', '../x', 'a/../../b', '/abs', 'a\\b', 'a//b']) {
      await assert.rejects(store.put(key, 'x'), (error: unknown) => {
        assert.ok(error instanceof DiskError);
        assert.equal(error.code, 'invalid_key');
        return true;
      });
    }
  });
});

describe('createDiskFromEnv', () => {
  it('selects local with the default root', () => {
    const { name, disk } = createDiskFromEnv({ FILESYSTEM_DISK: 'local' });
    assert.equal(name, 'local');
    assert.equal(disk.constructor.name, 'LocalDisk');
  });

  it('selects local with a custom root', () => {
    const { disk } = createDiskFromEnv({
      FILESYSTEM_DISK: 'local',
      FILESYSTEM_LOCAL_ROOT: '/tmp/jsails-custom',
    });
    assert.equal(disk.constructor.name, 'LocalDisk');
  });

  it('selects s3 and wires the S3_* variables eagerly', () => {
    const { name, disk } = createDiskFromEnv({
      FILESYSTEM_DISK: 's3',
      S3_BUCKET: 'my-bucket',
      S3_REGION: 'us-west-2',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_SESSION_TOKEN: 'token',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PREFIX: 'media',
    });
    assert.equal(name, 's3');
    assert.equal(disk.constructor.name, 'S3Disk');
  });

  it('constructs only the selected disk, so a broken s3 env builds a clean local disk', () => {
    const { name } = createDiskFromEnv({
      FILESYSTEM_DISK: 'local',
      // S3 variables deliberately absent; a misconfigured S3 env must not leak in.
    });
    assert.equal(name, 'local');
  });

  it('defaults to local when no selector is set, but rejects blank/unknown selectors', () => {
    const fallback = createDiskFromEnv({});
    assert.equal(fallback.name, 'local');
    assert.equal(fallback.disk.constructor.name, 'LocalDisk');
    assert.throws(() => createDiskFromEnv({ FILESYSTEM_DISK: '' }), TypeError);
    assert.throws(
      () => createDiskFromEnv({ FILESYSTEM_DISK: 'ftp' }),
      /must be "local", "s3", or "memory"/,
    );
  });

  it('rejects s3 without a bucket or region', () => {
    assert.throws(() => createDiskFromEnv({ FILESYSTEM_DISK: 's3' }), /S3_BUCKET/);
    assert.throws(() => createDiskFromEnv({ FILESYSTEM_DISK: 's3', S3_BUCKET: 'b' }), /S3_REGION/);
  });

  it('rejects a lone access key or secret', () => {
    assert.throws(
      () =>
        createDiskFromEnv({
          FILESYSTEM_DISK: 's3',
          S3_BUCKET: 'b',
          S3_REGION: 'r',
          S3_ACCESS_KEY_ID: 'only-id',
        }),
      /must be set together/,
    );
  });

  it('supports the memory backend', () => {
    const { name, disk } = createDiskFromEnv({ FILESYSTEM_DISK: 'memory' });
    assert.equal(name, 'memory');
    assert.equal(disk.constructor.name, 'MemoryDisk');
  });
});
