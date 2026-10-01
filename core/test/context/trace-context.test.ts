/**
 * W3C Trace Context conformance: the official test suite's cases
 * (`w3c/trace-context`, `test/test.py`, strict level 2, plus the Level 2
 * random-flag case), run in-process.
 *
 * The suite drives a service over HTTP: it sends request headers, the service
 * makes outbound calls back to the harness, and the harness checks the
 * `traceparent` and `tracestate` those calls carry. Here {@link service} is
 * that service: the received headers go through a Fetch `Headers` object
 * (which joins repeated headers with `, ` and strips surrounding whitespace,
 * as an HTTP server does), the work continues them with `traceFromHeaders`,
 * and each outbound call propagates a child span with `traceHeaders`. The
 * harness side parses what was sent with ports of the suite's own parsers
 * (`Traceparent.from_string`'s format and `tracecontext/tracestate.py`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  childTrace,
  createRootTrace,
  formatTraceparent,
  formatTracestate,
  isTraceSampled,
  parseTraceparent,
  parseTracestate,
  TRACE_FLAG_RANDOM,
  traceFromHeaders,
  traceHeaders,
} from '../../src/context/trace-context.js';

type HeaderList = readonly (readonly [string, string])[];

interface Received {
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: number;
  readonly tracestate: ReadonlyMap<string, string>;
  /** The tracestate as the harness prints it. */
  readonly tracestateText: string;
}

const TRACEPARENT_FORMAT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const KEY_FORMAT = '[0-9a-z][_0-9a-z\\-\\*\\/@]{0,255}';
const VALUE_FORMAT =
  '[\\x20-\\x2b\\x2d-\\x3c\\x3e-\\x7e]{0,255}[\\x21-\\x2b\\x2d-\\x3c\\x3e-\\x7e]';
const MEMBER_FORMAT = new RegExp(`^(${KEY_FORMAT})=(${VALUE_FORMAT})$`);

/** The harness's tracestate parser: what it reads from the service's outbound call. */
function harnessTracestate(value: string | undefined): Map<string, string> {
  const traits = new Map<string, string>();
  if (value === undefined) return traits;
  for (const member of value.split(/[ \t]*,[ \t]*/)) {
    if (member === '') continue;
    const match = MEMBER_FORMAT.exec(member);
    assert.ok(match, 'the service sent a malformed tracestate member');
    if (!traits.has(match[1]!)) traits.set(match[1]!, match[2]!);
  }
  return traits;
}

/** Send `headers` to the service; return what its `count` outbound calls carried. */
function service(headers: HeaderList, count = 1): Received[] {
  const received = new Headers();
  for (const [name, value] of headers) received.append(name, value);
  const trace = traceFromHeaders(received);
  return Array.from({ length: count }, () => {
    const outbound = traceHeaders(childTrace(trace));
    const match = TRACEPARENT_FORMAT.exec(outbound.traceparent);
    assert.ok(match, 'the service sent a malformed traceparent');
    const tracestate = harnessTracestate(outbound.tracestate);
    return {
      traceId: match[2]!,
      parentId: match[3]!,
      flags: Number.parseInt(match[4]!, 16),
      tracestate,
      tracestateText: [...tracestate].map(([key, value]) => `${key}=${value}`).join(','),
    };
  });
}

function single(headers: HeaderList): Received {
  const [received] = service(headers);
  assert.ok(received);
  return received;
}

const TRACE_ID = '12345678901234567890123456789012';
const PARENT = '00-12345678901234567890123456789012-1234567890123456-00';

/** The trace id is continued when `traceparent` is accepted, and new when it is not. */
function assertContinued(value: string): void {
  assert.equal(single([['traceparent', value]]).traceId, TRACE_ID, JSON.stringify(value));
}

function assertRestarted(value: string, rejected = TRACE_ID): void {
  assert.notEqual(single([['traceparent', value]]).traceId, rejected, JSON.stringify(value));
}

