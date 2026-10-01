/**
 * The streaming multipart reader (`ctx.body.multipart()`).
 *
 * The reader alone: parts in wire order, header parsing as the WHATWG parser
 * reads a browser's form, every declared limit (each a `too_large` that
 * tells `onLimit`, a file's stream erroring rather than ending short),
 * value-free 422s for a file in an undeclared field, a refused media type
 * and malformed framing, a sticky first failure, the remainder of a skipped
 * file discarded and its stream failed, an early `return` that leaves the
 * file being read readable, and a body that stops arriving cut off by the
 * idle bound or the signal, the source released either way. Every split
 * point of a fixed corpus parses to the same parts as the whole body, and a
 * 512 MiB file piped to a sink keeps what is reachable under 64 MiB
 * (measured after a full collection, so it counts what the reader keeps,
 * not what the heap has yet to reclaim).
 *
 * Through a route: a `multipart` body declaration is validated, frozen and
 * made canonical (every default stated, file fields by name, media types
 * sorted and distinct), so two with the same effect check to one spec and
 * the route's row shows every limit, a part past its cap answers 413 even when the handler swallows the
 * stream's error, a file in an undeclared field 422, a stalled part 504
 * with the body released, and a multipart read on a route that declares
 * another kind is refused in production too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { publicAccess } from '../../src/api/access-ref.js';
import type { MultipartPart, RouteContext } from '../../src/contracts/http.js';
import { createApp, routeTableOf } from '../../src/server/app.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import { MultipartErrors, readMultipart } from '../../src/server/multipart.js';
import { createRequestBody } from '../../src/server/request-body.js';
import { RouteErrors } from '../../src/server/route-meta.js';
import { checkBodySpec, type BodySpec, type MultipartSpec } from '../../src/server/route-limits.js';

const BOUNDARY = 'xYzZy-0123';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] } as const;
const encoder = new TextEncoder();

/** One part as the corpus writes it: its header lines and its body. */
interface WirePart {
  readonly headers: readonly string[];
  readonly body: string | Uint8Array;
}

/** A multipart body of `parts`, with an optional preamble, epilogue and transport padding. */
function wire(
  parts: readonly WirePart[],
  options: { preamble?: string; epilogue?: string; padding?: string } = {},
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const text = (value: string): void => {
    chunks.push(encoder.encode(value));
  };
  if (options.preamble !== undefined) text(`${options.preamble}\r\n`);
  for (const part of parts) {
    text(`--${BOUNDARY}${options.padding ?? ''}\r\n${part.headers.join('\r\n')}\r\n\r\n`);
    if (typeof part.body === 'string') text(part.body);
    else chunks.push(part.body);
    text('\r\n');
  }
  text(`--${BOUNDARY}--${options.epilogue ?? ''}`);
  return new Uint8Array(Buffer.concat(chunks));
}

function field(name: string, value: string): WirePart {
  return { headers: [`Content-Disposition: form-data; name="${name}"`], body: value };
}

function file(name: string, filename: string, body: string | Uint8Array, type?: string): WirePart {
  return {
    headers: [
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"`,
      ...(type === undefined ? [] : [`Content-Type: ${type}`]),
    ],
    body,
  };
}

/** A body stream delivering `chunks` one per pull, recording how far it was read and whether it was cancelled. */
function source(chunks: readonly Uint8Array[]): {
  readonly body: ReadableStream<Uint8Array>;
  pulled(): number;
  cancelled(): boolean;
} {
  let index = 0;
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled, cancelled: () => cancelled };
}

/** `bytes` in chunks of `size`. */
function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  return chunks;
}

/**
 * A body stream that delivers `head`, then never another byte: `waiting`
 * resolves once a read waits for more, `cancelled` when the reader
 * releases the body.
 */
function stalled(head: Uint8Array): {
  readonly body: ReadableStream<Uint8Array>;
  readonly waiting: Promise<void>;
  readonly cancelled: Promise<void>;
} {
  let release: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wait: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    wait = resolve;
  });
  let sent = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(head);
          return;
        }
        wait();
        await cancelled;
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, waiting, cancelled };
}

const SPEC: MultipartSpec = {
  maxParts: 10,
  maxFieldBytes: 1024,
  files: { f: { maxBytes: 4096, maxCount: 3 }, g: { maxBytes: 4096 } },
};

