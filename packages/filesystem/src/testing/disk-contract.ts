/**
 * `runDiskContract`: the `Disk` conformance suite, registered as ordinary
 * `node:test` tests against a factory, so a custom disk is checked against the
 * same guarantees as the first-party ones.
 *
 * Every scenario gets a fresh subject. After it runs, the subject must report
 * no leftovers (temp files, open multipart uploads: whatever the store can
 * hold outside its objects), and no uncaught exception or unhandled rejection
 * may have been raised while it ran: a stream error nobody listened to fails
 * the suite instead of passing unnoticed.
 *
 * The suite covers round trips at the sizes where a disk changes how it
 * stores (0, 1, `partSize - 1`, `partSize`, `partSize + 1`, three parts and a
 * remainder) from each source shape, SHA-256 and size reporting, `maxBytes`
 * crossed mid-stream, `ifAbsent` (including two racing writers), range edges,
 * missing keys, key validation, paged and scoped listing in UTF-8 byte order,
 * prefix deletion, abort before and during a write (readers keep seeing the
 * previous object while it runs), a failing source, and,
 * through `faults`, a store that fails while bytes flow. Every failure must be
 * the matching `disk.*` code.
 *
 * In this repository a known failure is listed in an expected-failure ledger
 * by its test file and name path `["disk contract: <name>", "<scenario>"]`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { DiskErrors, readBytes, type ByteSource, type Disk } from 'jsails/filesystem';

/**
 * One disk under test and how to inspect what it left behind.
 *
 * @public
 */
export interface DiskContractSubject {
  readonly disk: Disk;
  /**
   * Whatever the store holds besides its objects (temp files, open multipart
   * uploads), each described by a short label; empty when nothing is left.
   */
  leftovers(): Promise<readonly string[]>;
  /** Release the subject's resources after its scenario. */
  close?(): Promise<void>;
}

/**
 * Builds a fresh, empty subject for each scenario.
 *
 * @public
 */
export type DiskContractFactory = () => DiskContractSubject | Promise<DiskContractSubject>;

/**
 * Fault injection for {@link runDiskContract}.
 *
 * @public
 */
export interface DiskContractFaults {
  /**
   * A fresh subject whose store fails while a write's bytes are flowing (a
   * full disk, a 500 on the second part). The write must reject with
   * `disk.io_failed` and leave nothing behind.
   */
  failingSink?(): DiskContractSubject | Promise<DiskContractSubject>;
}

/**
 * Options for {@link runDiskContract}.
 *
 * @public
 */
export interface DiskContractOptions {
  /** The size at which the disk changes how it stores a write (S3's part size). Defaults to 64 KiB. */
  readonly partSize?: number;
  /** True when `stat` and `read` report the content type a write stored. */
  readonly persistsContentType?: boolean;
  readonly faults?: DiskContractFaults;
}

const BAD_KEYS = ['', '/abs', '../up', 'a/../b', 'a//b', 'a\\b', 'C:x', 'nul\u0000', 'end/'];

/** The source chunk size of streamed writes: a prime, so chunks never align with parts. */
const CHUNK = 7919;

/**
 * Deterministic bytes, so a misplaced chunk changes the content: a reader that
 * returns the next `length` bytes of the sequence for `seed` on each call.
 */
function patternReader(seed = 1): (length: number) => Uint8Array {
  let state = seed;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      bytes[index] = state >>> 24;
    }
    return bytes;
  };
}

/** The first `size` bytes of the sequence for `seed`. */
function pattern(size: number, seed = 1): Uint8Array {
  return patternReader(seed)(size);
}

/**
 * `pattern(size, seed)` as chunks of `chunkSize`, made as the disk reads them.
 * The multi-part sizes run to several MiB per write for S3's part size, so a
 * scenario that streams its source, hashes it and compares the read-back
 * chunk by chunk never holds the whole object besides the store's own copy.
 */