describe('W3C trace context: traceparent', () => {
  it('both traceparent and tracestate missing: a valid traceparent is sent', () => {
    const received = single([]);
    assert.match(received.traceId, /^[0-9a-f]{32}$/);
  });

  it('traceparent included, tracestate missing: same trace id, a new parent id', () => {
    const received = single([['traceparent', `00-${TRACE_ID}-1234567890123456-01`]]);
    assert.equal(received.traceId, TRACE_ID);
    assert.notEqual(received.parentId, '1234567890123456');
  });

  it('traceparent duplicated: a new trace id', () => {
    const received = single([
      ['traceparent', '00-12345678901234567890123456789011-1234567890123456-01'],
      ['traceparent', `00-${TRACE_ID}-1234567890123456-01`],
    ]);
    assert.notEqual(received.traceId, '12345678901234567890123456789011');
    assert.notEqual(received.traceId, TRACE_ID);
  });

  it('traceparent under a wrong header name: a new trace id', () => {
    for (const name of ['trace-parent', 'trace.parent']) {
      assert.notEqual(
        single([[name, `00-${TRACE_ID}-1234567890123456-01`]]).traceId,
        TRACE_ID,
        name,
      );
    }
  });

  it('traceparent header name in any casing: continued', () => {
    for (const name of ['TraceParent', 'TrAcEpArEnT', 'TRACEPARENT']) {
      assert.equal(single([[name, `00-${TRACE_ID}-1234567890123456-01`]]).traceId, TRACE_ID);
    }
  });

  it('version 0x00 with trailing characters: a new trace id', () => {
    assertRestarted(`00-${TRACE_ID}-1234567890123456-01.`);
    assertRestarted(`00-${TRACE_ID}-1234567890123456-01-what-the-future-will-be-like`);
  });

  it('future version 0xcc: continued, unless its fields are not followed by a dash', () => {
    assertContinued(`cc-${TRACE_ID}-1234567890123456-01`);
    assertContinued(`cc-${TRACE_ID}-1234567890123456-01-what-the-future-will-be-like`);
    assertRestarted(`cc-${TRACE_ID}-1234567890123456-01.what-the-future-will-be-like`);
  });

  it('version 0xff: a new trace id', () => {
    assertRestarted(`ff-${TRACE_ID}-1234567890123456-01`);
  });

  it('version with illegal characters, too long, or too short: a new trace id', () => {
    assertRestarted(`.0-${TRACE_ID}-1234567890123456-01`);
    assertRestarted(`0.-${TRACE_ID}-1234567890123456-01`);
    assertRestarted(`000-${TRACE_ID}-1234567890123456-01`);
    assertRestarted(`0000-${TRACE_ID}-1234567890123456-01`);
    assertRestarted(`0-${TRACE_ID}-1234567890123456-01`);
  });

  it('trace id all zero, with illegal characters, too long, or too short: a new trace id', () => {
    assertRestarted('00-00000000000000000000000000000000-1234567890123456-01', '0'.repeat(32));
    assertRestarted(
      '00-.2345678901234567890123456789012-1234567890123456-01',
      '.2345678901234567890123456789012',
    );
    assertRestarted(
      '00-1234567890123456789012345678901.-1234567890123456-01',
      '1234567890123456789012345678901.',
    );
    const tooLong = single([
      ['traceparent', '00-123456789012345678901234567890123-1234567890123456-01'],
    ]).traceId;
    assert.notEqual(tooLong, TRACE_ID);
    assert.notEqual(tooLong, '23456789012345678901234567890123');
    assertRestarted(
      '00-1234567890123456789012345678901-1234567890123456-01',
      '1234567890123456789012345678901',
    );
  });

  it('upper-case hex anywhere: a new trace id', () => {
    const upper = 'ABCDEF78901234567890123456789012';
    assert.equal(parseTraceparent(`00-${upper}-1234567890123456-01`), undefined);
    assert.equal(parseTraceparent(`00-${TRACE_ID}-123456789012345A-01`), undefined);
    assert.equal(parseTraceparent(`00-${TRACE_ID}-1234567890123456-0A`), undefined);
    assertRestarted(`00-${TRACE_ID}-123456789012345A-01`);
  });

  it('parent id all zero, with illegal characters, too long, or too short: a new trace id', () => {
    assertRestarted(`00-${TRACE_ID}-0000000000000000-01`);
    assertRestarted(`00-${TRACE_ID}-.234567890123456-01`);
    assertRestarted(`00-${TRACE_ID}-123456789012345.-01`);
    assertRestarted(`00-${TRACE_ID}-12345678901234567-01`);
    assertRestarted(`00-${TRACE_ID}-123456789012345-01`);
  });

  it('trace flags with illegal characters, too long, or too short: a new trace id', () => {
    assertRestarted(`00-${TRACE_ID}-1234567890123456-.0`);
    assertRestarted(`00-${TRACE_ID}-1234567890123456-0.`);
    assertRestarted(`00-${TRACE_ID}-1234567890123456-001`);
    assertRestarted(`00-${TRACE_ID}-1234567890123456-1`);
  });

  it('traceparent with leading and trailing optional whitespace: continued', () => {
    const value = `00-${TRACE_ID}-1234567890123456-01`;
    for (const padded of [` ${value}`, `\t${value}`, `${value} `, `${value}\t`, `\t ${value} \t`]) {
      assertContinued(padded);
      // The parser trims it too, for a value read from somewhere other than Headers.
      assert.equal(parseTraceparent(padded)?.traceId, TRACE_ID);
    }
  });
});

