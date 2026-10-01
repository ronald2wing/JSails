/**
 * Tests for the client-audience constructors: their codes and kinds, argument
 * validation, and the property that no constructor input ever reaches a
 * message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  conflict,
  forbidden,
  invalid,
  notFound,
  rateLimited,
  RequestErrors,
  tooLarge,
  unauthenticated,
} from '../../src/errors/kernel.js';
import { isJsailsError } from '../../src/errors/jsails-error.js';

/** A small seeded generator, so a failing property run is reproducible. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function word(next: () => number, alphabet: string, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(next() * alphabet.length)] ?? 'a';
  }
  return out;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ANY = `${LOWER}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-./:{}'"<>`;

describe('client-audience constructors', () => {
  it('raise request.* codes with their kinds, all client audience', () => {
    const cases = [
      [notFound(), 'request.not_found', 'not_found'],
      [forbidden(), 'request.forbidden', 'forbidden'],
      [unauthenticated(), 'request.unauthenticated', 'unauthenticated'],
      [conflict('email_taken'), 'request.conflict', 'conflict'],
      [invalid([{ path: ['email'], code: 'invalid_format' }]), 'request.invalid', 'invalid'],
      [tooLarge(), 'request.too_large', 'too_large'],
      [rateLimited(1500), 'request.rate_limited', 'rate_limited'],
    ] as const;
    for (const [error, code, kind] of cases) {
      assert.equal(error.code, code);
      assert.equal(error.kind, kind);
      assert.equal(error.audience, 'client');
      assert.ok(RequestErrors.is(error));
    }
  });

  it('expose the conflict reason and the issues, not the rate-limit delay', () => {
    assert.deepEqual(conflict('email_taken').clientFields, { reason: 'email_taken' });
    const issues = [{ path: ['items', 0, 'qty'], code: 'too_small', message: 'at least 1' }];
    assert.deepEqual(invalid(issues).clientFields, { issues });
    assert.deepEqual(rateLimited(1500).clientFields, {});
    assert.deepEqual(rateLimited(1500).payload, { retryAfterMs: 1500 });
  });

  it('refuse malformed arguments without echoing them', () => {
    const bad: (() => unknown)[] = [
      () => conflict('Email Taken'),
      () => conflict(''),
      () => invalid('nope' as never),
      () => invalid([{ path: 'email', code: 'x' }] as never),
      () => invalid([{ path: [], code: 'Not Snake' }]),
      () => invalid([{ path: [{}], code: 'x' }] as never),
      () => rateLimited(-1),
      () => rateLimited(1.5),
      () => rateLimited(Number.NaN),
    ];
    for (const call of bad) {
      assert.throws(call, (error: unknown) => {
        assert.ok(isJsailsError(error));
        assert.equal(error.code, 'errors.invalid_argument');
        assert.ok(!error.message.includes('Email Taken'));
        assert.ok(!error.message.includes('Not Snake'));
        return true;
      });
    }
  });

  it('never put any substring of their input into a message (property)', () => {
    const next = generator(0x5eed);
    for (let round = 0; round < 500; round += 1) {
      const reason = `${word(next, LOWER, 1)}${word(next, LOWER, 5 + Math.floor(next() * 20))}_z`;
      const issueMessage = word(next, ANY, 8 + Math.floor(next() * 30));
      const pathKey = word(next, ANY, 6 + Math.floor(next() * 10));
      const ms = 100_000 + Math.floor(next() * 1_000_000_000);
      const inputs = [reason, issueMessage, pathKey, String(ms)];
      const messages = [
        conflict(reason).message,
        invalid([{ path: [pathKey, round], code: 'custom', message: issueMessage }]).message,
        rateLimited(ms).message,
      ];
      for (const message of messages) {
        for (const input of inputs) {
          assert.ok(!message.includes(input), `round ${round}: message echoes input`);
        }
      }
    }
  });
});
