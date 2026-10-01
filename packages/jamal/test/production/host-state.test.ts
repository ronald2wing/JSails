/**
 * Tests for `state.json` v1: its byte form and the strict parse that keeps a
 * damaged or foreign document from being trusted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  encodeHostState,
  HostStateErrors,
  parseHostState,
  type HostState,
} from '../../src/production/host-state.js';
import { release } from './host-observation.js';

const STATE: HostState = {
  v: 1,
  seq: 7,
  live: release(2),
  previous: release(1),
  updatedAt: '2026-11-23T10:16:02.000Z',
  by: 'ana@laptop',
};

/** Whether `run` throws the value-free invalid error. */
function refuses(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(HostStateErrors.is(error, 'invalid'));
    assert.equal(error.message, 'state.json is not a v1 host state document');
    return true;
  });
}

describe('encodeHostState', () => {
  it('writes the keys in one order with a trailing newline, so equal states are equal bytes', () => {
    const shuffled = {
      by: STATE.by,
      updatedAt: STATE.updatedAt,
      previous: STATE.previous,
      live: STATE.live,
      seq: STATE.seq,
      v: STATE.v,
    } as const;
    const bytes = Buffer.from(encodeHostState(STATE)).toString('utf8');
    assert.equal(Buffer.from(encodeHostState(shuffled)).toString('utf8'), bytes);
    assert.equal(
      bytes,
      `{"v":1,"seq":7,"live":"${release(2)}","previous":"${release(1)}","updatedAt":"2026-11-23T10:16:02.000Z","by":"ana@laptop"}\n`,
    );
  });

  it('round-trips through parseHostState, a host before its first release included', () => {
    assert.deepEqual(parseHostState(encodeHostState(STATE)), STATE);
    const empty: HostState = { ...STATE, live: null, previous: null };
    assert.deepEqual(parseHostState(encodeHostState(empty)), empty);
  });

  it('refuses to write a state that is not v1', () => {
    refuses(() => encodeHostState({ ...STATE, previous: STATE.live }));
  });
});

describe('parseHostState', () => {
  const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

  it('refuses anything but exactly a v1 document, value-free', () => {
    for (const candidate of [
      { ...STATE, v: 2 },
      { ...STATE, seq: -1 },
      { ...STATE, seq: 1.5 },
      { ...STATE, live: 'latest' },
      { ...STATE, previous: 'myapp-web-abc' },
      { ...STATE, previous: STATE.live },
      { ...STATE, by: '' },
      { ...STATE, by: 'ana\n@laptop' },
      { ...STATE, updatedAt: 'x'.repeat(257) },
      { ...STATE, status: 'live' },
      { v: 1, seq: 1, live: null, previous: null, updatedAt: 't' },
      [STATE],
      null,
    ]) {
      refuses(() => parseHostState(bytes(candidate)));
    }
    refuses(() => parseHostState(Buffer.from('{"v":1,')));
    refuses(() => parseHostState(Buffer.alloc(0)));
  });

  it('accepts a previous release with no live one: a host whose proxy serves nothing', () => {
    const state: HostState = { ...STATE, live: null };
    assert.deepEqual(parseHostState(bytes(state)), state);
  });
});