describe('W3C trace context: tracestate', () => {
  it('tracestate without traceparent is discarded', () => {
    const one = single([['tracestate', 'foo=1']]);
    const two = single([['tracestate', 'foo=1,bar=2']]);
    assert.equal(one.tracestate.size, two.tracestate.size);
    assert.equal(one.tracestate.size, 0);
  });

  it('tracestate with traceparent is inherited', () => {
    const received = single([
      ['traceparent', PARENT],
      ['tracestate', 'foo=1,bar=2'],
    ]);
    assert.equal(received.traceId, TRACE_ID);
    assert.equal(received.tracestate.get('foo'), '1');
    assert.equal(received.tracestate.get('bar'), '2');
  });

  it('tracestate under a wrong header name is discarded', () => {
    for (const name of ['trace-state', 'trace.state']) {
      const received = single([
        ['traceparent', PARENT],
        [name, 'foo=1'],
      ]);
      assert.equal(received.tracestate.has('foo'), false, name);
    }
  });

  it('tracestate header name in any casing is inherited', () => {
    for (const name of ['TraceState', 'TrAcEsTaTe', 'TRACESTATE']) {
      const received = single([
        ['traceparent', PARENT],
        [name, 'foo=1'],
      ]);
      assert.equal(received.tracestate.get('foo'), '1', name);
    }
  });

  it('an empty tracestate header is discarded and does not affect another one', () => {
    const empty = single([
      ['traceparent', PARENT],
      ['tracestate', ''],
    ]);
    assert.equal(empty.traceId, TRACE_ID);
    assert.equal(empty.tracestate.size, 0);
    for (const order of [
      ['foo=1', ''],
      ['', 'foo=1'],
    ]) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', order[0]!],
        ['tracestate', order[1]!],
      ]);
      assert.equal(received.traceId, TRACE_ID);
      assert.equal(received.tracestate.get('foo'), '1');
    }
  });

  it('multiple tracestate headers combine in order', () => {
    const received = single([
      ['traceparent', PARENT],
      ['tracestate', 'foo=1,bar=2'],
      ['tracestate', 'rojo=1,congo=2'],
      ['tracestate', 'baz=3'],
    ]);
    assert.equal(received.traceId, TRACE_ID);
    assert.equal(received.tracestateText, 'foo=1,bar=2,rojo=1,congo=2,baz=3');
  });

  it('duplicated keys are inherited as one of them', () => {
    for (const headers of [
      ['foo=1,foo=1'],
      ['foo=1,foo=2'],
      ['foo=1', 'foo=1'],
      ['foo=1', 'foo=2'],
    ]) {
      const received = single([
        ['traceparent', PARENT],
        ...headers.map((value) => ['tracestate', value] as const),
      ]);
      assert.equal(received.traceId, TRACE_ID);
      assert.match(received.tracestateText, /foo=[12]/);
    }
  });

  it('all allowed characters are inherited', () => {
    const lcalpha = String.fromCharCode(...Array.from({ length: 26 }, (_, i) => 0x61 + i));
    const keyWithoutVendor = `${lcalpha}0123456789_-*/`;
    const keyWithVendor = `${keyWithoutVendor}@a-z0-9_-*/`;
    const range = (from: number, to: number): string =>
      String.fromCharCode(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
    const value = range(0x20, 0x2b) + range(0x2d, 0x3c) + range(0x3e, 0x7e);
    for (const key of [keyWithoutVendor, keyWithVendor]) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', `${key}=${value}`],
      ]);
      assert.equal(received.tracestate.get(key), value);
    }
  });

  it('optional whitespace around members is ignored', () => {
    for (const value of ['foo=1 \t , \t bar=2, \t baz=3', 'foo=1\t \t,\t \tbar=2,\t \tbaz=3']) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', value],
      ]);
      assert.deepEqual(
        [...received.tracestate],
        [
          ['foo', '1'],
          ['bar', '2'],
          ['baz', '3'],
        ],
      );
    }
    for (const value of [' foo=1', '\tfoo=1', 'foo=1 ', 'foo=1\t', '\t foo=1 \t']) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', value],
      ]);
      assert.equal(received.traceId, TRACE_ID);
      assert.equal(received.tracestate.get('foo'), '1', JSON.stringify(value));
    }
  });

  it('a key with illegal characters discards the tracestate', () => {
    for (const [value, key] of [
      ['foo =1', 'foo '],
      ['FOO=1', 'FOO'],
      ['foo.bar=1', 'foo.bar'],
    ] as const) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', value],
      ]);
      assert.equal(received.tracestate.has(key), false, value);
      assert.equal(received.tracestate.size, 0, value);
    }
  });

  it('keys with at signs follow the key grammar; a leading at sign discards the tracestate', () => {
    for (const key of ['foo@', 'foo@@bar', 'foo@bar@baz']) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', `${key}=1,bar=2`],
      ]);
      assert.equal(received.tracestate.get(key), '1');
      assert.equal(received.tracestate.get('bar'), '2');
    }
    const leading = single([
      ['traceparent', PARENT],
      ['tracestate', '@foo=1,bar=2'],
    ]);
    assert.equal(leading.tracestate.has('bar'), false);
  });

  it('32 members are inherited; 33 discard the tracestate', () => {
    const members = (from: number, to: number): string =>
      Array.from({ length: to - from + 1 }, (_, i) => {
        const n = String(from + i).padStart(2, '0');
        return `bar${n}=${n}`;
      }).join(',');
    const headers = (last: string): HeaderList => [
      ['traceparent', PARENT],
      ['tracestate', members(1, 10)],
      ['tracestate', members(11, 20)],
      ['tracestate', members(21, 30)],
      ['tracestate', last],
    ];
    const full = single(headers(members(31, 32)));
    assert.equal(full.tracestate.get('bar01'), '01');
    assert.equal(full.tracestate.size, 32);
    const over = single(headers(members(31, 33)));
    assert.equal(over.tracestate.has('bar01'), false);
  });

  it('keys up to 256 characters are inherited, longer ones discard the tracestate', () => {
    for (const key of [
      'z'.repeat(256),
      `${'t'.repeat(241)}@${'v'.repeat(14)}`,
      `${'t'.repeat(242)}@v`,
      `t@${'v'.repeat(15)}`,
    ]) {
      const received = single([
        ['traceparent', PARENT],
        ['tracestate', 'foo=1'],
        ['tracestate', `${key}=1`],
      ]);
      assert.equal(received.tracestate.get('foo'), '1');
      assert.equal(received.tracestate.get(key), '1');
    }
    const tooLong = single([
      ['traceparent', PARENT],
      ['tracestate', 'foo=1'],
      ['tracestate', `${'z'.repeat(257)}=1`],
    ]);
    assert.equal(tooLong.tracestate.has('foo'), false);
  });

  it('a value with illegal characters discards the tracestate', () => {
    const equals = single([
      ['traceparent', PARENT],
      ['tracestate', 'foo=bar=baz'],
    ]);
    assert.equal(equals.tracestate.has('foo'), false);
    const empty = single([
      ['traceparent', PARENT],
      ['tracestate', 'foo=,bar=3'],
    ]);
    assert.equal(empty.tracestate.has('foo'), false);
    assert.equal(empty.tracestate.has('bar'), false);
  });

  it('a value longer than 256 characters discards the tracestate', () => {
    assert.equal(parseTracestate(`foo=${'v'.repeat(256)}`)?.length, 1);
    assert.equal(parseTracestate(`foo=${'v'.repeat(257)}`), undefined);
  });
});

