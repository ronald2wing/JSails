/**
 * The redirect-target rule as a property: no string, however it is built,
 * makes `Respond.redirect`, a page's `reply.redirect` or `safeRedirectPath`
 * answer with a `Location` that leaves the origin it is resolved against.
 *
 * Inputs are drawn from a deterministic generator (mulberry32, so a failure
 * names its seed) over the fragments open redirects are built from: schemes,
 * slashes and backslashes, encoded dots and slashes, `@`, control and
 * whitespace characters, non-ASCII text and lone surrogates. Every accepted
 * target must resolve to the request's origin and be visible ASCII; every
 * refused one must be refused with the value-free `redirect.invalid_target`.
 * Fixed rows pin the classic bypasses and the encoding.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redirect as respondRedirect, redirectExternal } from '../../src/api/responses.js';
import { reply } from '../../src/pages/reply.js';
import {
  isSameOriginPath,
  RedirectErrors,
  safeRedirectPath,
} from '../../src/url/redirect-target.js';

/** The origin every target is resolved against, from a path below its root. */
const BASE = 'https://app.test/deep/page?x=1';
const ORIGIN = 'https://app.test';

/** The number of generated targets each property checks. */
const SAMPLES = 10_000;

/** mulberry32: a small deterministic PRNG. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS: readonly string[] = [
  '/',
  '//',
  '\\',
  '/\\',
  '.',
  '..',
  '%2e',
  '%2E',
  '%2f',
  '%5c',
  '@',
  ':',
  '?',
  '#',
  '&',
  'http:',
  'https:',
  'javascript:',
  'data:',
  'evil.example',
  'app.test',
  'user:pw@',
  'a',
  'path',
  ' ',
  '\t',
  '\n',
  '\r',
  '\0',
  '\x7f',
  ' ',
  ' ',
  'é',
  '日本',
  '😀',
  '\ud800',
  '\udc00',
  '%',
  '%%',
  '%00',
  '／',
];

/**
 * A target of one to eight fragments, drawn by `next`; half start with `/`,
 * so the generator reaches accepted paths as often as refused strings.
 */
function target(next: () => number): string {
  const length = 1 + Math.floor(next() * 8);
  let value = next() < 0.5 ? '/' : '';
  for (let index = 0; index < length; index += 1) {
    value += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] ?? '';
  }
  return value;
}

/** Whether `location` stays on the origin and is fit for a header. */
function staysHome(location: string): boolean {
  return /^[\x21-\x7e]+$/u.test(location) && new URL(location, BASE).origin === ORIGIN;
}

/** The `Location` `build` answers for `value`, or `undefined` when it refuses it. */
function locationOf(build: (value: string) => string, value: string): string | undefined {
  try {
    return build(value);
  } catch (error) {
    assert.ok(
      RedirectErrors.is(error, 'invalid_target'),
      `unexpected refusal of ${JSON.stringify(value)}`,
    );
    return undefined;
  }
}

const BUILDERS: readonly (readonly [string, (value: string) => string])[] = [
  ['Respond.redirect', (value) => respondRedirect(value).headers.get('location') ?? ''],
  ['reply.redirect', (value) => reply.redirect(value).location],
  ['safeRedirectPath', (value) => safeRedirectPath(value, '/fallback')],
];

describe('a redirect target never leaves the origin', () => {
  for (const [name, build] of BUILDERS) {
    it(`${name}, for ${SAMPLES} generated targets`, () => {
      const next = random(0x5eed);
      let accepted = 0;
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const value = target(next);
        const location = locationOf(build, value);
        if (location === undefined) continue;
        accepted += 1;
        assert.ok(staysHome(location), `${name}(${JSON.stringify(value)}) -> ${location}`);
      }
      // The generator must reach accepted targets too, or the property is vacuous.
      assert.ok(accepted > SAMPLES / 20, `only ${accepted} targets were accepted`);
    });
  }

  it('refuses the classic bypasses', () => {
    for (const value of [
      '',
      'evil.example',
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      ' //evil.example',
      'javascript:alert(1)',
      '/a/../../b',
      '/a/%2e%2e/b',
      '/a/.%2E/b',
      '/\ud800',
    ]) {
      assert.equal(isSameOriginPath(value), false, JSON.stringify(value));
      assert.throws(
        () => respondRedirect(value),
        (error) => RedirectErrors.is(error, 'invalid_target'),
      );
      assert.throws(
        () => reply.redirect(value),
        (error) => RedirectErrors.is(error, 'invalid_target'),
      );
      assert.equal(safeRedirectPath(value, '/home'), '/home');
    }
  });

  it('keeps a same-origin path as it is, percent-encoding what a header cannot carry', () => {
    assert.equal(reply.redirect('/login?next=%2Fa#top').location, '/login?next=%2Fa#top');
    assert.equal(reply.redirect('/café menu').location, '/caf%C3%A9%20menu');
    assert.equal(reply.redirect('/.//evil.example').location, '/.//evil.example');
    assert.ok(staysHome('/.//evil.example'));
    assert.equal(respondRedirect('/a?b=../c').headers.get('location'), '/a?b=../c');
  });

  it('refuses a fallback that is not a same-origin path', () => {
    assert.throws(
      () => safeRedirectPath('/ok', 'https://evil.example'),
      (error) => RedirectErrors.is(error, 'invalid_fallback'),
    );
  });

  it('sends an explicit external target as its serialized URL, never with credentials', () => {
    const response = redirectExternal('HTTPS://Pay.Example/checkout?x=1', { status: 302 });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://pay.example/checkout?x=1');
    assert.equal(
      reply.redirectExternal(new URL('http://pay.example')).location,
      'http://pay.example/',
    );
    for (const value of [
      'https://user:pw@pay.example/',
      'javascript:alert(1)',
      '/relative',
      'ftp://x/',
    ]) {
      assert.throws(
        () => redirectExternal(value),
        (error) => RedirectErrors.is(error, 'invalid_external_target'),
      );
      assert.throws(
        () => reply.redirectExternal(value),
        (error) => RedirectErrors.is(error, 'invalid_external_target'),
      );
    }
  });
});
