/**
 * The shared write pipeline: `meterByteSource` counts, hashes and bounds every
 * source shape the same way, cancels the source on an early end, and honours
 * an abort while the source is stalled; `resolveDiskRange` and
 * `assertRangeShape` hold the range rules every disk shares.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  meterByteSource,
  resolveDiskRange,
  throwIfDiskAborted,
} from '../../src/filesystem/byte-source.js';
import type { ByteSource } from '../../src/filesystem/disk.js';
import { DiskErrors } from '../../src/filesystem/disk-errors.js';
import { isSha256 } from '../../src/filesystem/sha256.js';

const TEXT = new TextEncoder().encode('hello, disk');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function* split(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(DiskErrors.is(error), 'a disk error');
    assert.equal(error.code, `disk.${code}`);
    return true;
  });
}

describe('meterByteSource', () => {
  const shapes: [string, () => ByteSource][] = [
    ['a buffer', () => TEXT],
    ['a web stream', () => new Blob([TEXT]).stream()],
    ['an async iterable', () => split(TEXT, 3)],
  ];
  for (const [label, make] of shapes) {
    it(`reports the size and SHA-256 of ${label}`, async () => {
      const metered = meterByteSource(make(), { maxBytes: TEXT.byteLength });
      assert.deepEqual(await drain(metered.chunks), Buffer.from(TEXT));
      const result = metered.result();
      assert.equal(result.size, TEXT.byteLength);
      assert.equal(result.sha256, sha256(TEXT));
      assert.ok(isSha256(result.sha256));
    });
  }

  it('hashes an empty source', async () => {
    const metered = meterByteSource(new Uint8Array(0), { maxBytes: 0 });
    await drain(metered.chunks);
    assert.deepEqual(metered.result(), { size: 0, sha256: sha256(new Uint8Array(0)) });
  });

  it('fails with too_large one byte past the limit and cancels the source', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const metered = meterByteSource(source, { maxBytes: 10 });
    await rejectsWith(drain(metered.chunks), 'too_large');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.throws(() => metered.result());
  });

  it('wraps a source failure as source_failed with the original as cause', async () => {
    const cause = new Error('connection reset');
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(1);
      throw cause;
    }
    const metered = meterByteSource(failing(), { maxBytes: 10 });
    await assert.rejects(drain(metered.chunks), (error: unknown) => {
      assert.ok(DiskErrors.is(error, 'source_failed'));
      assert.equal((error as Error).cause, cause);
      return true;
    });
  });

  it('refuses a chunk that is not bytes, and a source of the wrong shape', async () => {
    async function* strings(): AsyncGenerator<unknown> {
      yield 'text';
    }
    const metered = meterByteSource(strings() as AsyncIterable<Uint8Array>, { maxBytes: 10 });
    await rejectsWith(drain(metered.chunks), 'invalid_source');
    assert.throws(
      () => meterByteSource('text' as unknown as ByteSource, { maxBytes: 10 }),
      (error: unknown) => DiskErrors.is(error, 'invalid_source'),
    );
  });

  it('requires maxBytes to be a non-negative integer', () => {
    for (const maxBytes of [-1, 1.5, Number.NaN, undefined]) {
      assert.throws(
        () => meterByteSource(TEXT, { maxBytes } as { maxBytes: number }),
        (error: unknown) => DiskErrors.is(error, 'invalid_option'),
      );
    }
  });

  it('refuses an already-aborted signal before any chunk is read', () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => meterByteSource(TEXT, { maxBytes: 100, signal: controller.signal }),
      (error: unknown) => DiskErrors.is(error, 'aborted'),
    );
  });

  it('aborts a stalled source promptly and cancels it', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const metered = meterByteSource(source, { maxBytes: 100, signal: controller.signal });
    const draining = drain(metered.chunks);
    setTimeout(() => controller.abort(new Error('client went away')), 10);
    await rejectsWith(draining, 'aborted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });

  it('can be iterated once', async () => {
    const metered = meterByteSource(TEXT, { maxBytes: 100 });
    await drain(metered.chunks);
    await assert.rejects(drain(metered.chunks));
  });
});

describe('throwIfDiskAborted', () => {
  it('names the operation and keeps the reason as cause', () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    assert.throws(
      () => throwIfDiskAborted(controller.signal, 'read'),
      (error: unknown) => {
        assert.ok(DiskErrors.is(error, 'aborted'));
        assert.equal(error.message, 'the disk read was aborted');
        assert.equal((error as Error).cause, reason);
        return true;
      },
    );
    throwIfDiskAborted(undefined, 'read');
  });
});

describe('resolveDiskRange', () => {
  it('resolves whole objects, clamps the end, and refuses unsatisfiable ranges', () => {
    assert.deepEqual(resolveDiskRange(undefined, 10), { start: 0, end: 9 });
    assert.deepEqual(resolveDiskRange(undefined, 0), { start: 0, end: -1 });
    assert.deepEqual(resolveDiskRange({ start: 0, end: 0 }, 10), { start: 0, end: 0 });
    assert.deepEqual(resolveDiskRange({ start: 9 }, 10), { start: 9, end: 9 });
    assert.deepEqual(resolveDiskRange({ start: 2, end: 100 }, 10), { start: 2, end: 9 });
    for (const range of [
      { start: 10 },
      { start: 0 },
      { start: -1 },
      { start: 3, end: 2 },
      { start: 1.5 },
    ]) {
      const size = range.start === 0 ? 0 : 10;
      assert.throws(
        () => resolveDiskRange(range, size),
        (error: unknown) => DiskErrors.is(error, 'invalid_range'),
      );
    }
  });
});
