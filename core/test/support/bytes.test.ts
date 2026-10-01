/** Tests for the bounded stream readers `readStreamBounded` and `boundStream`. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundStream, readStreamBounded } from '../../src/support/bytes.js';

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

class OverflowError extends Error {}

function overflow(): never {
  throw new OverflowError('too large');
}

describe('readStreamBounded', () => {
  it('concatenates every chunk within the bound', async () => {
    const bytes = await readStreamBounded(
      streamOf([Uint8Array.of(1, 2), Uint8Array.of(3)]),
      3,
      overflow,
    );
    assert.deepEqual([...bytes], [1, 2, 3]);
  });

  it('treats a null body as empty', async () => {
    const bytes = await readStreamBounded(null, 8, overflow);
    assert.equal(bytes.byteLength, 0);
  });

  it('fails through the caller-supplied overflow as soon as the bound is exceeded', async () => {
    await assert.rejects(
      readStreamBounded(streamOf([Uint8Array.of(1, 2), Uint8Array.of(3, 4)]), 3, overflow),
      OverflowError,
    );
  });
});

describe('boundStream', () => {
  it('passes chunks through while the total stays within the bound', async () => {
    const bounded = boundStream(
      streamOf([Uint8Array.of(1), Uint8Array.of(2)]),
      2,
      () => new OverflowError('too large'),
    );
    const bytes = await readStreamBounded(bounded, 16, overflow);
    assert.deepEqual([...bytes], [1, 2]);
  });

  it('errors the stream with the caller-made error once the bound is exceeded', async () => {
    const bounded = boundStream(
      streamOf([Uint8Array.of(1, 2), Uint8Array.of(3)]),
      2,
      () => new OverflowError('too large'),
    );
    const reader = bounded.getReader();
    const first = await reader.read();
    assert.deepEqual(first.done ? [] : [...first.value], [1, 2]);
    await assert.rejects(reader.read(), OverflowError);
  });
});
