/**
 * Tests for the rich-text URL predicates against the URL table, and for the
 * schema applying them to every link-bearing field.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isEmbedUrl, isLinkHref, parseRichText } from '../../src/rich-text/index.js';
import { URL_CASES } from './url-cases.js';

function label(value: string): string {
  return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}...` : value);
}

describe('isLinkHref', () => {
  for (const { value, link } of URL_CASES) {
    it(`${link ? 'accepts' : 'refuses'} ${label(value)}`, () => {
      assert.equal(isLinkHref(value), link);
    });
  }

  it('refuses a non-string at runtime', () => {
    assert.equal(isLinkHref(42 as unknown as string), false);
  });
});

describe('isEmbedUrl', () => {
  for (const { value, embed } of URL_CASES) {
    it(`${embed ? 'accepts' : 'refuses'} ${label(value)}`, () => {
      assert.equal(isEmbedUrl(value), embed);
    });
  }
});

describe('the schema applies the predicates', () => {
  const document = (block: Record<string, unknown>): unknown => ({ version: 2, blocks: [block] });

  for (const { value, link, embed } of URL_CASES) {
    it(`judges ${label(value)} as a run link, a CTA href and an embed URL`, () => {
      const run = parseRichText(
        document({ type: 'paragraph', content: [{ text: 'x', href: value }] }),
      );
      const cta = parseRichText(document({ type: 'cta', label: 'Go', href: value }));
      const frame = parseRichText(document({ type: 'embed', url: value }));
      assert.equal(run.ok, link);
      assert.equal(cta.ok, link);
      assert.equal(frame.ok, embed);
      if (!run.ok && !link) {
        assert.ok(run.issues.some((issue) => issue.code === 'invalid_link'));
      }
      if (!frame.ok && !embed) {
        assert.ok(frame.issues.some((issue) => issue.code === 'invalid_embed'));
      }
    });
  }
});
