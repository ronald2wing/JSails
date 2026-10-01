/**
 * `RichTextField`'s server markup: the island marker and props (never the
 * document), the source input carrying a readable document under the field
 * name, and an unreadable value carried without a name beside the issues
 * panel, with at most twenty issues listed and value-free text; the island
 * element holds the source input and one wrapper, which the island keeps.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToString } from 'jsails/render-to-string';
import type { RichTextDocument } from 'jsails/rich-text';

import { RichTextField } from '../../src/server/index.js';

const DOCUMENT: RichTextDocument = {
  version: 2,
  blocks: [{ type: 'paragraph', content: [{ text: '<script>alert(1)</script>' }] }],
};

describe('RichTextField', () => {
  it('renders the island marker, its props and the named source input', () => {
    const html = renderToString(
      <RichTextField
        name="body"
        value={DOCUMENT}
        label="Body"
        id="field-body"
        mediaPickerUrl="/admin/media?format=json"
      />,
    );
    assert.match(html, /^<div data-jsails-island="rich-text" data-jsails-props="/);
    const props = /data-jsails-props="([^"]*)"/.exec(html)?.[1]?.replaceAll('&quot;', '"');
    assert.deepEqual(JSON.parse(props ?? ''), {
      name: 'body',
      label: 'Body',
      id: 'field-body',
      mediaPickerUrl: '/admin/media?format=json',
    });
    assert.match(
      html,
      /<input type="hidden" data-rich-text-source(="")? name="body" value="\{&quot;version&quot;:2/,
    );
    assert.doesNotMatch(html, /<script>/);
    // Two children, the source input and the wrapper the island keeps.
    assert.match(
      html,
      /\/><div class="rich-text-editor" data-state="loading"><p class="rich-text-editor-fallback">[^<]*needs JavaScript[^<]*<\/p><\/div><\/div>$/,
    );
  });

  it('carries an unreadable value without a name, beside the issues', () => {
    const html = renderToString(
      <RichTextField
        name="body"
        value={{ version: 2, blocks: [{ type: 'cta', label: 'x', href: 'javascript:secret()' }] }}
      />,
    );
    assert.match(html, /<input type="hidden" data-rich-text-source(="")? value="/);
    assert.doesNotMatch(html, /name="body"/);
    assert.match(html, /\/><div class="rich-text-editor" data-state="unreadable"><div /);
    assert.match(html, /cannot be edited here/);
    assert.match(html, /blocks\.0\.href: link is not a path/);
    assert.match(html, /keeps the stored content unchanged/);
  });

  it('lists twenty issues and counts the rest', () => {
    const blocks = Array.from({ length: 25 }, () => ({
      type: 'cta',
      label: 'x',
      href: 'javascript:x()',
    }));
    const html = renderToString(<RichTextField name="body" value={{ version: 2, blocks }} />);
    assert.equal(html.match(/<li>/g)?.length, 20);
    assert.match(html, /And 5 more\./);
  });

  it('renders an unserialisable value as an empty source', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const html = renderToString(<RichTextField name="body" value={cyclic} />);
    assert.match(html, /data-rich-text-source(="")? value(="")?\/>/);
  });
});