describe('W3C trace context: advanced', () => {
  it('a valid traceparent is inherited by every outbound call, each with its own parent id', () => {
    const calls = service([['traceparent', `00-${TRACE_ID}-1234567890123456-01`]], 3);
    assert.deepEqual(new Set(calls.map((call) => call.traceId)), new Set([TRACE_ID]));
    assert.equal(new Set(calls.map((call) => call.parentId)).size, 3);
  });

  it('without traceparent, every outbound call has its own parent id', () => {
    const calls = service([], 3);
    assert.equal(new Set(calls.map((call) => call.parentId)).size, 3);
  });

  it('an illegal traceparent yields a new trace id and distinct parent ids', () => {
    const calls = service([['traceparent', `00-${'0'.repeat(32)}-1234567890123456-01`]], 3);
    assert.equal(
      calls.some((call) => call.traceId === '0'.repeat(32)),
      false,
    );
    assert.equal(new Set(calls.map((call) => call.parentId)).size, 3);
  });

  it('level 2: the random flag is propagated', () => {
    const received = single([['traceparent', `00-${TRACE_ID}-1234567890123456-02`]]);
    assert.equal(received.traceId, TRACE_ID);
    assert.notEqual(received.parentId, '1234567890123456');
    assert.equal(received.flags & TRACE_FLAG_RANDOM, TRACE_FLAG_RANDOM);
  });
});