/** Every part of a reader over `chunks`, each file read whole, as comparable data. */
async function describeParts(
  chunks: readonly Uint8Array[],
  spec: MultipartSpec = SPEC,
): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of readMultipart(source(chunks).body, CONTENT_TYPE, spec)) {
    if (part.kind === 'field') {
      parts.push({ kind: 'field', name: part.name, value: part.value });
      continue;
    }
    const bytes = Buffer.from(await new Response(part.stream).arrayBuffer());
    parts.push({
      kind: 'file',
      name: part.name,
      filename: part.filename,
      contentType: part.contentType,
      bytes: bytes.toString('base64'),
    });
  }
  return parts;
}

/** The reader's failure for `chunks`, read whole. */
async function failureOf(
  chunks: readonly Uint8Array[],
  spec: MultipartSpec = SPEC,
): Promise<unknown> {
  try {
    await describeParts(chunks, spec);
  } catch (error) {
    return error;
  }
  return assert.fail('the body was read without a failure');
}

/** The bytes of a file whose content looks like the boundary, CRLFs, and a stray CR at the end. */
const TRICKY = encoder.encode(
  `\r\n--${BOUNDARY.slice(0, -1)}\r\n-- \r\n\r\nx--${BOUNDARY}x\r--${BOUNDARY.slice(0, 4)}\r`,
);

const CORPUS: readonly Uint8Array[] = [
  wire([
    field('title', 'Hello'),
    file('f', 'a.png', TRICKY, 'Image/PNG; charset=binary'),
    field('empty', ''),
    file('f', 'empty.bin', new Uint8Array(0)),
    file('g', '', 'no name'),
  ]),
  wire(
    [
      field('unicode', 'héllo \u{1F600}'),
      {
        headers: [
          'content-disposition: form-data; filename="semi; name=x %22q%22.txt"; name="f"',
          'X-Other: ignored',
        ],
        body: 'quoted',
      },
      field('crlf', 'line one\r\nline two\r\n'),
    ],
    { preamble: 'This is a preamble.', epilogue: '\r\nAn epilogue.\r\n', padding: ' \t ' },
  ),
  wire([file('f', 'one.bin', new Uint8Array(1).fill(0x0d)), file('f', 'two.bin', '\r\n')]),
];

