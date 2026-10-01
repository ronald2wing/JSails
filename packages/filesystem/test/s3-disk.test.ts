/**
 * `S3Disk` beyond the shared contract, over the fake bucket: the commands a
 * write sends (one `PutObject`, or parts sent while the source is still
 * flowing), `If-None-Match` on put and completion, a store without
 * conditional writes, one `GetObject` per ranged read, a missing bucket that
 * never reads as empty, the prefix, folder markers, bounded memory for a
 * 64 MiB write, option validation, and signed URLs (signed locally by a real
 * `S3Client` with fake credentials, which never opens a connection).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { S3Client } from '@aws-sdk/client-s3';
import { DiskErrors, readText, SIGNED_URL_MAX_EXPIRES_IN_MS } from 'jsails/filesystem';

import { S3Disk, type S3DiskOptions } from '../src/index.js';
import { createFakeS3, MIN_PART_BYTES, serviceErrorFor, type FakeS3Options } from './fake-s3.js';

const MIB = 1024 * 1024;

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(DiskErrors.is(error), `expected disk.${code}, got ${String(error)}`);
    assert.equal(error.code, `disk.${code}`);
    return true;
  };
}

function fakeDisk(options: FakeS3Options = {}, disk: Partial<S3DiskOptions> = {}) {
  const fake = createFakeS3(options);
  return { fake, disk: new S3Disk({ bucket: fake.bucket, client: fake.client, ...disk }) };
}

async function* repeat(chunk: Uint8Array, times: number): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < times; index += 1) yield chunk;
}

describe('S3Disk writes', () => {
  it('sends a write that fits one part as a single PutObject with its content type', async () => {
    const { fake, disk } = fakeDisk({}, { prefix: 'assets/' });
    await disk.write('a.txt', new TextEncoder().encode('hello'), {
      maxBytes: 100,
      contentType: 'text/plain',
    });
    assert.deepEqual(fake.commandNames(), ['PutObjectCommand']);
    assert.equal(fake.commands[0]?.input.Key, 'assets/a.txt');
    assert.equal(fake.commands[0]?.input.ContentType, 'text/plain');
    assert.equal(fake.objects.get('assets/a.txt')?.contentType, 'text/plain');
  });

  it('sends each part before reading more of the source', async () => {
    const { fake, disk } = fakeDisk({ bucket: 'uploads' }, { partSize: MIN_PART_BYTES });
    let sentBeforeEnd = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(6 * MIB);
      for (
        let waited = 0;
        waited < 500 && !fake.commandNames().includes('UploadPartCommand');
        waited += 10
      ) {
        await sleep(10);
      }
      sentBeforeEnd = fake.commandNames().includes('UploadPartCommand');
      yield new Uint8Array(1024);
    }
    const result = await disk.write('large.bin', source(), { maxBytes: 10 * MIB });
    assert.ok(sentBeforeEnd);
    assert.equal(result.size, 6 * MIB + 1024);
    assert.deepEqual(fake.commandNames(), [
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
  });

  it('sends If-None-Match on the put and on the completion for ifAbsent', async () => {
    const { fake, disk } = fakeDisk({}, { partSize: MIN_PART_BYTES });
    await disk.write('small', new Uint8Array(1), { maxBytes: 1, ifAbsent: true });
    await disk.write('large', repeat(new Uint8Array(MIB), 6), {
      maxBytes: 6 * MIB,
      ifAbsent: true,
    });
    const conditional = fake.commands.filter((command) => command.input.IfNoneMatch === '*');
    assert.deepEqual(
      conditional.map((command) => command.name),
      ['PutObjectCommand', 'CompleteMultipartUploadCommand'],
    );
  });

  it('answers unsupported when the store does not implement conditional writes', async () => {
    const { disk } = fakeDisk({
      beforeCommand(command) {
        if (command.input.IfNoneMatch !== undefined) throw serviceErrorFor('NotImplemented', 501);
      },
    });
    await assert.rejects(
      disk.write('k', new Uint8Array(1), { maxBytes: 1, ifAbsent: true }),
      isCode('unsupported'),
    );
  });

  it('refuses ifAbsent up front on a store declared without conditional writes', async () => {
    const { fake, disk } = fakeDisk({}, { conditionalWrites: false });
    await assert.rejects(
      disk.write('k', new Uint8Array(1), { maxBytes: 1, ifAbsent: true }),
      isCode('unsupported'),
    );
    assert.deepEqual(fake.commandNames(), []);
    await disk.write('k', new Uint8Array(1), { maxBytes: 1 });
  });

  it('aborts the multipart upload when the write is aborted', async () => {
    const { fake, disk } = fakeDisk({}, { partSize: MIN_PART_BYTES });
    const controller = new AbortController();
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(6 * MIB);
      controller.abort();
      yield new Uint8Array(1);
    }
    await assert.rejects(
      disk.write('k', source(), { maxBytes: 10 * MIB, signal: controller.signal }),
      isCode('aborted'),
    );
    assert.ok(fake.commandNames().includes('AbortMultipartUploadCommand'));
    assert.equal(fake.openUploads, 0);
    assert.equal(fake.objects.size, 0);
  });

  it('writes 64 MiB holding one part at a time', async () => {
    const { fake, disk } = fakeDisk({ discardBodies: true }, { partSize: MIN_PART_BYTES });
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    // Retained memory after a full collection: a fresh chunk per step means a
    // disk that kept chunks or parts alive would grow by each one.
    const retained = (): number => {
      gc();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      return heapUsed + arrayBuffers;
    };
    const baseline = retained();
    let peak = baseline;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 64; index += 1) {
        peak = Math.max(peak, retained());
        yield new Uint8Array(MIB).fill(index);
      }
    }
    const result = await disk.write('big.bin', source(), { maxBytes: 64 * MIB });
    assert.equal(result.size, 64 * MIB);
    assert.equal(fake.objects.get('big.bin')?.size, 64 * MIB);
    assert.ok(peak - baseline < MIN_PART_BYTES + 16 * MIB, `peak grew by ${peak - baseline} bytes`);
  });
});

describe('S3Disk reads and metadata', () => {
  it('serves a range with one ranged GetObject and no HEAD', async () => {
    const { fake, disk } = fakeDisk();
    await disk.write('a.txt', new TextEncoder().encode('hello world'), { maxBytes: 100 });
    fake.commands.length = 0;
    const object = await disk.read('a.txt', { range: { start: 6, end: 99 } });
    assert.equal(await new Response(object.stream).text(), 'world');
    assert.deepEqual([object.size, object.start, object.end], [11, 6, 10]);
    assert.deepEqual(fake.commandNames(), ['GetObjectCommand']);
    assert.equal(fake.commands[0]?.input.Range, 'bytes=6-99');
  });

  it('slices the body itself when a store ignores the Range header', async () => {
    const body = new TextEncoder().encode('hello world');
    const disk = new S3Disk({
      bucket: 'b',
      client: {
        send: () =>
          Promise.resolve({
            Body: body,
            ContentLength: body.byteLength,
            ContentType: 'text/plain',
          }),
      },
    });
    const object = await disk.read('a.txt', { range: { start: 6, end: 7 } });
    assert.equal(await new Response(object.stream).text(), 'wo');
    assert.deepEqual([object.size, object.start, object.end], [11, 6, 7]);
  });

  it('checks the Content-Range a store answers with against the request', async () => {
    const answering = (contentRange: string) =>
      new S3Disk({
        bucket: 'b',
        client: {
          send: () =>
            Promise.resolve({
              Body: new Uint8Array(0),
              ContentLength: 0,
              ContentRange: contentRange,
            }),
        },
      });
    // A store that answers a range past the end with a 206 (SeaweedFS).
    await assert.rejects(
      answering('bytes 10-9/10').read('a', { range: { start: 10 } }),
      isCode('invalid_range'),
    );
    await assert.rejects(
      answering('bytes 0-9/10').read('a', { range: { start: 2, end: 5 } }),
      isCode('io_failed'),
    );
    const object = await answering('bytes 2-9/10').read('a', { range: { start: 2, end: 99 } });
    assert.deepEqual([object.size, object.start, object.end], [10, 2, 9]);
  });

  it('refuses a cursor it did not issue before asking the store', async () => {
    const { fake, disk } = fakeDisk();
    for (const key of ['a', 'b', 'c']) await disk.write(key, new Uint8Array(1), { maxBytes: 1 });
    const first = await disk.list('', { limit: 2 });
    assert.deepEqual((await disk.list('', { limit: 2, cursor: first.cursor })).keys, ['c']);
    fake.commands.length = 0;
    await assert.rejects(
      disk.list('', { limit: 2, cursor: '%%not a cursor%%' }),
      isCode('invalid_cursor'),
    );
    assert.deepEqual(fake.commandNames(), []);
  });

  it('never reports a missing bucket as a missing object', async () => {
    const fake = createFakeS3({ bucket: 'uploads' });
    const disk = new S3Disk({ bucket: 'misconfigured', client: fake.client });
    await assert.rejects(disk.stat('avatar.png'), isCode('io_failed'));
    await assert.rejects(disk.read('avatar.png'), isCode('io_failed'));
    await assert.rejects(disk.list('', { limit: 10 }), isCode('io_failed'));
    await assert.rejects(disk.delete('avatar.png'), isCode('io_failed'));
  });

  it('confirms a HEAD miss with HeadBucket before answering null', async () => {
    const { fake, disk } = fakeDisk();
    assert.equal(await disk.stat('missing'), null);
    assert.deepEqual(fake.commandNames(), ['HeadObjectCommand', 'HeadBucketCommand']);
  });

  it('strips the prefix from listed keys and skips folder markers and unreadable keys', async () => {
    const { fake, disk } = fakeDisk({}, { prefix: 'assets' });
    await disk.write('photos/cat.png', new Uint8Array(1), { maxBytes: 1 });
    fake.objects.set('assets/photos/', fake.objects.get('assets/photos/cat.png')!);
    fake.objects.set('assets/photos//double', fake.objects.get('assets/photos/cat.png')!);
    fake.objects.set('elsewhere/x', fake.objects.get('assets/photos/cat.png')!);
    assert.deepEqual((await disk.list('', { limit: 100 })).keys, ['photos/cat.png']);
    assert.deepEqual((await disk.list('photos', { limit: 100 })).keys, ['photos/cat.png']);
  });

  it('reads through the built client options without contacting the network', () => {
    const disk = new S3Disk({ bucket: 'b', region: 'us-east-1', connectionTimeoutMs: 100 });
    assert.ok(disk instanceof S3Disk);
  });

  it('refuses malformed options with disk.invalid_option', () => {
    const bad: Partial<S3DiskOptions>[] = [
      { bucket: '' },
      { bucket: 'b' },
      { bucket: 'b', region: 'r', prefix: '../x' },
      { bucket: 'b', region: 'r', partSize: MIN_PART_BYTES - 1 },
      { bucket: 'b', region: 'r', requestTimeoutMs: 0 },
      { bucket: 'b', client: {} as never },
      { bucket: 'b', region: 'r', conditionalWrites: 'no' as never },
    ];
    for (const options of bad) {
      assert.throws(() => new S3Disk(options as S3DiskOptions), isCode('invalid_option'));
    }
  });

  it('round-trips text through readText', async () => {
    const { disk } = fakeDisk();
    await disk.write('t.txt', new TextEncoder().encode('héllo'), { maxBytes: 10 });
    assert.equal(await readText(disk, 't.txt', { maxBytes: 10 }), 'héllo');
  });
});

/** Static fake credentials: presigning is a local HMAC, so none reach a network. */
const FAKE_CREDENTIALS = Object.freeze({
  accessKeyId: 'AKIAEXAMPLEEXAMPLE00',
  secretAccessKey: 'example-secret-key-not-real-0000000000000',
});

