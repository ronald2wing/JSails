/** Tests for the bounded stream readers `readStreamBounded` (including cancellation) and `boundStream`. */

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

describe('readStreamBounded cancellation', () => {
  /** An endless stream that records whether it was cancelled. */
  function endless(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, cancelled: () => cancelled };
  }

  it('cancels the source once the bound is exceeded, so its sender can stop', async () => {
    const source = endless();
    await assert.rejects(readStreamBounded(source.stream, 10, overflow), OverflowError);
    assert.equal(source.cancelled(), true);
    // The lock is released too, so the stream is no longer held.
    assert.equal(source.stream.locked, false);
  });

  it('does not cancel a stream it read to the end', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    await readStreamBounded(stream, 10, overflow);
    assert.equal(cancelled, false);
  });

  it('keeps the overflow error when cancelling the source fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });
    await assert.rejects(readStreamBounded(stream, 2, overflow), OverflowError);
  });
});

describe('boundStream', () => {
  it('passes chunks through while the total stays within the bound', async () => {
    const bounded = boundStream(streamOf([Uint8Array.of(1), Uint8Array.of(2)]), {
      maxBytes: 2,
      overflow: () => new OverflowError('too large'),
    });
    const bytes = await readStreamBounded(bounded, 16, overflow);
    assert.deepEqual([...bytes], [1, 2]);
  });

  it('errors the stream with the caller-made error once the bound is exceeded', async () => {
    const bounded = boundStream(streamOf([Uint8Array.of(1, 2), Uint8Array.of(3)]), {
      maxBytes: 2,
      overflow: () => new OverflowError('too large'),
    });
    const reader = bounded.getReader();
    const first = await reader.read();
    assert.deepEqual(first.done ? [] : [...first.value], [1, 2]);
    await assert.rejects(reader.read(), OverflowError);
  });

  it('reads nothing from the source until the consumer asks', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(Uint8Array.of(pulls));
          if (pulls === 2) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    let firstPulls = 0;
    const bounded = boundStream(source, {
      maxBytes: 8,
      overflow: () => new OverflowError('too large'),
      onFirstPull: () => {
        firstPulls += 1;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pulls, 0);
    assert.equal(firstPulls, 0);
    const bytes = await readStreamBounded(bounded, 16, overflow);
    assert.deepEqual([...bytes], [1, 2]);
    assert.equal(firstPulls, 1);
  });

  it('reads the bound at count time and reports each chunk and the end', async () => {
    let bound = 1;
    const totals: number[] = [];
    const settled: boolean[] = [];
    const bounded = boundStream(streamOf([Uint8Array.of(1, 2), Uint8Array.of(3)]), {
      maxBytes: () => bound,
      overflow: () => new OverflowError('too large'),
      onChunk: (total) => totals.push(total),
      onSettle: (complete) => settled.push(complete),
    });
    bound = 3;
    const bytes = await readStreamBounded(bounded, 16, overflow);
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.deepEqual(totals, [2, 3]);
    assert.deepEqual(settled, [true]);
  });

  it('settles incomplete when the bound is crossed or the consumer cancels', async () => {
    const settled: boolean[] = [];
    const over = boundStream(streamOf([Uint8Array.of(1, 2, 3)]), {
      maxBytes: 2,
      overflow: () => new OverflowError('too large'),
      onSettle: (complete) => settled.push(complete),
    });
    await assert.rejects(readStreamBounded(over, 16, overflow), OverflowError);
    const cancelled = boundStream(streamOf([Uint8Array.of(1)]), {
      maxBytes: 2,
      overflow: () => new OverflowError('too large'),
      onSettle: (complete) => settled.push(complete),
    });
    await cancelled.cancel();
    assert.deepEqual(settled, [false, false]);
  });
});
