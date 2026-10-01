/**
 * Tests for the server renderer: the markup of every block kind and of inline
 * runs, the embed host allowlist, media resolution, and programmer errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isEmbedUrl,
  isLinkHref,
  type EmbedUrl,
  type LinkHref,
  type RichTextBlock,
  type RichTextDocument,
} from 'jsails/rich-text';

import {
  RichTextRenderErrors,
  renderRichText,
  type RenderRichTextOptions,
} from '../../src/server/index.js';

function href(value: string): LinkHref {
  assert.ok(isLinkHref(value));
  return value;
}

function embed(value: string): EmbedUrl {
  assert.ok(isEmbedUrl(value));
  return value;
}

function render(blocks: readonly RichTextBlock[], options?: RenderRichTextOptions): string {
  const document: RichTextDocument = { version: 2, blocks };
  return renderRichText(document, options);
}

const PLACEHOLDER = '<span class="jsails-media-placeholder" aria-hidden="true"></span>';

describe('inline runs', () => {
  it('escapes text and turns hard breaks into <br>', () => {
    assert.equal(
      render([{ type: 'paragraph', content: [{ text: '<b>&"\'\nnext' }] }]),
      '<p>&lt;b&gt;&amp;&quot;&#39;<br>next</p>',
    );
  });

  it('nests marks in model order, outermost first', () => {
    assert.equal(
      render([
        {
          type: 'paragraph',
          content: [
            { text: 'a', marks: ['bold', 'italic', 'strike'] },
            { text: 'b', marks: ['code'] },
          ],
        },
      ]),
      '<p><strong><em><s>a</s></em></strong><code>b</code></p>',
    );
  });

  it('wraps adjacent runs with one href in one link, with rel only for web URLs', () => {
    assert.equal(
      render([
        {
          type: 'paragraph',
          content: [
            { text: 'go ', href: href('https://example.com/?a=1&b=2') },
            { text: 'now', marks: ['bold'], href: href('https://example.com/?a=1&b=2') },
            { text: ' or ' },
            { text: 'here', href: href('/local') },
            { text: 'mail', href: href('mailto:a@b.c') },
          ],
        },
      ]),
      '<p><a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">go <strong>now</strong></a> or <a href="/local">here</a><a href="mailto:a@b.c">mail</a></p>',
    );
  });
});

describe('blocks', () => {
  it('renders each text block', () => {
    assert.equal(
      render([
        { type: 'heading', level: 3, content: [{ text: 'T' }] },
        { type: 'quote', content: [{ text: 'Q' }], citation: 'C <c>' },
        { type: 'quote', content: [{ text: 'Q' }] },
        { type: 'callout', tone: 'warning', content: [{ text: 'W' }] },
        { type: 'divider' },
      ]),
      [
        '<h3>T</h3>',
        '<blockquote><p>Q</p><footer><cite>C &lt;c&gt;</cite></footer></blockquote>',
        '<blockquote><p>Q</p></blockquote>',
        '<aside class="jsails-callout jsails-callout--warning">W</aside>',
        '<hr>',
      ].join('\n'),
    );
  });

  it('renders code literally with a language class, or data-language when not a token', () => {
    assert.equal(
      render([
        { type: 'code', code: '<a>\n\tb', language: 'ts' },
        { type: 'code', code: 'x', language: 'my lang"' },
        { type: 'code', code: 'y' },
      ]),
      [
        '<pre><code class="language-ts">&lt;a&gt;\n\tb</code></pre>',
        '<pre><code data-language="my lang&quot;">x</code></pre>',
        '<pre><code>y</code></pre>',
      ].join('\n'),
    );
  });

  it('renders nested lists and task lists', () => {
    assert.equal(
      render([
        {
          type: 'list',
          style: 'ordered',
          items: [{ content: [{ text: 'a' }], children: [{ content: [{ text: 'b' }] }] }],
        },
        {
          type: 'list',
          style: 'task',
          items: [
            { content: [{ text: 'done' }], checked: true },
            { content: [{ text: 'open' }], checked: false },
          ],
        },
      ]),
      [
        '<ol><li>a<ol><li>b</li></ol></li></ol>',
        '<ul class="jsails-task-list"><li><input type="checkbox" disabled checked>done</li><li><input type="checkbox" disabled>open</li></ul>',
      ].join('\n'),
    );
  });

  it('renders a CTA link', () => {
    assert.equal(
      render([{ type: 'cta', label: 'Go & see', href: href('https://example.com') }]),
      '<p class="jsails-cta"><a href="https://example.com" rel="noopener noreferrer">Go &amp; see</a></p>',
    );
  });
});

describe('embeds', () => {
  const block: RichTextBlock = { type: 'embed', url: embed('https://www.youtube.com/embed/x') };

  it('renders nothing but a placeholder without an allowlist', () => {
    assert.equal(render([block]), PLACEHOLDER);
  });

  it('renders a frame for an allowlisted host or domain', () => {
    const frame =
      '<div class="jsails-embed"><iframe src="https://www.youtube.com/embed/x" loading="lazy" allowfullscreen></iframe></div>';
    assert.equal(render([block], { embedHostAllowlist: ['www.youtube.com'] }), frame);
    assert.equal(render([block], { embedHostAllowlist: ['.YouTube.com.'] }), frame);
    assert.equal(render([block], { embedHostAllowlist: ['youtube.com'] }), PLACEHOLDER);
    assert.equal(render([block], { embedHostAllowlist: ['.tube.com', '', '.'] }), PLACEHOLDER);
  });
});

describe('media', () => {
  const resolveMedia = (id: string) =>
    id === 'm1' ? { src: '/media/1.jpg', alt: 'fallback', width: 10, height: 20 } : undefined;

  it('renders an image, its caption, and a placeholder for an unknown id', () => {
    assert.equal(
      render(
        [
          { type: 'image', mediaId: 'm1', alt: 'Own "alt"', caption: 'Cap' },
          { type: 'image', mediaId: 'm1' },
          { type: 'image', mediaId: 'missing' },
        ],
        { resolveMedia },
      ),
      [
        '<figure><img src="/media/1.jpg" alt="Own &quot;alt&quot;" width="10" height="20" loading="lazy"><figcaption>Cap</figcaption></figure>',
        '<img src="/media/1.jpg" alt="fallback" width="10" height="20" loading="lazy">',
        PLACEHOLDER,
      ].join('\n'),
    );
  });

  it('renders a gallery', () => {
    assert.equal(
      render([{ type: 'gallery', mediaIds: ['m1', 'x'], alt: 'G' }], { resolveMedia }),
      `<figure class="jsails-gallery"><img src="/media/1.jpg" alt="G" width="10" height="20" loading="lazy">${PLACEHOLDER}</figure>`,
    );
  });

  it('refuses a resolver src that is not a path or an http(s) URL', () => {
    for (const src of [
      'javascript:alert(1)',
      'data:image/png;base64,x',
      '//cdn.example/x',
      'x.png',
    ]) {
      assert.throws(
        () => render([{ type: 'image', mediaId: 'm' }], { resolveMedia: () => ({ src }) }),
        (error: unknown) => RichTextRenderErrors.is(error, 'invalid_media'),
      );
    }
  });

  it('refuses a malformed descriptor', () => {
    for (const descriptor of [{ src: 1 }, { src: '/x', width: 0 }, { src: '/x', alt: 2 }]) {
      assert.throws(
        () =>
          render([{ type: 'image', mediaId: 'm' }], {
            resolveMedia: () => descriptor as never,
          }),
        (error: unknown) => RichTextRenderErrors.is(error, 'invalid_media'),
      );
    }
  });
});

describe('programmer errors', () => {
  it('refuses a document parseRichText refuses, without echoing it', () => {
    for (const document of [
      { version: 1, blocks: [] },
      { version: 2, blocks: [{ type: 'paragraph', content: [{ text: 'a' }, { text: 'b' }] }] },
      { version: 2, blocks: [{ type: 'cta', label: 'x', href: 'javascript:secret()' }] },
    ]) {
      assert.throws(
        () => renderRichText(document as unknown as RichTextDocument),
        (error: unknown) =>
          RichTextRenderErrors.is(error, 'invalid_document') && !error.message.includes('secret'),
      );
    }
  });

  it('refuses malformed options', () => {
    const document: RichTextDocument = { version: 2, blocks: [] };
    for (const options of [
      null,
      [],
      { resolveMedia: 'x' },
      { embedHostAllowlist: 'x' },
      { embedHostAllowlist: [1] },
    ]) {
      assert.throws(
        () => renderRichText(document, options as never),
        (error: unknown) => RichTextRenderErrors.is(error, 'invalid_option'),
      );
    }
  });
});