function signingDisk(options: Partial<S3DiskOptions> = {}): S3Disk {
  return new S3Disk({
    bucket: 'media-bucket',
    region: 'us-east-1',
    credentials: FAKE_CREDENTIALS,
    endpoint: 'https://s3.example.test',
    forcePathStyle: true,
    ...options,
  });
}

const ATTACHMENT = Object.freeze({
  expiresInMs: 60_000,
  contentDisposition: { type: 'attachment', filename: 'Résumé "final".pdf' },
  contentType: 'application/pdf',
} as const);

describe('S3Disk.signedUrl', () => {
  it('signs the prefixed key with the lifetime, disposition and type as response overrides', async () => {
    const url = new URL(
      await signingDisk({ prefix: 'assets' }).signedUrl('report.pdf', ATTACHMENT),
    );
    assert.equal(url.origin, 'https://s3.example.test');
    assert.equal(url.pathname, '/media-bucket/assets/report.pdf');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
    assert.equal(
      url.searchParams.get('response-content-disposition'),
      `attachment; filename="R_sum_ \\"final\\".pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    assert.equal(url.searchParams.get('response-content-type'), 'application/pdf');
    assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
    assert.doesNotMatch(url.href, /example-secret-key/);
  });

  it('rounds the lifetime up to whole seconds and accepts the 7-day maximum', async () => {
    const store = signingDisk();
    const options = (expiresInMs: number) => ({ ...ATTACHMENT, expiresInMs });
    const expires = async (ms: number) =>
      new URL(await store.signedUrl('a.txt', options(ms))).searchParams.get('X-Amz-Expires');
    assert.equal(await expires(1500), '2');
    assert.equal(await expires(SIGNED_URL_MAX_EXPIRES_IN_MS), '604800');
    for (const ms of [0, 999, 1.5, SIGNED_URL_MAX_EXPIRES_IN_MS + 1, Number.NaN]) {
      await assert.rejects(store.signedUrl('a.txt', options(ms)), isCode('invalid_option'));
    }
  });

  it('requires every option and refuses header injection', async () => {
    const store = signingDisk();
    const bad: unknown[] = [
      null,
      { ...ATTACHMENT, contentType: undefined },
      { ...ATTACHMENT, contentDisposition: undefined },
      { ...ATTACHMENT, contentDisposition: { type: 'download' } },
      { ...ATTACHMENT, contentDisposition: { type: 'attachment', filename: 'a\r\nSet-Cookie: x' } },
      { ...ATTACHMENT, contentType: 'text/html\r\nX-Injected: 1' },
      { ...ATTACHMENT, contentType: 'not a type' },
    ];
    for (const options of bad) {
      await assert.rejects(store.signedUrl('a.txt', options as never), isCode('invalid_option'));
    }
    await assert.rejects(store.signedUrl('../escape', ATTACHMENT), isCode('invalid_key'));
  });

  it('signs through an injected S3Client without sending anything', async () => {
    let sent = 0;
    const client = new S3Client({
      region: 'eu-west-1',
      // A copy: the SDK annotates the credentials object it is handed.
      credentials: { ...FAKE_CREDENTIALS },
      requestHandler: {
        handle: () => {
          sent += 1;
          return Promise.reject(new Error('no request may be sent'));
        },
      },
    });
    const url = new URL(
      await new S3Disk({ bucket: 'media-bucket', client }).signedUrl('k.txt', ATTACHMENT),
    );
    assert.equal(url.hostname, 'media-bucket.s3.eu-west-1.amazonaws.com');
    assert.equal(sent, 0);
  });

  it('refuses with unsupported around a send double, and reduces a signing failure to io_failed', async () => {
    await assert.rejects(fakeDisk().disk.signedUrl('k.txt', ATTACHMENT), isCode('unsupported'));
    const client = new S3Client({
      region: 'us-east-1',
      credentials: () => Promise.reject(new Error('credential secret-token-xyz expired')),
    });
    await assert.rejects(
      new S3Disk({ bucket: 'b', client }).signedUrl('k.txt', ATTACHMENT),
      (error: unknown) => {
        isCode('io_failed')(error);
        assert.doesNotMatch((error as Error).message, /secret-token-xyz|k\.txt/);
        return true;
      },
    );
  });
});
