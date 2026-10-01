/**
 * Response model: every response, whatever produced it, leaves the pipeline
 * finalized the same way.
 *
 * The cross product is producer x response transform (none, a header and a
 * cookie added to the answer, a header added) x Accept-Encoding (none,
 * gzip, br) x cache declaration (none, public) x status (where the producer
 * takes one), sent through both drivers. Each test checks one invariant for
 * one producer over all its cases and names the kinds of violation it found,
 * so a work package that fixes an invariant removes exactly those rows from
 * `scripts/expected-failures/request.json`. Only invariants are asserted,
 * never header order or timings beyond the streaming bound.
 *
 * Invariants: the producer's status survives finalization (never a 500 from
 * it); the headers and cookies a transform adds arrive; the body arrives intact once its
 * content coding is removed; a content coding is one the request accepted;
 * exactly one cache policy is sent; a declared public route carries its
 * declared policy and an undeclared one is private; `Vary` names every
 * contributor (encoding, cookie); a small sized body is sent whole with
 * `Content-Length` and no encoding, and a large compressible one is encoded
 * when the client accepts it; a streamed body arrives chunk by chunk as it is
 * produced; and no public cache policy is sent for an uncacheable status or a
 * cookie-setting answer. A problem names the requested encoding where it
 * matters, so a new kind of violation changes the failure's first line.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { brotliDecompressSync, gzipSync, gunzipSync, inflateSync } from 'node:zlib';

import { TEST_ORIGIN } from '../../fixtures/app.js';
import { createDrivers, type DrivenResponse, type Driver } from './drivers.js';
import { createResponseApp, PRODUCERS, producerPath, type Producer } from './response-app.js';
import { gateOutcome, releaseGate, type GateOutcome } from './stream-gate.js';

type Middleware = 'none' | 'cookie' | 'header';
type Encoding = 'identity' | 'gzip' | 'br';

interface ResponseCase {
  readonly producer: Producer;
  readonly middleware: Middleware;
  readonly encoding: Encoding;
  readonly cacheable: boolean;
  readonly status: number;
}

interface Outcome {
  readonly case: ResponseCase;
  readonly response?: DrivenResponse;
  readonly failure?: string;
  /** Streaming producers: whether the client saw the first chunk while the producer waited. */
  readonly gate?: GateOutcome;
}

/**
 * An invariant: a problem description for one outcome, or `undefined`.
 * `peers` are every outcome of the same producer through the same driver.
 */
interface Invariant {
  readonly name: string;
  readonly applies: (producer: Producer) => boolean;
  readonly check: (
    outcome: Outcome & { response: DrivenResponse },
    peers: readonly Outcome[],
  ) => string | undefined;
}

const MIDDLEWARE: readonly Middleware[] = ['none', 'cookie', 'header'];
const ENCODINGS: readonly Encoding[] = ['identity', 'gzip', 'br'];
const SHARED_CACHEABLE = new Set([200, 203, 204, 206, 301, 308, 404, 410]);

function casesOf(producer: Producer): ResponseCase[] {
  const cases: ResponseCase[] = [];
  for (const middleware of MIDDLEWARE) {
    for (const encoding of ENCODINGS) {
      for (const cacheable of producer.declaresCache ? [false, true] : [false]) {
        for (const status of producer.statuses) {
          cases.push({ producer, middleware, encoding, cacheable, status });
        }
      }
    }
  }
  return cases;
}

function label(responseCase: ResponseCase): string {
  const { middleware, encoding, cacheable, status } = responseCase;
  return `${status} ${cacheable ? 'public' : 'undeclared'} mw=${middleware} ae=${encoding}`;
}

function requestOf(responseCase: ResponseCase, gate: string): Request {
  const { producer, middleware, encoding, cacheable, status } = responseCase;
  const query = producer.statuses.length > 1 ? `?status=${status}` : '';
  const headers: Record<string, string> = { accept: 'text/html,application/json', 'x-gate': gate };
  if (middleware !== 'none') headers['x-middleware'] = middleware;
  if (encoding !== 'identity') headers['accept-encoding'] = encoding;
  return new Request(`${TEST_ORIGIN}${producerPath(producer, cacheable)}${query}`, { headers });
}

