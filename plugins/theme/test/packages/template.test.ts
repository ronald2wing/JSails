import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_TEMPLATE_DEPTH,
  ThemeTemplateError,
  parseThemeTemplate,
  renderThemeTemplate,
} from '../../src/index.js';

const validTemplate = {
  version: 1 as const,
  name: 'post',
  contentType: 'article',
  root: {
    type: 'element' as const,
    tag: 'article' as const,
    attributes: { class: 'post prose', id: 'post-1' },
    children: [
      {
        type: 'element' as const,
        tag: 'h1' as const,
        children: [{ type: 'slot' as const, name: 'title' }],
      },
      {
        type: 'element' as const,
        tag: 'div' as const,
        children: [{ type: 'slot' as const, name: 'body' }],
      },
      {
        type: 'element' as const,
        tag: 'p' as const,
        children: [{ type: 'text' as const, value: 'Fish & chips < 2' }],
      },
    ],
  },
};

describe('theme templates', () => {
  it('parses and renders slots, escaped text, and allowlisted attributes', () => {
    const template = parseThemeTemplate(validTemplate);
    const html = renderThemeTemplate(template, {
      title: 'A <safe> title',
      body: '<p>Already-sanitized body</p>',
    });

    assert.match(html, /^<article class="post prose" id="post-1">/);
    assert.match(html, /<h1>A <safe> title<\/h1>/);
    assert.match(html, /<div><p>Already-sanitized body<\/p><\/div>/);
    assert.match(html, /Fish &amp; chips &lt; 2/);
  });

  it('is frozen and returns a canonical version', () => {
    const template = parseThemeTemplate(validTemplate);
    assert.equal(template.version, 1);
    assert.equal(Object.isFrozen(template), true);
    assert.equal(Object.isFrozen(template.root), true);
  });

  it('rejects script tags, event attributes, styles, and unsafe URLs', () => {
    const unsafe = [
      { ...validTemplate, root: { type: 'element', tag: 'script', children: [] } },
      {
        ...validTemplate,
        root: {
          type: 'element',
          tag: 'a',
          attributes: { onclick: 'alert(1)' },
          children: [],
        },
      },
      {
        ...validTemplate,
        root: {
          type: 'element',
          tag: 'div',
          attributes: { style: 'background:url(x)' },
          children: [],
        },
      },
      {
        ...validTemplate,
        root: {
          type: 'element',
          tag: 'a',
          attributes: { href: 'javascript:alert(1)' },
          children: [],
        },
      },
      {
        ...validTemplate,
        root: {
          type: 'element',
          tag: 'img',
          attributes: { src: 'data:image/svg+xml,<svg/>' },
          children: [],
        },
      },
    ];
    for (const raw of unsafe) {
      assert.throws(
        () => parseThemeTemplate(raw),
        (error: unknown) => error instanceof ThemeTemplateError,
      );
    }
  });

  it('rejects void tags with children and malformed shapes', () => {
    assert.throws(
      () =>
        parseThemeTemplate({
          ...validTemplate,
          root: { type: 'element', tag: 'hr', children: [{ type: 'text', value: 'x' }] },
        }),
      ThemeTemplateError,
    );
    assert.throws(() => parseThemeTemplate({ version: 2 }), ThemeTemplateError);
    assert.throws(
      () => parseThemeTemplate({ ...validTemplate, root: { type: 'slot', name: 'Bad Slot' } }),
      ThemeTemplateError,
    );
  });

  it('rejects excessively deep trees', () => {
    let node: Record<string, unknown> = { type: 'text', value: 'x' };
    for (let i = 0; i <= MAX_TEMPLATE_DEPTH; i += 1) {
      node = { type: 'element', tag: 'div', children: [node] };
    }
    assert.throws(() => parseThemeTemplate({ ...validTemplate, root: node }), ThemeTemplateError);
  });
});