async function* patternChunks(
  size: number,
  seed = 1,
  chunkSize = CHUNK,
): AsyncGenerator<Uint8Array> {
  const next = patternReader(seed);
  for (let offset = 0; offset < size; offset += chunkSize) {
    yield next(Math.min(chunkSize, size - offset));
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The SHA-256 of `pattern(size, seed)`, hashed a chunk at a time. */
function patternSha256(size: number, seed = 1): string {
  const hash = createHash('sha256');
  const next = patternReader(seed);
  for (let offset = 0; offset < size; offset += CHUNK) {
    hash.update(next(Math.min(CHUNK, size - offset)));
  }
  return hash.digest('hex');
}

/** Whether `stream` yields exactly `pattern(size, seed)`, compared chunk by chunk. */
async function matchesPattern(
  stream: ReadableStream<Uint8Array>,
  size: number,
  seed = 1,
): Promise<boolean> {
  const next = patternReader(seed);
  let seen = 0;
  let equal = true;
  for await (const chunk of stream) {
    // Keep reading after a mismatch, so the stream is drained, not abandoned.
    if (
      equal &&
      (seen + chunk.byteLength > size || Buffer.compare(next(chunk.byteLength), chunk) !== 0)
    ) {
      equal = false;
    }
    seen += chunk.byteLength;
  }
  return equal && seen === size;
}

/**
 * Yields `bytes`, then never ends: a client that stopped sending. `onStall`
 * runs once the disk has taken the bytes and asks for more.
 */
function stalling(bytes: Uint8Array, onStall: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    pull: () => {
      onStall();
      return new Promise<void>(() => undefined);
    },
  });
}

/** A source that fails after its first chunk, the way a dropped request body does. */
async function* failingAfter(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
  throw new DOMException('the request body was interrupted', 'NetworkError');
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(DiskErrors.is(error), `expected disk.${code}, got ${String(error)}`);
    assert.equal(error.code, `disk.${code}`);
    return true;
  });
}

function readable(bytes: Uint8Array): ByteSource {
  return new Blob([new Uint8Array(bytes)]).stream();
}