function varyFields(headers: Headers): Set<string> {
  return new Set(
    (headers.get('vary') ?? '')
      .split(',')
      .map((field) => field.trim().toLowerCase())
      .filter((field) => field !== ''),
  );
}

/** The body with its content coding removed, or a problem description. */
function decodedBody(response: DrivenResponse): Uint8Array | string {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase() ?? 'identity';
  try {
    if (encoding === 'identity') return response.body;
    if (encoding === 'gzip') return new Uint8Array(gunzipSync(response.body));
    if (encoding === 'br') return new Uint8Array(brotliDecompressSync(response.body));
    if (encoding === 'deflate') return new Uint8Array(inflateSync(response.body));
  } catch {
    return `undecodable ${encoding} body`;
  }
  return `unknown content coding ${encoding}`;
}

/** The outcome a page producer's other cases are compared with: plain, unencoded. */
function referenceOf(peers: readonly Outcome[], status: number): DrivenResponse | undefined {
  return peers.find(
    ({ case: peer }) =>
      peer.middleware === 'none' &&
      peer.encoding === 'identity' &&
      !peer.cacheable &&
      peer.status === status,
  )?.response;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function hasCookie(response: DrivenResponse, name: string): boolean {
  return response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${name}=`));
}

const INVARIANTS: readonly Invariant[] = [
  {
    name: 'keeps the producer status',
    applies: () => true,
    check: ({ case: { status }, response }) =>
      response.status === status ? undefined : `answered ${response.status}`,
  },
  {
    name: 'keeps the headers and cookies a transform adds',
    applies: () => true,
    check: ({ case: { middleware }, response }) => {
      const problems: string[] = [];
      if (middleware !== 'none' && response.headers.get('x-added') !== middleware) {
        problems.push('added header lost');
      }
      if (middleware === 'cookie' && !hasCookie(response, 'added')) {
        problems.push('added cookie lost');
      }
      return problems.length === 0 ? undefined : problems.join(', ');
    },
  },
  {
    name: 'delivers the body intact',
    applies: () => true,
    check: ({ case: { producer, status, encoding }, response }, peers) => {
      const received = response.headers.get('content-encoding') ?? 'none';
      const where = `(sent ${received}, ae=${encoding})`;
      if (response.error !== undefined) return `body cut short ${where}`;
      const body = decodedBody(response);
      if (typeof body === 'string') return `${body} ${where}`;
      if ('exact' in producer.body) {
        const expected = new TextEncoder().encode(producer.body.exact);
        return sameBytes(body, expected) ? undefined : `body differs ${where}`;
      }
      // A page document's bytes are the renderer's; every case must decode to
      // what the plain, unencoded request received, and that must hold the
      // page's own text.
      const reference = referenceOf(peers, status);
      if (reference === undefined) return 'no plain reference case';
      if (!new TextDecoder().decode(reference.body).includes(producer.body.contains)) {
        return 'reference body lacks the page text';
      }
      return sameBytes(body, reference.body) ? undefined : `body differs ${where}`;
    },
  },
  {
    name: 'encodes only as the request accepts',
    applies: () => true,
    check: ({ case: { encoding }, response }) => {
      const sent = response.headers.get('content-encoding');
      if (sent === null || sent.trim().toLowerCase() === encoding) return undefined;
      return `encoded as ${sent} (ae=${encoding})`;
    },
  },
  {
    name: 'applies the declared cache policy',
    applies: () => true,
    check: ({ case: { producer, cacheable, status, middleware }, response }) => {
      const value = response.headers.get('cache-control') ?? '';
      if (!cacheable) {
        return /\b(?:private|no-store)\b/i.test(value) ? undefined : 'undeclared route not private';
      }
      // A public policy is owed only to a complete 200 body with no cookie
      // (no request in the matrix carries a credential): a streamed or
      // partial body is not stored as a whole, and the `cookie` middleware sets
      // a cookie.
      if (status !== 200 || producer.streams || middleware === 'cookie') return undefined;
      if (response.headers.getSetCookie().length > 0) return undefined;
      const declared = /\bpublic\b/i.test(value) && /\bs-maxage=60\b/i.test(value);
      return declared ? undefined : 'declared public policy missing';
    },
  },
  {
    name: 'sends exactly one cache policy',
    applies: () => true,
    check: ({ response }) => {
      const value = response.headers.get('cache-control');
      if (value === null) return 'no Cache-Control';
      const sent = response.rawHeaders?.filter(([name]) => name.toLowerCase() === 'cache-control');
      if (sent !== undefined && sent.length !== 1) return `${sent.length} Cache-Control headers`;
      if (/\bpublic\b/i.test(value) && /\b(?:private|no-store)\b/i.test(value)) {
        return 'conflicting Cache-Control';
      }
      return undefined;
    },
  },
  {
    name: 'varies on every contributor',
    applies: () => true,
    check: ({ case: { producer }, response }) => {
      const vary = varyFields(response.headers);
      const problems: string[] = [];
      const encoded = response.headers.has('content-encoding');
      if ((encoded || producer.compressible) && !vary.has('accept-encoding') && !vary.has('*')) {
        problems.push(
          encoded
            ? 'encoded without Vary: Accept-Encoding'
            : 'negotiable encoding without Vary: Accept-Encoding',
        );
      }
      if (response.headers.getSetCookie().length > 0 && !vary.has('cookie') && !vary.has('*')) {
        problems.push('Set-Cookie without Vary: Cookie');
      }
      return problems.length === 0 ? undefined : problems.join(', ');
    },
  },
  {
    name: 'sends a small body whole and unencoded',
    applies: (producer) => producer.small,
    check: ({ case: { encoding: requested }, response }) => {
      const problems: string[] = [];
      const encoding = response.headers.get('content-encoding');
      if (encoding !== null) problems.push(`small body encoded as ${encoding} (ae=${requested})`);
      // `Content-Length` is a wire fact: a `Response` handed to `app.fetch`
      // need not carry it, the adapter derives it from a sized body.
      if (response.rawHeaders !== undefined) {
        const length = response.headers.get('content-length');
        if (length === null) problems.push('no Content-Length');
        else if (Number(length) !== response.body.byteLength) problems.push('wrong Content-Length');
      }
      return problems.length === 0 ? undefined : problems.join(', ');
    },
  },
  {
    name: 'encodes a large body the client accepts',
    applies: (producer) => producer.compressible,
    check: ({ case: { encoding }, response }) => {
      if (encoding === 'identity' || response.headers.has('content-encoding')) return undefined;
      return `large body sent unencoded (ae=${encoding})`;
    },
  },
  {
    name: 'streams each chunk as it is produced',
    applies: (producer) => producer.streams,
    check: ({ response, gate }) => {
      if (response.chunks.length === 0) return 'no body';
      // The producer waits after its first chunk until the client has it
      // (stream-gate.ts): a pipeline that buffers the body cannot deliver it.
      if (gate !== 'released') return 'first chunk held until the producer finished';
      if (response.chunks.length < 2) return 'body arrived as one block';
      return undefined;
    },
  },
  {
    name: 'never declares a public cache for an uncacheable answer',
    applies: () => true,
    check: ({ response }) => {
      const value = response.headers.get('cache-control') ?? '';
      if (!/\bpublic\b/i.test(value) && !response.headers.has('surrogate-control'))
        return undefined;
      if (!SHARED_CACHEABLE.has(response.status)) return `public cache on ${response.status}`;
      if (response.headers.getSetCookie().length > 0) return 'public cache with Set-Cookie';
      return undefined;
    },
  },
];

const responseApp = await createResponseApp();
after(() => responseApp.close());
const drivers = createDrivers(responseApp.app);

let gates = 0;

async function sendCase(driver: Driver, responseCase: ResponseCase): Promise<Outcome> {
  gates += 1;
  const gate = `gate-${gates}`;
  try {
    const response = await driver.send(requestOf(responseCase, gate), {
      onChunk: (count) => {
        if (count === 1) releaseGate(gate);
      },
    });
    const outcome = gateOutcome(gate);
    return { case: responseCase, response, ...(outcome === undefined ? {} : { gate: outcome }) };
  } catch (error) {
    return { case: responseCase, failure: error instanceof Error ? error.message : String(error) };
  }
}

/** Send `cases` through `driver`, `width` at a time. */
async function sendInBatches(
  driver: Driver,
  cases: readonly ResponseCase[],
  width: number,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (let start = 0; start < cases.length; start += width) {
    const batch = cases.slice(start, start + width);
    outcomes.push(...(await Promise.all(batch.map((entry) => sendCase(driver, entry)))));
  }
  return outcomes;
}

/** Send every case through `driver`, a batch at a time. */
async function runAll(driver: Driver): Promise<Map<Producer, Outcome[]>> {
  const outcomes = new Map<Producer, Outcome[]>();
  for (const outcome of await sendInBatches(driver, PRODUCERS.flatMap(casesOf), 24)) {
    const list = outcomes.get(outcome.case.producer) ?? [];
    list.push(outcome);
    outcomes.set(outcome.case.producer, list);
  }
  return outcomes;
}

function assertInvariant(invariant: Invariant, outcomes: readonly Outcome[]): void {
  const problems = new Map<string, string[]>();
  for (const outcome of outcomes) {
    const problem =
      outcome.response === undefined
        ? `request failed: ${outcome.failure}`
        : invariant.check({ ...outcome, response: outcome.response }, outcomes);
    if (problem === undefined) continue;
    const examples = problems.get(problem) ?? [];
    examples.push(label(outcome.case));
    problems.set(problem, examples);
  }
  if (problems.size === 0) return;
  const kinds = [...problems.keys()].sort();
  const detail = kinds
    .map((kind) => {
      const examples = problems.get(kind) ?? [];
      return `  ${kind}: ${examples.length} of ${outcomes.length} cases, e.g. ${examples[0]}`;
    })
    .join('\n');
  assert.fail(`${invariant.name}: ${kinds.join('; ')}\n${detail}`);
}

function find(name: string): Producer {
  const producer = PRODUCERS.find((entry) => entry.name === name);
  if (producer === undefined) throw new Error(`no producer ${name}`);
  return producer;
}

describe('response model invariants', () => {
  function invariant(name: string): Invariant {
    const found = INVARIANTS.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no invariant ${name}`);
    return found;
  }

  function synthetic(body: Uint8Array | string, headers: Record<string, string>): DrivenResponse {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return {
      status: 200,
      headers: new Headers(headers),
      body: bytes,
      chunks: [{ bytes, at: 0 }],
      text: () => new TextDecoder().decode(bytes),
    };
  }

  function check(
    name: string,
    producerName: string,
    overrides: Partial<ResponseCase>,
    response: DrivenResponse,
  ): string | undefined {
    const responseCase: ResponseCase = {
      producer: find(producerName),
      middleware: 'none',
      encoding: 'identity',
      cacheable: false,
      status: 200,
      ...overrides,
    };
    return invariant(name).check({ case: responseCase, response }, []);
  }

  it('names the requested encoding of a small body encoded anyway', () => {
    const gzipped = synthetic(gzipSync('{"ok":true}'), { 'content-encoding': 'gzip' });
    assert.equal(
      check('sends a small body whole and unencoded', 'respond-json', {}, gzipped),
      'small body encoded as gzip (ae=identity)',
    );
    assert.equal(
      check('encodes only as the request accepts', 'respond-json', {}, gzipped),
      'encoded as gzip (ae=identity)',
    );
    assert.equal(
      check('encodes only as the request accepts', 'respond-json', { encoding: 'br' }, gzipped),
      'encoded as gzip (ae=br)',
    );
    assert.equal(
      check('encodes only as the request accepts', 'respond-json', { encoding: 'gzip' }, gzipped),
      undefined,
    );
  });

  it('decodes the body and finds it corrupted, truncated or encoded twice', () => {
    const name = 'delivers the body intact';
    const intact = synthetic(gzipSync('{"ok":true}'), { 'content-encoding': 'gzip' });
    assert.equal(check(name, 'respond-json', { encoding: 'gzip' }, intact), undefined);
    const twice = synthetic(gzipSync(gzipSync('{"ok":true}')), { 'content-encoding': 'gzip' });
    assert.equal(
      check(name, 'respond-json', { encoding: 'gzip' }, twice),
      'body differs (sent gzip, ae=gzip)',
    );
    const truncated = synthetic(gzipSync('{"ok":true}').subarray(0, 8), {
      'content-encoding': 'gzip',
    });
    assert.equal(
      check(name, 'respond-json', { encoding: 'gzip' }, truncated),
      'undecodable gzip body (sent gzip, ae=gzip)',
    );
    assert.equal(
      check(name, 'respond-json', {}, synthetic('{"ok":false}', {})),
      'body differs (sent none, ae=identity)',
    );
  });

  it('holds a declared route to its policy and an undeclared one to private', () => {
    const name = 'applies the declared cache policy';
    const privateAnswer = synthetic('{"ok":true}', { 'cache-control': 'private, no-store' });
    const publicAnswer = synthetic('{"ok":true}', {
      'cache-control': 'public, max-age=0, s-maxage=60',
    });
    assert.equal(
      check(name, 'respond-json', { cacheable: true }, privateAnswer),
      'declared public policy missing',
    );
    assert.equal(check(name, 'respond-json', { cacheable: true }, publicAnswer), undefined);
    assert.equal(check(name, 'respond-json', {}, publicAnswer), 'undeclared route not private');
    assert.equal(check(name, 'respond-json', {}, privateAnswer), undefined);
    assert.equal(
      check(name, 'respond-json', { cacheable: true, middleware: 'cookie' }, privateAnswer),
      undefined,
      'a cookie-setting answer owes no public policy',
    );
  });

  it('expects a large compressible body to be encoded when accepted', () => {
    const name = 'encodes a large body the client accepts';
    const plain = synthetic('x', {});
    assert.equal(
      check(name, 'large-json', { encoding: 'br' }, plain),
      'large body sent unencoded (ae=br)',
    );
    assert.equal(check(name, 'large-json', {}, plain), undefined);
  });
});

