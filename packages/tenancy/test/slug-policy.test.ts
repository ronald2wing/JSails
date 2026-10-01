/**
 * Tests for the slug policy: the vector table, policy construction and its
 * refusals, reserved-list extension and replacement, and slug suggestions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkSlug,
  DEFAULT_RESERVED_SLUGS,
  DEFAULT_SLUG_POLICY,
  slugPolicy,
  suggestSlug,
} from '../src/slug-policy.js';
import { SLUG_VECTORS } from './naming-vectors.js';
import { seededPrng } from './seeded-prng.js';
import { thrownCode } from './thrown-code.js';

describe('checkSlug', () => {
  for (const [input, expected, why] of SLUG_VECTORS) {
    it(why, () => {
      assert.deepEqual(checkSlug(input), expected);
    });
  }

  it('refuses non-string input', () => {
    assert.deepEqual(checkSlug(null as unknown as string), { ok: false, code: 'invalid_slug' });
  });

  it('never echoes the input in a refusal', () => {
    const refusal = checkSlug('<script>');
    assert.equal(JSON.stringify(refusal).includes('script'), false);
  });

  it('accepts only DNS-label, URL-safe slugs (seeded property)', () => {
    const random = seededPrng(0x51a6);
    for (let i = 0; i < 5000; i += 1) {
      const check = checkSlug(random.string('aZ09-_.ü ', 1 + random.int(12)));
      if (check.ok) {
        assert.match(check.slug, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, `step ${i}`);
        assert.equal(check.slug.includes('--'), false);
        assert.equal(/^[0-9]+$/.test(check.slug), false);
        assert.equal(encodeURIComponent(check.slug), check.slug);
      }
    }
  });
});

describe('slugPolicy', () => {
  it('defaults to 3..63 with the default reserved list, frozen', () => {
    const policy = slugPolicy();
    assert.equal(policy.minLength, 3);
    assert.equal(policy.maxLength, 63);
    assert.deepEqual(policy.reserved, DEFAULT_RESERVED_SLUGS);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.reserved));
    assert.ok(Object.isFrozen(DEFAULT_RESERVED_SLUGS));
    assert.deepEqual(DEFAULT_SLUG_POLICY, policy);
  });

  it('keeps the default list sorted, lower-case, and itself made of valid labels', () => {
    assert.deepEqual([...DEFAULT_RESERVED_SLUGS].sort(), DEFAULT_RESERVED_SLUGS);
    const shortest = slugPolicy({ minLength: 1 });
    for (const slug of DEFAULT_RESERVED_SLUGS) {
      assert.deepEqual(checkSlug(slug, shortest), { ok: false, code: 'reserved_slug' }, slug);
    }
    for (const required of ['www', 'api', 'app', 'admin', 'auth', 'mail', 'static', 'cdn']) {
      assert.ok(DEFAULT_RESERVED_SLUGS.includes(required), required);
    }
  });

  it('extends the defaults, case-insensitively', () => {
    const policy = slugPolicy({ reserved: ['Pricing'] });
    assert.deepEqual(checkSlug('pricing', policy), { ok: false, code: 'reserved_slug' });
    assert.deepEqual(checkSlug('www', policy), { ok: false, code: 'reserved_slug' });
  });

  it('replaces the defaults when extendDefaults is false', () => {
    const policy = slugPolicy({ reserved: ['pricing'], extendDefaults: false });
    assert.deepEqual(checkSlug('www', policy), { ok: true, slug: 'www' });
    assert.deepEqual(checkSlug('pricing', policy), { ok: false, code: 'reserved_slug' });
  });

  it('applies custom lengths', () => {
    const policy = slugPolicy({ minLength: 1, maxLength: 5 });
    assert.deepEqual(checkSlug('a', policy), { ok: true, slug: 'a' });
    assert.deepEqual(checkSlug('abcdef', policy), { ok: false, code: 'too_long' });
  });

  it('refuses malformed options with invalid_slug_policy', () => {
    for (const options of [
      { minLength: 0 },
      { maxLength: 64 },
      { minLength: 5, maxLength: 4 },
      { minLength: 2.5 },
      { maxLength: Number.NaN },
      { reserved: [''] },
      { reserved: [7 as unknown as string] },
    ]) {
      assert.equal(
        thrownCode(() => slugPolicy(options)),
        'invalid_slug_policy',
        JSON.stringify(options),
      );
    }
  });
});

describe('suggestSlug', () => {
  const cases: readonly (readonly [string, string | null])[] = [
    ['Acme Corp', 'acme-corp'],
    ['  Acme   Corp!!  ', 'acme-corp'],
    ['Crème Brûlée', 'creme-brulee'],
    ['Straße & Söhne', 'strasse-sohne'],
    ['Ærøskøbing Œuvre', 'aeroskobing-oeuvre'],
    ['Łódź', 'lodz'],
    ['ﬁnance', 'finance'],
    ['---', null],
    ['株式会社', null],
    ['42', null],
    ['www', null],
    ['ab', null],
    ['A'.repeat(70), 'a'.repeat(63)],
    [`${'a'.repeat(62)} b`, 'a'.repeat(62)],
  ];
  for (const [name, expected] of cases) {
    it(`suggests ${String(expected)} for ${JSON.stringify(name.slice(0, 20))}`, () => {
      assert.equal(suggestSlug(name), expected);
    });
  }

  it('only ever suggests a slug checkSlug accepts unchanged (seeded property)', () => {
    const random = seededPrng(0x5ee9);
    for (let i = 0; i < 3000; i += 1) {
      const suggestion = suggestSlug(random.string('Aaé ß-_!9Œ株', 1 + random.int(40)));
      if (suggestion !== null) {
        assert.deepEqual(checkSlug(suggestion), { ok: true, slug: suggestion }, `step ${i}`);
      }
    }
  });

  it('respects the policy length and returns null for non-strings', () => {
    assert.equal(suggestSlug('Acme Corporation', slugPolicy({ maxLength: 6 })), 'acme-c');
    assert.equal(suggestSlug(undefined as unknown as string), null);
  });
});