/** Run `body` against a fresh subject, then require no leftovers and no stray process errors. */
async function withSubject(
  factory: () => DiskContractSubject | Promise<DiskContractSubject>,
  body: (disk: Disk) => Promise<void>,
): Promise<void> {
  const stray: unknown[] = [];
  const record = (error: unknown): void => {
    stray.push(error);
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  const subject = await factory();
  try {
    await body(subject.disk);
    // Let a stream error emitted after the operation settled surface here.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await subject.leftovers(), [], 'the disk left temp files or uploads behind');
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
    await subject.close?.();
  }
  assert.deepEqual(stray, [], 'an uncaught exception or unhandled rejection was raised');
}

/**
 * Register the `Disk` conformance scenarios for `factory` under
 * `describe("disk contract: <name>")`.
 *
 * Stores the first-party S3 disk supports: AWS S3, Cloudflare R2 and MinIO
 * pass it whole. SeaweedFS ignores `If-None-Match` (declare it with
 * `conditionalWrites: false`, and the `ifAbsent` scenarios then fail with
 * `disk.unsupported`) and lists in its own order, so the listing scenario
 * fails there too.
 *
 * @public
 */
export function runDiskContract(
  name: string,
  factory: DiskContractFactory,
  options: DiskContractOptions = {},
): void {
  const part = options.partSize ?? 64 * 1024;
  const scenario = (title: string, body: (disk: Disk) => Promise<void>): void => {
    scheduled(test(title, () => withSubject(factory, body)));
  };

  scheduled(
    describe(`disk contract: ${name}`, () => {
      const sizes: [string, number][] = [
        ['0 bytes', 0],
        ['1 byte', 1],
        ['one part less a byte', part - 1],
        ['one part', part],
        ['one part and a byte', part + 1],
        ['three parts and a remainder', 3 * part + 7],
      ];
      for (const [label, size] of sizes) {
        scenario(`round-trips ${label} with its size and SHA-256`, async (disk) => {
          const result = await disk.write('round/trip.bin', patternChunks(size), {
            maxBytes: size,
          });
          assert.equal(result.size, size);
          assert.equal(result.sha256, patternSha256(size));
          assert.equal((await disk.stat('round/trip.bin'))?.size, size);
          const object = await disk.read('round/trip.bin');
          assert.equal(object.size, size);
          assert.equal(object.start, 0);
          assert.equal(object.end, size - 1);
          assert.ok(await matchesPattern(object.stream, size), 'the bytes read back differ');
        });
      }

      scenario('accepts a buffer, a web stream and an async iterable alike', async (disk) => {
        const bytes = pattern(1000, 7);
        const sources: [string, ByteSource][] = [
          ['buffer', bytes],
          ['stream', readable(bytes)],
          ['iterable', patternChunks(1000, 7, 333)],
        ];
        for (const [key, source] of sources) {
          const result = await disk.write(`shapes/${key}`, source, { maxBytes: 1000 });
          assert.equal(result.sha256, sha256(bytes));
          assert.ok(
            Buffer.from(await readBytes(disk, `shapes/${key}`, { maxBytes: 1000 })).equals(bytes),
          );
        }
      });

      scenario('replaces an object on overwrite', async (disk) => {
        await disk.write('over/write', pattern(10, 1), { maxBytes: 10 });
        const second = pattern(5, 2);
        await disk.write('over/write', second, { maxBytes: 10 });
        assert.ok(
          Buffer.from(await readBytes(disk, 'over/write', { maxBytes: 10 })).equals(second),
        );
      });

      scenario('refuses a write past maxBytes mid-stream and stores nothing', async (disk) => {
        const size = 3 * part + 7;
        await rejectsWith(
          disk.write('too/large', patternChunks(size), { maxBytes: size - 1 }),
          'too_large',
        );
        assert.equal(await disk.stat('too/large'), null);
      });

      scenario('keeps the previous object when an overwrite is refused', async (disk) => {
        const kept = pattern(10, 3);
        await disk.write('keep/me', kept, { maxBytes: 10 });
        await rejectsWith(
          disk.write('keep/me', patternChunks(2 * part, 1, 4096), { maxBytes: part }),
          'too_large',
        );
        assert.ok(Buffer.from(await readBytes(disk, 'keep/me', { maxBytes: 10 })).equals(kept));
      });

      scenario('requires maxBytes and well-formed write options', async (disk) => {
        await rejectsWith(
          disk.write('opts', pattern(1), {} as { maxBytes: number }),
          'invalid_option',
        );
        await rejectsWith(disk.write('opts', pattern(1), { maxBytes: -1 }), 'invalid_option');
        await rejectsWith(
          disk.write('opts', pattern(1), { maxBytes: 1, contentType: 'text/html\r\nx: y' }),
          'invalid_option',
        );
        assert.equal(await disk.stat('opts'), null);
      });

      scenario('refuses ifAbsent over a stored object and keeps it', async (disk) => {
        const first = pattern(8, 4);
        await disk.write('once', first, { maxBytes: 8, ifAbsent: true });
        await rejectsWith(
          disk.write('once', pattern(8, 5), { maxBytes: 8, ifAbsent: true }),
          'conflict',
        );
        assert.ok(Buffer.from(await readBytes(disk, 'once', { maxBytes: 8 })).equals(first));
      });

      scenario('lets exactly one of two racing ifAbsent writers win', async (disk) => {
        const outcomes = await Promise.allSettled([
          disk.write('race', patternChunks(2 * part + 1, 6, 4096), {
            maxBytes: 3 * part,
            ifAbsent: true,
          }),
          disk.write('race', patternChunks(2 * part + 1, 8, 4096), {
            maxBytes: 3 * part,
            ifAbsent: true,
          }),
        ]);
        const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
        assert.equal(won.length, 1);
        assert.equal(lost.length, 1);
        assert.ok(DiskErrors.is((lost[0] as PromiseRejectedResult).reason, 'conflict'));
        const stored = await readBytes(disk, 'race', { maxBytes: 3 * part });
        assert.equal(
          sha256(stored),
          (won[0] as PromiseFulfilledResult<{ sha256: string }>).value.sha256,
        );
      });

      scenario('serves range edges and refuses unsatisfiable ranges', async (disk) => {
        const bytes = pattern(10, 9);
        await disk.write('ranges', bytes, { maxBytes: 10 });
        const cases: [{ start: number; end?: number }, number, number][] = [
          [{ start: 0, end: 0 }, 0, 0],
          [{ start: 9 }, 9, 9],
          [{ start: 9, end: 9 }, 9, 9],
          [{ start: 2, end: 100 }, 2, 9],
          [{ start: 0, end: 9 }, 0, 9],
        ];
        for (const [range, start, end] of cases) {
          const object = await disk.read('ranges', { range });
          assert.deepEqual([object.size, object.start, object.end], [10, start, end]);
          assert.ok(
            Buffer.from(await collect(object.stream)).equals(bytes.subarray(start, end + 1)),
          );
        }
        for (const range of [{ start: 10 }, { start: -1 }, { start: 3, end: 2 }, { start: 1.5 }]) {
          await rejectsWith(disk.read('ranges', { range }), 'invalid_range');
        }
      });

      scenario('reads an empty object whole and refuses any range of it', async (disk) => {
        await disk.write('empty', new Uint8Array(0), { maxBytes: 0 });
        const object = await disk.read('empty');
        assert.deepEqual([object.size, object.start, object.end], [0, 0, -1]);
        assert.equal((await collect(object.stream)).byteLength, 0);
        await rejectsWith(disk.read('empty', { range: { start: 0 } }), 'invalid_range');
      });

      scenario(
        'reports a missing key as not_found, null and an idempotent delete',
        async (disk) => {
          await rejectsWith(disk.read('missing/key'), 'not_found');
          assert.equal(await disk.stat('missing/key'), null);
          await disk.delete('missing/key');
          await disk.write('gone', pattern(3), { maxBytes: 3 });
          await disk.delete('gone');
          await disk.delete('gone');
          assert.equal(await disk.stat('gone'), null);
        },
      );

      scenario('refuses malformed keys on every method', async (disk) => {
        for (const key of BAD_KEYS) {
          await rejectsWith(disk.write(key, pattern(1), { maxBytes: 1 }), 'invalid_key');
          await rejectsWith(disk.read(key), 'invalid_key');
          await rejectsWith(disk.stat(key), 'invalid_key');
          await rejectsWith(disk.delete(key), 'invalid_key');
          await rejectsWith(disk.deletePrefix(key), 'invalid_key');
          if (key !== '') await rejectsWith(disk.list(key, { limit: 10 }), 'invalid_key');
        }
      });

      scenario(
        'lists in UTF-8 byte order, scoped to the prefix, one page at a time',
        async (disk) => {
          const keys = ['b', 'ab/5', 'a/sub/4', 'a/3', 'a-x', 'a/2', 'a/1'];
          for (const key of keys) await disk.write(key, pattern(1), { maxBytes: 1 });
          const all = await disk.list('', { limit: 1000 });
          assert.deepEqual(all.keys, ['a-x', 'a/1', 'a/2', 'a/3', 'a/sub/4', 'ab/5', 'b']);
          assert.equal(all.cursor, undefined);

          const first = await disk.list('a', { limit: 2 });
          assert.deepEqual(first.keys, ['a/1', 'a/2']);
          assert.equal(typeof first.cursor, 'string');
          const rest: string[] = [];
          let cursor = first.cursor;
          while (cursor !== undefined) {
            const page = await disk.list('a', { limit: 2, cursor });
            rest.push(...page.keys);
            cursor = page.cursor;
          }
          assert.deepEqual(rest, ['a/3', 'a/sub/4']);
          assert.deepEqual((await disk.list('nothing', { limit: 10 })).keys, []);
        },
      );

      scenario('refuses a bad page size or cursor', async (disk) => {
        await disk.write('x', pattern(1), { maxBytes: 1 });
        for (const limit of [0, 1001, 1.5]) {
          await rejectsWith(disk.list('', { limit }), 'invalid_option');
        }
        await rejectsWith(
          disk.list('', { limit: 1, cursor: '%%not a cursor%%' }),
          'invalid_cursor',
        );
      });

      scenario('deletes every object under a prefix and nothing else', async (disk) => {
        for (const key of ['a/1', 'a/sub/2', 'a-x', 'ab/3', 'b']) {
          await disk.write(key, pattern(1), { maxBytes: 1 });
        }
        await disk.deletePrefix('a');
        assert.deepEqual((await disk.list('', { limit: 100 })).keys, ['a-x', 'ab/3', 'b']);
        await disk.deletePrefix('nothing/here');
      });

      scenario('reports the modification time of a stored object', async (disk) => {
        await disk.write('timed', pattern(4), { maxBytes: 4 });
        const stat = await disk.stat('timed');
        assert.ok(stat !== null && stat.modifiedAt instanceof Date);
        assert.ok(!Number.isNaN(stat.modifiedAt.getTime()));
      });

      if (options.persistsContentType === true) {
        scenario('returns the stored content type', async (disk) => {
          await disk.write('typed.png', pattern(4), { maxBytes: 4, contentType: 'image/png' });
          assert.equal((await disk.stat('typed.png'))?.contentType, 'image/png');
          const object = await disk.read('typed.png');
          assert.equal(object.contentType, 'image/png');
          await object.stream.cancel();
        });
      }

      scenario('refuses an already-aborted write and read without storing', async (disk) => {
        const controller = new AbortController();
        controller.abort();
        await rejectsWith(
          disk.write('aborted', pattern(4), { maxBytes: 4, signal: controller.signal }),
          'aborted',
        );
        assert.equal(await disk.stat('aborted'), null);
        await disk.write('present', pattern(4), { maxBytes: 4 });
        await rejectsWith(disk.read('present', { signal: controller.signal }), 'aborted');
      });

      scenario('aborts a stalled overwrite, serving the stored object throughout', async (disk) => {
        const kept = pattern(10, 11);
        await disk.write('stalled', kept, { maxBytes: 10 });
        const controller = new AbortController();
        let onStall = (): void => undefined;
        const stalled = new Promise<void>((resolve) => {
          onStall = resolve;
        });
        const writing = disk.write('stalled', stalling(pattern(2 * part + 1), onStall), {
          maxBytes: 10 * part,
          signal: controller.signal,
        });
        await stalled;
        // A write in progress is invisible: readers see the previous object.
        assert.ok(Buffer.from(await readBytes(disk, 'stalled', { maxBytes: 10 })).equals(kept));
        controller.abort();
        await rejectsWith(writing, 'aborted');
        assert.ok(Buffer.from(await readBytes(disk, 'stalled', { maxBytes: 10 })).equals(kept));
      });

      scenario('aborts a write whose source stalls mid-stream and stores nothing', async (disk) => {
        const controller = new AbortController();
        const writing = disk.write(
          'stalled',
          stalling(pattern(2 * part + 1), () => controller.abort()),
          { maxBytes: 10 * part, signal: controller.signal },
        );
        await rejectsWith(writing, 'aborted');
        assert.equal(await disk.stat('stalled'), null);
      });

      scenario('rejects a write whose source fails and stores nothing', async (disk) => {
        await rejectsWith(
          disk.write('failed/source', failingAfter(pattern(2 * part + 1)), { maxBytes: 10 * part }),
          'source_failed',
        );
        assert.equal(await disk.stat('failed/source'), null);
      });

      const failingSink = options.faults?.failingSink;
      if (failingSink !== undefined) {
        scheduled(
          test('rejects a write whose store fails mid-stream and stores nothing', () =>
            withSubject(failingSink.bind(options.faults), async (disk) => {
              await rejectsWith(
                disk.write('failed/sink', patternChunks(3 * part + 7), {
                  maxBytes: 10 * part,
                }),
                'io_failed',
              );
              assert.equal(await disk.stat('failed/sink'), null);
            })),
        );
      }
    }),
  );
}

/**
 * Hand a node:test registration promise back to the runner. It settles when
 * the test or suite finishes and never rejects (the runner reports failures
 * itself), so a rejection would be a runner defect; it is rethrown as an
 * uncaught exception rather than dropped.
 */
function scheduled(registration: Promise<void>): void {
  registration.catch((error: unknown) => {
    setImmediate(() => {
      throw error;
    });
  });
}