describe('response model', () => {
  for (const driver of drivers) {
    describe(driver.name, () => {
      let outcomes = new Map<Producer, Outcome[]>();
      before(async () => {
        outcomes = await runAll(driver);
      });

      for (const producer of PRODUCERS) {
        describe(producer.name, () => {
          for (const invariant of INVARIANTS) {
            if (!invariant.applies(producer)) continue;
            it(invariant.name, () => {
              assertInvariant(invariant, outcomes.get(producer) ?? []);
            });
          }
        });
      }

      describe('edge cases', () => {
        it('answers HEAD like GET, without a body', async () => {
          const path = `${TEST_ORIGIN}${producerPath(find('respond-json'), false)}`;
          const get = await driver.send(new Request(path));
          const head = await driver.send(new Request(path, { method: 'HEAD' }));
          assert.equal(head.status, get.status, 'HEAD status differs from GET');
          assert.equal(head.body.byteLength, 0, 'HEAD sent a body');
          assert.equal(
            head.headers.get('content-type'),
            get.headers.get('content-type'),
            'HEAD Content-Type differs from GET',
          );
          assert.equal(
            head.headers.get('content-length'),
            get.headers.get('content-length'),
            'HEAD Content-Length differs from GET',
          );
        });

        it('keeps a public route private for a session or Authorization request', async () => {
          const path = `${TEST_ORIGIN}${producerPath(find('respond-json'), true)}`;
          for (const [credential, headers] of [
            ['session', { cookie: 'sid=s1' }],
            ['Authorization', { authorization: 'Bearer token' }],
          ] as const) {
            const response = await driver.send(new Request(path, { headers }));
            assert.equal(response.status, 200);
            assert.doesNotMatch(
              response.headers.get('cache-control') ?? '',
              /\bpublic\b/,
              `public cache for a ${credential} request`,
            );
          }
        });

        it('keeps a 206 range answer intact', async () => {
          const path = `${TEST_ORIGIN}${producerPath(find('partial'), false)}`;
          const response = await driver.send(
            new Request(path, { headers: { 'accept-encoding': 'br, gzip' } }),
          );
          assert.equal(response.status, 206);
          assert.equal(response.headers.get('content-range'), 'bytes 0-4/11');
          assert.equal(response.headers.get('content-encoding'), null, '206 body encoded');
          assert.equal(response.text(), 'hello');
        });

        it('sends no error text after a mid-stream failure', async () => {
          const response = await driver.send(
            new Request(`${TEST_ORIGIN}/late`, { headers: { accept: 'text/html' } }),
          );
          assert.equal(response.status, 200);
          assert.ok(response.text().startsWith('<p>first</p>'), 'the first chunk was not sent');
          assert.doesNotMatch(
            response.text(),
            /late failure/,
            'the error message reached the client',
          );
        });
      });
    });
  }
});