describe('readMultipart', () => {
  it('reads fields and files in wire order, with names and media types as the client sent them', async () => {
    const [first, second] = CORPUS;
    assert.ok(first !== undefined && second !== undefined);
    assert.deepEqual(await describeParts([first]), [
      { kind: 'field', name: 'title', value: 'Hello' },
      {
        kind: 'file',
        name: 'f',
        filename: 'a.png',
        contentType: 'image/png',
        bytes: Buffer.from(TRICKY).toString('base64'),
      },
      { kind: 'field', name: 'empty', value: '' },
      {
        kind: 'file',
        name: 'f',
        filename: 'empty.bin',
        contentType: 'application/octet-stream',
        bytes: '',
      },
      {
        kind: 'file',
        name: 'g',
        filename: '',
        contentType: 'application/octet-stream',
        bytes: Buffer.from('no name').toString('base64'),
      },
    ]);
    assert.deepEqual(await describeParts([second]), [
      { kind: 'field', name: 'unicode', value: 'héllo \u{1F600}' },
      {
        kind: 'file',
        name: 'f',
        filename: 'semi; name=x "q".txt',
        contentType: 'application/octet-stream',
        bytes: Buffer.from('quoted').toString('base64'),
      },
      { kind: 'field', name: 'crlf', value: 'line one\r\nline two\r\n' },
    ]);
  });

  it('parses every split point of the corpus to the same parts as the whole body', async () => {
    for (const [index, body] of CORPUS.entries()) {
      const whole = await describeParts([body]);
      for (let at = 1; at < body.length; at += 1) {
        const split = await describeParts([body.subarray(0, at), body.subarray(at)]);
        assert.deepEqual(split, whole, `corpus ${index}, split at ${at}`);
      }
      for (const size of [1, 2, 3, 7, 64]) {
        assert.deepEqual(await describeParts(chunked(body, size)), whole, `${index} by ${size}`);
      }
    }
  });

  it('refuses a request that is not multipart/form-data with a usable boundary, reading nothing', () => {
    for (const contentType of [
      null,
      'application/json',
      'multipart/mixed; boundary=abc',
      'multipart/form-data',
      'multipart/form-data; boundary=',
      `multipart/form-data; boundary=${'b'.repeat(71)}`,
      'multipart/form-data; boundary="ends in space "',
      'multipart/form-data; boundary=a; boundary=b',
    ]) {
      const counted = source([wire([field('a', '1')])]);
      assert.throws(
        () => readMultipart(counted.body, contentType, SPEC),
        (error: unknown) =>
          MultipartErrors.is(error, 'invalid') && error.context.problem === 'content_type',
        String(contentType),
      );
      assert.equal(counted.pulled(), 0);
    }
    const quoted = readMultipart(
      source([wire([field('a', '1')])]).body,
      `Multipart/Form-Data; charset=utf-8; boundary="${BOUNDARY}"`,
      SPEC,
    );
    assert.ok(quoted);
  });

  it('refuses malformed framing and headers, value-free', async () => {
    const cases: [string, Uint8Array, string][] = [
      ['truncated', wire([field('a', '1')]).subarray(0, 40), 'truncated'],
      ['no disposition', wire([{ headers: ['Content-Type: text/plain'], body: 'x' }]), 'headers'],
      ['no name', wire([{ headers: ['Content-Disposition: form-data'], body: 'x' }]), 'headers'],
      [
        'not form-data',
        wire([{ headers: ['Content-Disposition: attachment; name="a"'], body: 'x' }]),
        'headers',
      ],
      [
        'name twice',
        wire([{ headers: ['Content-Disposition: form-data; name="a"; name="b"'], body: 'x' }]),
        'headers',
      ],
      [
        'folded line',
        wire([{ headers: ['Content-Disposition: form-data;', ' name="a"'], body: 'x' }]),
        'headers',
      ],
      [
        'unterminated quote',
        wire([{ headers: ['Content-Disposition: form-data; name="a'], body: 'x' }]),
        'headers',
      ],
      ['bad file type', wire([file('f', 'a', 'x', 'not a type')]), 'headers'],
      ['no header block', encoder.encode(`--${BOUNDARY}\r\n\r\nx\r\n--${BOUNDARY}--`), 'headers'],
      ['junk after delimiter', encoder.encode(`--${BOUNDARY}junk\r\n`), 'framing'],
      ['long preamble', wire([field('a', '1')], { preamble: 'p'.repeat(9000) }), 'framing'],
      ['long epilogue', wire([field('a', '1')], { epilogue: 'e'.repeat(9000) }), 'framing'],
    ];
    for (const [label, body, problem] of cases) {
      const error = await failureOf([body]);
      assert.ok(MultipartErrors.is(error, 'invalid'), label);
      assert.equal(error.context.problem, problem, label);
      assert.doesNotMatch(error.message, /name|attachment|junk/, label);
    }
  });

  it('decodes a field part named like a prototype member as an ordinary field', async () => {
    const parts = await describeParts([wire([field('constructor', 'c'), field('__proto__', 'p')])]);
    assert.deepEqual(parts, [
      { kind: 'field', name: 'constructor', value: 'c' },
      { kind: 'field', name: '__proto__', value: 'p' },
    ]);
    const spec = checkBodySpec({
      kind: 'multipart',
      maxBytes: 1024,
      parts: { maxParts: 2, maxFieldBytes: 10, files: JSON.parse('{"__proto__":{"maxBytes":10}}') },
    });
    assert.ok(spec?.kind === 'multipart');
    const upload = await describeParts([wire([file('__proto__', 'p.bin', 'x')])], spec.parts);
    assert.equal((upload[0] as { kind: string }).kind, 'file');
  });

  it('refuses a file in a field the spec does not declare with a value-free 422', async () => {
    const error = await failureOf([wire([file('SECRET-FIELD', 'SECRET.txt', 'x')])]);
    assert.ok(MultipartErrors.is(error, 'unexpected_file'));
    assert.doesNotMatch(error.message, /SECRET/);
  });

  it('streams a declared file field sent without a filename', async () => {
    const parts = await describeParts([
      wire([{ headers: ['Content-Disposition: form-data; name="g"'], body: 'bytes' }]),
    ]);
    assert.deepEqual(parts, [
      {
        kind: 'file',
        name: 'g',
        filename: undefined,
        contentType: 'application/octet-stream',
        bytes: Buffer.from('bytes').toString('base64'),
      },
    ]);
  });

  it('accepts only the media types a file field lists, a whole type included', async () => {
    const spec: MultipartSpec = {
      maxParts: 4,
      maxFieldBytes: 16,
      files: { f: { maxBytes: 64, maxCount: 2, contentTypes: ['image/*', 'application/pdf'] } },
    };
    const parts = await describeParts(
      [wire([file('f', 'a.png', 'x', 'image/png'), file('f', 'b.pdf', 'y', 'Application/PDF')])],
      spec,
    );
    assert.equal(parts.length, 2);
    const error = await failureOf([wire([file('f', 'a.txt', 'x', 'text/plain')])], spec);
    assert.ok(MultipartErrors.is(error, 'unsupported_type'));
    const untyped = await failureOf([wire([file('f', 'a', 'x')])], spec);
    assert.ok(MultipartErrors.is(untyped, 'unsupported_type'));
  });

  it('fails each declared limit with too_large, telling onLimit once', async () => {
    const cases: [string, MultipartSpec, Uint8Array][] = [
      [
        'parts',
        { ...SPEC, maxParts: 2 },
        wire([field('a', '1'), field('b', '2'), field('c', '3')]),
      ],
      ['files', SPEC, wire([file('g', 'a', '1'), file('g', 'b', '2')])],
      ['field', { ...SPEC, maxFieldBytes: 4 }, wire([field('a', '12345')])],
      ['file', { ...SPEC, files: { g: { maxBytes: 4 } } }, wire([file('g', 'a', '12345')])],
      [
        'headers',
        { ...SPEC, maxHeaderBytes: 256 },
        wire([
          { headers: [`Content-Disposition: form-data; name="${'n'.repeat(300)}"`], body: '' },
        ]),
      ],
    ];
    for (const [limit, spec, body] of cases) {
      let told = 0;
      let failure: unknown;
      try {
        for await (const part of readMultipart(source([body]).body, CONTENT_TYPE, spec, {
          onLimit: () => {
            told += 1;
          },
        })) {
          if (part.kind === 'file') await new Response(part.stream).arrayBuffer();
        }
      } catch (error) {
        failure = error;
      }
      assert.ok(MultipartErrors.is(failure, 'too_large'), limit);
      assert.equal(failure.context.limit, limit);
      assert.equal(told, 1, limit);
    }
  });

  it('accepts a body exactly at each limit', async () => {
    const spec: MultipartSpec = { maxParts: 2, maxFieldBytes: 5, files: { g: { maxBytes: 4 } } };
    const parts = await describeParts([wire([field('a', '12345'), file('g', 'a', '1234')])], spec);
    assert.equal(parts.length, 2);
  });

  it('errors a file stream past its cap having read at most the cap and a chunk', async () => {
    const chunk = 512;
    const body = wire([file('g', 'big.bin', new Uint8Array(64 * 1024).fill(0x41))]);
    const counted = source(chunked(body, chunk));
    const cap = 2048;
    let told = false;
    const reader = readMultipart(
      counted.body,
      CONTENT_TYPE,
      { maxParts: 2, maxFieldBytes: 16, files: { g: { maxBytes: cap } } },
      {
        onLimit: () => {
          told = true;
        },
      },
    );
    const first = await reader.next();
    assert.ok(first.done !== true && first.value.kind === 'file');
    await assert.rejects(new Response(first.value.stream).arrayBuffer(), (error: unknown) =>
      MultipartErrors.is(error, 'too_large'),
    );
    assert.ok(told);
    assert.ok(counted.pulled() <= cap + 2 * chunk, `pulled ${counted.pulled()} bytes`);
    assert.ok(counted.cancelled(), 'the body was released');
    await assert.rejects(reader.next(), (error: unknown) => MultipartErrors.is(error, 'too_large'));
  });

  it('fails the file before an extra part rather than ending it complete', async () => {
    const body = wire([file('g', 'a', 'payload'), field('extra', 'x')]);
    const reader = readMultipart(source([body]).body, CONTENT_TYPE, { ...SPEC, maxParts: 1 });
    const first = await reader.next();
    assert.ok(first.done !== true && first.value.kind === 'file');
    await assert.rejects(new Response(first.value.stream).arrayBuffer(), (error: unknown) =>
      MultipartErrors.is(error, 'too_large'),
    );
  });

  it('errors a truncated file stream', async () => {
    const body = wire([file('g', 'a', 'abcdef')]);
    const reader = readMultipart(
      source([body.subarray(0, body.length - 12)]).body,
      CONTENT_TYPE,
      SPEC,
    );
    const first = await reader.next();
    assert.ok(first.done !== true && first.value.kind === 'file');
    await assert.rejects(new Response(first.value.stream).arrayBuffer(), (error: unknown) =>
      MultipartErrors.is(error, 'invalid'),
    );
    await assert.rejects(reader.next(), (error: unknown) => MultipartErrors.is(error, 'invalid'));
  });

  it('discards the rest of a file the caller moves past, counting it, and fails its stream', async () => {
    const big = new Uint8Array(4000).fill(0x42);
    const body = wire([file('f', 'skipped.bin', big), field('after', 'yes')]);
    const counted = source(chunked(body, 1000));
    const reader = readMultipart(counted.body, CONTENT_TYPE, SPEC);
    const first = await reader.next();
    assert.ok(first.done !== true && first.value.kind === 'file');
    const held = first.value.stream.getReader();
    const second = await reader.next();
    assert.deepEqual(second, {
      done: false,
      value: { kind: 'field', name: 'after', value: 'yes' },
    });
    await assert.rejects(held.read(), (error: unknown) =>
      MultipartErrors.is(error, 'part_abandoned'),
    );
    const skippedOverCap = readMultipart(
      source([wire([file('g', 'big.bin', new Uint8Array(8192)), field('after', 'x')])]).body,
      CONTENT_TYPE,
      SPEC,
    );
    await skippedOverCap.next();
    await assert.rejects(skippedOverCap.next(), (error: unknown) =>
      MultipartErrors.is(error, 'too_large'),
    );
    assert.deepEqual(await reader.next(), { done: true, value: undefined });
    assert.equal(counted.pulled(), body.length);
  });

  it('keeps a file readable after the iteration ends early, then releases the body', async () => {
    const body = wire([file('g', 'kept.bin', 'kept bytes'), field('ignored', 'x')]);
    const counted = source(chunked(body, 7));
    let kept: MultipartPart | undefined;
    for await (const part of readMultipart(counted.body, CONTENT_TYPE, SPEC)) {
      kept = part;
      break;
    }
    assert.ok(kept?.kind === 'file');
    assert.equal(counted.cancelled(), false);
    assert.equal(await new Response(kept.stream).text(), 'kept bytes');
    assert.ok(counted.cancelled(), 'the body was released once the file ended');
  });

  it('releases the body at once when the iteration ends with no file open', async () => {
    const counted = source([wire([field('a', '1'), field('b', '2')])]);
    for await (const part of readMultipart(counted.body, CONTENT_TYPE, SPEC)) {
      assert.equal(part.kind, 'field');
      break;
    }
    assert.ok(counted.cancelled());
  });

  it('cuts off a part that stops arriving for idleMs, releasing the body', async () => {
    const body = wire([file('g', 'slow.bin', 'never finished')]);
    const slow = stalled(body.subarray(0, body.length - 20));
    const reader = readMultipart(slow.body, CONTENT_TYPE, { ...SPEC, idleMs: 30 });
    const first = await reader.next();
    assert.ok(first.done !== true && first.value.kind === 'file');
    await assert.rejects(new Response(first.value.stream).arrayBuffer(), (error: unknown) =>
      MultipartErrors.is(error, 'idle'),
    );
    await slow.cancelled;
    await assert.rejects(reader.next(), (error: unknown) => MultipartErrors.is(error, 'idle'));
  });

  it('cuts off a part waiting on the client when the signal aborts', async () => {
    const body = wire([field('a', 'waiting')]);
    const slow = stalled(body.subarray(0, 30));
    const controller = new AbortController();
    const reader = readMultipart(slow.body, CONTENT_TYPE, SPEC, { signal: controller.signal });
    const next = reader.next();
    await slow.waiting;
    controller.abort();
    await assert.rejects(next, (error: unknown) => MultipartErrors.is(error, 'aborted'));
    await slow.cancelled;
  });

  it('cancels at once, settling a read that waits on the client', async () => {
    const slow = stalled(wire([field('a', 'waiting')]).subarray(0, 30));
    const reader = readMultipart(slow.body, CONTENT_TYPE, SPEC);
    const next = reader.next();
    await slow.waiting;
    await reader.cancel();
    await slow.cancelled;
    await assert.rejects(next, (error: unknown) => MultipartErrors.is(error, 'invalid'));
    assert.deepEqual(await reader.next(), { done: true, value: undefined });
  });

  it('keeps reachable memory under 64 MiB while a 512 MiB file is piped to a sink', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const collect = (): number => {
      gc();
      gc();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const MiB = 1024 * 1024;
    const total = 512 * MiB;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const head = encoder.encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="g"; filename="big.bin"\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
    let sent = 0;
    let stage = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (stage === 0) {
            stage = 1;
            controller.enqueue(head);
          } else if (sent < total) {
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          } else if (stage === 1) {
            stage = 2;
            controller.enqueue(tail);
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const baseline = collect();
    let peak = 0;
    let received = 0;
    let nextSample = 64 * MiB;
    const spec: MultipartSpec = {
      maxParts: 1,
      maxFieldBytes: 1,
      files: { g: { maxBytes: total } },
    };
    for await (const part of readMultipart(body, CONTENT_TYPE, spec)) {
      assert.equal(part.kind, 'file');
      if (part.kind !== 'file') continue;
      await part.stream.pipeTo(
        new WritableStream<Uint8Array>({
          write(bytes) {
            received += bytes.byteLength;
            if (received >= nextSample) {
              nextSample += 64 * MiB;
              peak = Math.max(peak, collect() - baseline);
            }
          },
        }),
      );
    }
    assert.equal(received, total);
    assert.ok(peak < 64 * MiB, `reachable memory grew by ${Math.round(peak / MiB)} MiB`);
  });
});

describe('a multipart body declaration', () => {
  const parts = {
    maxParts: 3,
    maxFieldBytes: 100,
    maxHeaderBytes: 1024,
    idleMs: 5000,
    files: { avatar: { maxBytes: 1000, maxCount: 2, contentTypes: ['Image/PNG', 'image/*'] } },
  };

  it('is checked, copied and frozen, its files without a prototype and its types lowercased', () => {
    const spec = checkBodySpec({ kind: 'multipart', maxBytes: 2048, parts });
    assert.ok(spec?.kind === 'multipart');
    assert.equal(Object.getPrototypeOf(spec.parts.files), null);
    assert.deepEqual(spec.parts.files.avatar?.contentTypes, ['image/*', 'image/png']);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.parts));
    assert.ok(Object.isFrozen(spec.parts.files) && Object.isFrozen(spec.parts.files.avatar));
    assert.notEqual(spec.parts, parts);
  });

  it('states every default and lists its fields and media types in one canonical order', () => {
    const spec = checkBodySpec({
      kind: 'multipart',
      maxBytes: 2048,
      parts: {
        maxParts: 3,
        maxFieldBytes: 100,
        files: {
          photo: { maxBytes: 10, contentTypes: ['image/webp', 'IMAGE/PNG', 'image/png'] },
          doc: { maxBytes: 20 },
        },
      },
    });
    assert.ok(spec?.kind === 'multipart');
    assert.deepEqual(Object.keys(spec.parts.files), ['doc', 'photo']);
    assert.deepEqual(
      { ...spec.parts, files: { ...spec.parts.files } },
      {
        maxParts: 3,
        maxFieldBytes: 100,
        maxHeaderBytes: 8 * 1024,
        files: {
          doc: { maxBytes: 20, maxCount: 1 },
          photo: { maxBytes: 10, maxCount: 1, contentTypes: ['image/png', 'image/webp'] },
        },
        idleMs: 30_000,
      },
    );
  });

  it('checks two declarations with the same effect to one spec, and any differing limit to another', () => {
    const check = (value: unknown): BodySpec | undefined =>
      checkBodySpec({ kind: 'multipart', maxBytes: 2048, parts: value });
    const base = check(parts);
    assert.ok(base !== undefined);
    assert.deepEqual(
      check({
        files: {
          avatar: {
            contentTypes: ['image/*', 'image/png', 'IMAGE/png'],
            maxCount: 2,
            maxBytes: 1000,
          },
        },
        idleMs: 5000,
        maxHeaderBytes: 1024,
        maxFieldBytes: 100,
        maxParts: 3,
      }),
      base,
    );
    const defaults = { maxParts: 3, maxFieldBytes: 100, files: { avatar: { maxBytes: 1000 } } };
    assert.deepEqual(
      check(defaults),
      check({
        ...defaults,
        maxHeaderBytes: 8 * 1024,
        idleMs: 30_000,
        files: { avatar: { maxBytes: 1000, maxCount: 1 } },
      }),
    );
    const avatar = parts.files.avatar;
    const differing: unknown[] = [
      { ...parts, maxParts: 2 },
      { ...parts, maxFieldBytes: 99 },
      { ...parts, maxHeaderBytes: 2048 },
      { ...parts, idleMs: 6000 },
      { ...parts, files: { avatar: { ...avatar, maxBytes: 999 } } },
      { ...parts, files: { avatar: { ...avatar, maxCount: 1 } } },
      { ...parts, files: { avatar: { ...avatar, contentTypes: ['image/png'] } } },
      { ...parts, files: { avatar: { maxBytes: 1000, maxCount: 2 } } },
      { ...parts, files: { photo: avatar } },
      { ...parts, files: { ...parts.files, photo: avatar } },
    ];
    for (const variant of differing) {
      assert.notDeepEqual(check(variant), base, JSON.stringify(variant));
    }
    assert.notDeepEqual(checkBodySpec({ kind: 'multipart', maxBytes: 2047, parts }), base);
  });

  it("records a route's declared parts on its row in the canonical form", async () => {
    const { routes, contributions } = createHttpRoutes({
      owner: 'app',
      origin: 'app',
      allow: { mount: false, guard: false, transform: false },
    });
    const declared: BodySpec = {
      kind: 'multipart',
      maxBytes: 4096,
      parts: {
        maxParts: 2,
        maxFieldBytes: 100,
        files: { file: { maxBytes: 1024, contentTypes: ['IMAGE/PNG', 'image/png'] } },
      },
    };
    routes.add({
      methods: ['POST'],
      path: '/media',
      access: publicAccess('multipart test'),
      credentials: [],
      body: declared,
      handler: () => new Response(''),
    });
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
    const row = routeTableOf(app)
      ?.entries()
      .find((meta) => meta.pattern === '/media');
    assert.deepEqual(row?.body, {
      kind: 'multipart',
      maxBytes: 4096,
      parts: {
        maxParts: 2,
        maxFieldBytes: 100,
        maxHeaderBytes: 8 * 1024,
        files: Object.assign(Object.create(null) as object, {
          file: { maxBytes: 1024, maxCount: 1, contentTypes: ['image/png'] },
        }),
        idleMs: 30_000,
      },
    });
  });

  it('refuses a limit out of range or past the body cap, and any unknown member', () => {
    const file = parts.files.avatar;
    const variants: unknown[] = [
      { maxBytes: 2048 },
      { maxBytes: 2048, parts, extra: true },
      { maxBytes: 2048, parts: null },
      { maxBytes: 2048, parts: { ...parts, maxParts: 0 } },
      { maxBytes: 2048, parts: { ...parts, maxParts: 1001 } },
      { maxBytes: 2048, parts: { ...parts, maxParts: 1.5 } },
      { maxBytes: 2048, parts: { ...parts, maxFieldBytes: 4096 } },
      { maxBytes: 2048, parts: { ...parts, maxHeaderBytes: 100 } },
      { maxBytes: 2048, parts: { ...parts, maxHeaderBytes: 1024 * 1024 } },
      { maxBytes: 2048, parts: { ...parts, idleMs: 0 } },
      { maxBytes: 2048, parts: { ...parts, unknown: 1 } },
      { maxBytes: 2048, parts: { ...parts, files: [] } },
      { maxBytes: 2048, parts: { ...parts, files: new Map() } },
      { maxBytes: 2048, parts: { ...parts, files: { '': file } } },
      { maxBytes: 2048, parts: { ...parts, files: { avatar: { ...file, maxBytes: 4096 } } } },
      { maxBytes: 2048, parts: { ...parts, files: { avatar: { ...file, maxCount: 4 } } } },
      { maxBytes: 2048, parts: { ...parts, files: { avatar: { ...file, contentTypes: [] } } } },
      {
        maxBytes: 2048,
        parts: { ...parts, files: { avatar: { ...file, contentTypes: ['*/*'] } } },
      },
      {
        maxBytes: 2048,
        parts: { ...parts, files: { avatar: { ...file, contentTypes: ['png'] } } },
      },
      { maxBytes: 2048, parts: { ...parts, files: { avatar: { ...file, contentTypes: [1] } } } },
      { maxBytes: 2048, parts: { ...parts, files: { avatar: { ...file, other: 1 } } } },
      { maxBytes: 200 * 1024 * 1024, parts },
    ];
    for (const variant of variants) {
      assert.equal(
        checkBodySpec({ kind: 'multipart', ...(variant as object) }),
        undefined,
        JSON.stringify(variant),
      );
    }
  });

  it('fails a route that declares a malformed one at registration', () => {
    const { routes } = createHttpRoutes({
      owner: 'app',
      origin: 'app',
      allow: { mount: false, guard: false, transform: false },
    });
    assert.throws(
      () =>
        routes.add({
          methods: ['POST'],
          path: '/bad',
          access: publicAccess('multipart test'),
          credentials: [],
          body: { kind: 'multipart', maxBytes: 10, parts: { ...parts, maxFieldBytes: 100 } },
          handler: () => new Response('never'),
        }),
      (error: unknown) =>
        RouteErrors.is(error, 'invalid_route') && error.context.problem === 'invalid_body',
    );
  });
});

