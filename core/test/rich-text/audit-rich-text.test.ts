/**
 * Audit regressions for the persisted rich-text model (CNT-01): each test
 * states the correct behaviour for one audited defect.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRichText } from '../../src/rich-text/index.js';
import { auditCase } from '../../src/testing/index.js';

/** URLs a stored document must never carry into a rendered `href` or frame. */
const SCRIPTABLE_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
];

function documentWith(block: Record<string, unknown>): unknown {
  return { version: 2, blocks: [block] };
}

/**
 * Assert that `block(safe)` validates for every safe value and that
 * `block(scriptable)` is refused on `field` for every scriptable one. The safe
 * half keeps the test honest when the block's shape changes: a document
 * rejected for an unrelated schema reason fails here instead of passing.
 */
function assertUrlField(
  field: string,
  block: (value: string) => Record<string, unknown>,
  safe: readonly string[],
  describe: (value: string) => string,
): void {
  for (const value of safe) {
    const result = parseRichText(documentWith(block(value)));
    assert.ok(result.ok, `the safe ${field} ${value} was refused`);
  }
  for (const value of SCRIPTABLE_URLS) {
    const result = parseRichText(documentWith(block(value)));
    if (result.ok) {
      assert.fail(describe(value));
    }
    assert.ok(
      result.issues.some((issue) => issue.path.at(-1) === field),
      `${describe(value).replace('was accepted', 'was refused')}, but not on its ${field}`,
    );
  }
}

test(
  ...auditCase('rich-text/cta-href-scheme', 'a CTA href is a path or an http(s)/mailto URL'),
  () => {
    assertUrlField(
      'href',
      (href) => ({ type: 'cta', label: 'Go', href }),
      ['/pricing', 'https://example.com/signup', 'mailto:sales@example.com'],
      (href) => `a CTA href of ${href.slice(0, 11)}... was accepted`,
    );
  },
);

test(...auditCase('rich-text/embed-url-scheme', 'an embed URL is an https URL'), () => {
  assertUrlField(
    'url',
    (url) => ({ type: 'embed', url }),
    ['https://www.youtube.com/embed/x'],
    (url) => `an embed URL of ${url.slice(0, 11)}... was accepted`,
  );
});
