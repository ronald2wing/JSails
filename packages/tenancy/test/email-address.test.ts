/**
 * Tests for email normalisation: the normalisation table (NFC, trim, case,
 * IDNA domains, tags kept, RFC 6531 local parts with combining marks) and the
 * refusal table (invisible and non-text characters included), plus
 * idempotence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeEmail } from '../src/email-address.js';

describe('normalizeEmail', () => {
  const accepted: readonly (readonly [string, string, string])[] = [
    ['Ada@Example.com', 'ada@example.com', 'case folds'],
    ['  ada@example.com\n', 'ada@example.com', 'whitespace trimmed'],
    ['ada.lovelace+tenancy@example.com', 'ada.lovelace+tenancy@example.com', 'dots and tags kept'],
    ['ada@bücher.de', 'ada@xn--bcher-kva.de', 'IDN domain to A-label'],
    ['ada@xn--bcher-kva.de', 'ada@xn--bcher-kva.de', 'A-label domain kept'],
    [
      `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.exampl`,
      `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.exampl`,
      'exactly 254 octets',
    ],
    ['ada@example.com.', 'ada@example.com', 'trailing dot on the domain'],
    [`Jose${String.fromCodePoint(0x301)}@example.com`, 'jos\u00e9@example.com', 'NFC composition'],
    ['ÜSER@example.com', 'üser@example.com', 'Unicode local part (RFC 6531)'],
    ["o'brien@example.com", "o'brien@example.com", 'apostrophe is atext'],
    ['हिन्दी@example.com', 'हिन्दी@example.com', 'Devanagari with combining marks'],
    ['राम@example.com', 'राम@example.com', 'Devanagari vowel sign'],
    ['สวัสดี@example.com', 'สวัสดี@example.com', 'Thai with combining marks'],
    ['كَتَبَ@example.com', 'كَتَبَ@example.com', 'Arabic harakat'],
    [
      'İsmail@example.com',
      'i\u0307smail@example.com',
      'capital dotted I lower-cases to i and U+0307',
    ],
    ['用户@例子.广告', '用户@xn--fsqu00a.xn--4rr70v', 'RFC 6531 local part, IDN domain'],
  ];
  for (const [input, expected, why] of accepted) {
    it(`accepts: ${why}`, () => {
      assert.equal(normalizeEmail(input), expected);
      assert.equal(normalizeEmail(expected), expected);
    });
  }

  const refused: readonly (readonly [unknown, string])[] = [
    ['', 'empty'],
    ['ada', 'no at sign'],
    ['@example.com', 'empty local part'],
    ['ada@', 'empty domain'],
    ['ada@@example.com', 'two at signs'],
    ['a@b@example.com', 'at sign in the local part'],
    ['"ada"@example.com', 'quoted local part'],
    ['ada lovelace@example.com', 'space in the local part'],
    ['.ada@example.com', 'leading dot'],
    ['ada.@example.com', 'trailing dot'],
    ['ada..l@example.com', 'consecutive dots'],
    ['ada(comment)@example.com', 'comment'],
    ['ada@localhost', 'single-label domain'],
    ['ada@[127.0.0.1]', 'IP literal domain'],
    ['ada@127.0.0.1', 'IPv4 domain'],
    ['ada@example.com:25', 'port'],
    ['ada@exa_mple.com', 'invalid domain'],
    ['ada\r\n@example.com', 'line break'],
    ['ada\u200b@example.com', 'zero-width space (format character)'],
    ['ada\u202eevil@example.com', 'bidi override (format character)'],
    ['ada\u00a0l@example.com', 'no-break space (separator)'],
    ['ada\u3000l@example.com', 'ideographic space (separator)'],
    ['ada\ue000@example.com', 'private-use character'],
    ['ada\u0085l@example.com', 'C1 control'],
    [`${'a'.repeat(65)}@example.com`, 'local part over 64 octets'],
    [`${'é'.repeat(33)}@example.com`, 'local part over 64 octets in UTF-8'],
    [
      `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`,
      '255 octets',
    ],
    [42, 'not a string'],
  ];
  for (const [input, why] of refused) {
    it(`refuses: ${why}`, () => {
      assert.equal(normalizeEmail(input as string), null);
    });
  }
});