describe('ctx.body.multipart()', () => {
  it('refuses a route that declares another kind, in production too', () => {
    const request = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': CONTENT_TYPE },
      body: wire([field('a', '1')]),
    });
    for (const strict of [true, false]) {
      const body = createRequestBody(
        request,
        { kind: 'raw', maxBytes: 1024 },
        {
          strict,
          budget: undefined,
          signal: () => new AbortController().signal,
        },
      );
      assert.throws(
        () => body.multipart(),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'body.undeclared_read' &&
          (error as { context?: { reader?: unknown } }).context?.reader === 'multipart',
      );
    }
  });
});

describe('a route that reads a multipart body', () => {
  const UPLOAD: BodySpec = {
    kind: 'multipart',
    maxBytes: 64 * 1024,
    parts: { maxParts: 4, maxFieldBytes: 128, files: { avatar: { maxBytes: 1024 } }, idleMs: 50 },
  };

  async function buildApp(
    handler: (context: RouteContext) => Promise<Response>,
    options: { body?: BodySpec; timeoutMs?: number } = {},
  ) {
    const { routes, contributions } = createHttpRoutes({
      owner: 'app',
      origin: 'app',
      allow: { mount: false, guard: false, transform: false },
    });
    routes.add({
      methods: ['POST'],
      path: '/upload',
      access: publicAccess('multipart route test'),
      credentials: [],
      body: options.body ?? UPLOAD,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      handler,
    });
    return createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
  }

  function post(body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>): Request {
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': CONTENT_TYPE },
      body,
      duplex: 'half',
    };
    return new Request('http://localhost/upload', init);
  }

  /** Read every part: a field's value, a file's byte count. */
  async function readAll(context: RouteContext): Promise<Response> {
    const seen: string[] = [];
    for await (const part of context.body.multipart()) {
      if (part.kind === 'field') {
        seen.push(`${part.name}=${part.value}`);
      } else {
        const bytes = await new Response(part.stream).arrayBuffer();
        seen.push(`${part.name}:${part.filename ?? ''}:${part.contentType}:${bytes.byteLength}`);
      }
    }
    return Response.json(seen);
  }

  it('hands the handler its fields and file streams', async () => {
    const app = await buildApp(readAll);
    const response = await app.fetch(
      post(wire([field('caption', 'Me'), file('avatar', 'me.png', 'PNGDATA', 'image/png')])),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ['caption=Me', 'avatar:me.png:image/png:7']);
  });

  it('answers 413 for a part past its cap, though the handler swallowed the stream error', async () => {
    let seen: unknown;
    const app = await buildApp(async (context) => {
      for await (const part of context.body.multipart()) {
        if (part.kind !== 'file') continue;
        try {
          await new Response(part.stream).arrayBuffer();
        } catch (error) {
          seen = error;
          return new Response('handled', { status: 200 });
        }
      }
      return new Response('read');
    });
    const response = await app.fetch(
      post(wire([file('avatar', 'big.png', new Uint8Array(4096).fill(1), 'image/png')])),
    );
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { code: string }).code, 'request.too_large');
    assert.equal(response.headers.get('connection'), 'close');
    assert.ok(MultipartErrors.is(seen, 'too_large'), 'the handler saw the errored stream');
  });

  it('answers 422 for a file in a field the route does not declare', async () => {
    const app = await buildApp(readAll);
    const response = await app.fetch(post(wire([file('other', 'x.bin', 'x')])));
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { code: string }).code, 'multipart.unexpected_file');
  });

  it('aborts a part trickled slower than idleMs and releases the body', async () => {
    const body = wire([file('avatar', 'slow.png', 'trickle')]);
    const slow = stalled(body.subarray(0, body.length - 20));
    const app = await buildApp(readAll);
    const response = await app.fetch(post(slow.body));
    assert.equal(response.status, 504);
    assert.equal(((await response.json()) as { code: string }).code, 'multipart.idle');
    await slow.cancelled;
  });

  it('aborts a part waiting on the client when the route deadline passes', async () => {
    const body = wire([file('avatar', 'slow.png', 'trickle')]);
    const slow = stalled(body.subarray(0, body.length - 20));
    const patient: BodySpec = {
      kind: 'multipart',
      maxBytes: 64 * 1024,
      parts: { maxParts: 4, maxFieldBytes: 128, files: { avatar: { maxBytes: 1024 } } },
    };
    const app = await buildApp(readAll, { body: patient, timeoutMs: 50 });
    const response = await app.fetch(post(slow.body));
    assert.equal(response.status, 504);
    await slow.cancelled;
  });
});