describe('trace context values', () => {
  it('parses a valid traceparent into its fields, keeping future versions apart', () => {
    assert.deepEqual(parseTraceparent(`00-${TRACE_ID}-1234567890123456-01`), {
      version: 0,
      traceId: TRACE_ID,
      parentId: '1234567890123456',
      flags: 1,
    });
    assert.equal(parseTraceparent(`cc-${TRACE_ID}-1234567890123456-01-extra`)?.version, 0xcc);
    assert.equal(parseTraceparent(undefined), undefined);
    assert.equal(parseTraceparent(null), undefined);
  });

  it('formats only the flags it understands, as version 00', () => {
    const trace = { ...createRootTrace(), flags: 0xff };
    assert.match(formatTraceparent(trace), /^00-[0-9a-f]{32}-[0-9a-f]{16}-03$/);
  });

  it('starts root traces with fresh non-zero ids and no parent', () => {
    const a = createRootTrace();
    const b = createRootTrace();
    assert.notEqual(a.traceId, b.traceId);
    assert.equal(a.parentSpanId, undefined);
    assert.equal(isTraceSampled(a), false);
    assert.equal(formatTracestate(a.traceState), undefined);
    assert.ok(Object.isFrozen(a));
  });

  it('continues a span as a child in the same trace', () => {
    const parent = createRootTrace();
    const child = childTrace(parent);
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.parentSpanId, parent.spanId);
    assert.notEqual(child.spanId, parent.spanId);
  });

  it('keeps the sampled flag of a continued trace', () => {
    const sampled = traceFromHeaders(
      new Headers({ traceparent: `00-${TRACE_ID}-1234567890123456-01` }),
    );
    assert.equal(isTraceSampled(sampled), true);
    assert.equal(sampled.parentSpanId, '1234567890123456');
  });
});
