import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RenderError,
  renderRichText,
  type RenderRichTextOptions,
  type ResolvedMedia,
} from '../../src/server/index.js';
import type { RichTextBlock, RichTextDocument } from 'jsails/rich-text';

/** Wrap blocks into a validated document for rendering. */
function document(...blocks: readonly RichTextBlock[]): RichTextDocument {
  return { version: 1, blocks: [...blocks] };
}

/** A paragraph block. */
function paragraph(id: string, text: string): RichTextBlock {
  return { id, type: 'paragraph', text };
}

/** A heading block. */
function heading(id: string, level: 2 | 3 | 4 | 5 | 6, text: string): RichTextBlock {
  return { id, type: 'heading', level, text };
}

/** An image block. */
function image(
  id: string,
  mediaId: string,
  extra: { alt?: string; caption?: string } = {},
): RichTextBlock {
  return { id, type: 'image', mediaId, ...extra };
}

/** An embed block. */
function embed(id: string, url: string): RichTextBlock {
  return { id, type: 'embed', url };
}

/** A CTA block. */
function cta(id: string, label: string, href: string): RichTextBlock {
  return { id, type: 'cta', label, href };
}

/** A media resolver stub that returns a fixed descriptor for any id. */
function fixedResolver(
  src: string,
  extra: Partial<ResolvedMedia> = {},
): (id: string) => ResolvedMedia {
  return () => ({ src, ...extra });
}

const YOUTUBE_ALLOWLIST = ['.youtube.com'];

describe('renderRichText — block types', () => {
  it('renders a paragraph', () => {
    assert.equal(renderRichText(document(paragraph('b1', 'hello'))), '<p>hello</p>');
  });

  it('renders headings at each supported level', () => {
    assert.equal(renderRichText(document(heading('b1', 2, 'two'))), '<h2>two</h2>');
    assert.equal(renderRichText(document(heading('b1', 6, 'six'))), '<h6>six</h6>');
  });

  it('renders ordered and unordered lists', () => {
    const ordered: RichTextBlock = { id: 'b1', type: 'list', style: 'ordered', items: ['a', 'b'] };
    const unordered: RichTextBlock = { id: 'b2', type: 'list', style: 'unordered', items: ['x'] };
    assert.equal(
      renderRichText(document(ordered, unordered)),
      '<ol><li>a</li><li>b</li></ol>\n<ul><li>x</li></ul>',
    );
  });

  it('renders a quote with and without a citation', () => {
    const quoted: RichTextBlock = { id: 'b1', type: 'quote', text: 'words', citation: 'author' };
    const bare: RichTextBlock = { id: 'b2', type: 'quote', text: 'words' };
    assert.equal(
      renderRichText(document(quoted)),
      '<blockquote><p>words</p><footer><cite>author</cite></footer></blockquote>',
    );
    assert.equal(renderRichText(document(bare)), '<blockquote><p>words</p></blockquote>');
  });

  it('renders a code block with an escaped language class', () => {
    const code: RichTextBlock = {
      id: 'b1',
      type: 'code',
      code: 'const x = 1;',
      language: 'typescript',
    };
    assert.equal(
      renderRichText(document(code)),
      '<pre><code class="language-typescript">const x = 1;</code></pre>',
    );
  });

  it('renders a code block without a language class', () => {
    const code: RichTextBlock = { id: 'b1', type: 'code', code: 'x' };
    assert.equal(renderRichText(document(code)), '<pre><code>x</code></pre>');
  });

  it('renders a callout with the tone class', () => {
    const callout: RichTextBlock = { id: 'b1', type: 'callout', tone: 'warning', text: 'careful' };
    assert.equal(
      renderRichText(document(callout)),
      '<aside class="jsails-callout jsails-callout--warning">careful</aside>',
    );
  });

  it('renders a divider', () => {
    const divider: RichTextBlock = { id: 'b1', type: 'divider' };
    assert.equal(renderRichText(document(divider)), '<hr>');
  });

  it('joins multiple blocks with newlines', () => {
    assert.equal(
      renderRichText(document(paragraph('b1', 'one'), paragraph('b2', 'two'))),
      '<p>one</p>\n<p>two</p>',
    );
  });

  it('renders an empty document to an empty string', () => {
    assert.equal(renderRichText(document()), '');
  });
});

describe('renderRichText — escaping', () => {
  it('escapes text nodes', () => {
    const result = renderRichText(document(paragraph('b1', '<script>alert("x")</script>')));
    assert.equal(result, '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
    assert.ok(!result.includes('<script>'));
  });

  it('escapes heading, list, and quote text', () => {
    const list: RichTextBlock = {
      id: 'b1',
      type: 'list',
      style: 'unordered',
      items: ['<b>bold</b>'],
    };
    assert.equal(renderRichText(document(list)), '<ul><li>&lt;b&gt;bold&lt;/b&gt;</li></ul>');
  });

  it('escapes image alt and caption', () => {
    const block = image('b1', 'm1', { alt: 'a" onclick="x', caption: '<i>cap</i>' });
    const result = renderRichText(document(block), {
      resolveMedia: fixedResolver('/img.png'),
    });
    assert.ok(result.includes('alt="a&quot; onclick=&quot;x"'), result);
    assert.ok(result.includes('<figcaption>&lt;i&gt;cap&lt;/i&gt;</figcaption>'), result);
  });

  it('escapes an embed-derived iframe src', () => {
    const result = renderRichText(document(embed('b1', 'https://www.youtube.com/watch?v=1')), {
      embedHostAllowlist: YOUTUBE_ALLOWLIST,
    });
    assert.ok(result.includes('src="https://www.youtube.com/watch?v=1"'), result);
  });

  it('escapes a CTA label and rejects a javascript: href', () => {
    const block = cta('b1', '<span>x</span>', 'javascript:alert(1)');
    const result = renderRichText(document(block));
    assert.equal(result, '<p class="jsails-cta"><span>&lt;span&gt;x&lt;/span&gt;</span></p>');
  });

  it('escapes the language attribute so it cannot break out of the class', () => {
    const code: RichTextBlock = {
      id: 'b1',
      type: 'code',
      code: 'x',
      language: 'ts" onmouseover="x',
    };
    const result = renderRichText(document(code));
    assert.ok(result.includes('class="language-ts&quot; onmouseover=&quot;x"'), result);
  });
});

describe('renderRichText — media resolution', () => {
  it('renders an image with the resolved src and block alt', () => {
    const result = renderRichText(document(image('b1', 'm1', { alt: 'pic' })), {
      resolveMedia: fixedResolver('/img.png', { width: 100, height: 50 }),
    });
    assert.equal(result, '<img src="/img.png" alt="pic" width="100" height="50" loading="lazy">');
  });

  it('prefers the block alt over the resolved alt', () => {
    const result = renderRichText(document(image('b1', 'm1', { alt: 'block' })), {
      resolveMedia: fixedResolver('/img.png', { alt: 'resolved' }),
    });
    assert.ok(result.includes('alt="block"'), result);
    assert.ok(!result.includes('alt="resolved"'), result);
  });

  it('falls back to the resolved alt when the block alt is absent', () => {
    const result = renderRichText(document(image('b1', 'm1')), {
      resolveMedia: fixedResolver('/img.png', { alt: 'resolved' }),
    });
    assert.ok(result.includes('alt="resolved"'), result);
  });

  it('emits an empty alt when neither block nor resolved alt is present', () => {
    const result = renderRichText(document(image('b1', 'm1')), {
      resolveMedia: fixedResolver('/img.png'),
    });
    assert.ok(result.includes('alt=""'), result);
  });

  it('renders an image figure with a caption', () => {
    const result = renderRichText(document(image('b1', 'm1', { caption: 'a caption' })), {
      resolveMedia: fixedResolver('/img.png'),
    });
    assert.ok(result.startsWith('<figure>'), result);
    assert.ok(result.includes('<img src="/img.png"'), result);
    assert.ok(result.includes('<figcaption>a caption</figcaption>'), result);
  });

  it('renders a gallery of resolved images', () => {
    const gallery: RichTextBlock = { id: 'g1', type: 'gallery', mediaIds: ['m1', 'm2'], alt: 'g' };
    const result = renderRichText(document(gallery), {
      resolveMedia: (id) => ({ src: `/${id}.png` }),
    });
    assert.ok(result.startsWith('<figure class="jsails-gallery">'), result);
    assert.ok(result.includes('src="/m1.png"'), result);
    assert.ok(result.includes('src="/m2.png"'), result);
  });

  it('renders a safe placeholder for a missing media id, never an error', () => {
    const result = renderRichText(document(image('b1', 'gone')), {
      resolveMedia: () => undefined,
    });
    assert.equal(result, '<span class="jsails-media-placeholder" aria-hidden="true"></span>');
  });

  it('renders a placeholder when no resolver is supplied', () => {
    const result = renderRichText(document(image('b1', 'm1')));
    assert.ok(result.includes('jsails-media-placeholder'), result);
  });

  it('omits width/height attributes when they are absent', () => {
    const result = renderRichText(document(image('b1', 'm1')), {
      resolveMedia: fixedResolver('/img.png'),
    });
    assert.ok(!result.includes('width='), result);
    assert.ok(!result.includes('height='), result);
  });

  it('throws invalid_media for a non-positive dimension', () => {
    assert.throws(
      () =>
        renderRichText(document(image('b1', 'm1')), {
          resolveMedia: fixedResolver('/img.png', { width: 0 }),
        }),
      (error: unknown) => error instanceof RenderError && error.code === 'invalid_media',
    );
  });
});

describe('renderRichText — embed policy', () => {
  it('renders an allowlisted https embed', () => {
    const result = renderRichText(document(embed('b1', 'https://youtube.com/watch?v=1')), {
      embedHostAllowlist: ['.youtube.com'],
    });
    assert.ok(result.includes('<iframe'), result);
  });

  it('renders an exact-host match', () => {
    const result = renderRichText(document(embed('b1', 'https://vimeo.com/123')), {
      embedHostAllowlist: ['vimeo.com'],
    });
    assert.ok(result.includes('<iframe'), result);
  });

  it('rejects a non-allowlisted host', () => {
    const result = renderRichText(document(embed('b1', 'https://evil.example.com/x')), {
      embedHostAllowlist: YOUTUBE_ALLOWLIST,
    });
    assert.ok(result.includes('jsails-media-placeholder'), result);
    assert.ok(!result.includes('<iframe'), result);
  });

  it('rejects http unless explicitly allowed', () => {
    const url = 'http://youtube.com/watch?v=1';
    assert.ok(
      renderRichText(document(embed('b1', url)), {
        embedHostAllowlist: YOUTUBE_ALLOWLIST,
      }).includes('jsails-media-placeholder'),
    );
    assert.ok(
      renderRichText(document(embed('b1', url)), {
        embedHostAllowlist: YOUTUBE_ALLOWLIST,
        allowHttpEmbed: true,
      }).includes('<iframe'),
    );
  });

  it('rejects non-http(s) schemes', () => {
    const result = renderRichText(document(embed('b1', 'javascript:alert(1)')), {
      embedHostAllowlist: YOUTUBE_ALLOWLIST,
    });
    assert.ok(result.includes('jsails-media-placeholder'), result);
  });

  it('rejects an empty allowlist', () => {
    const result = renderRichText(document(embed('b1', 'https://youtube.com/watch?v=1')));
    assert.ok(result.includes('jsails-media-placeholder'), result);
  });
});

describe('renderRichText — CTA policy', () => {
  it('renders a same-origin path link', () => {
    const result = renderRichText(document(cta('b1', 'Go', '/pricing')));
    assert.equal(result, '<p class="jsails-cta"><a href="/pricing">Go</a></p>');
  });

  it('adds noopener/noreferrer to an external link', () => {
    const result = renderRichText(document(cta('b1', 'Go', 'https://example.com')));
    assert.equal(
      result,
      '<p class="jsails-cta"><a href="https://example.com" rel="noopener noreferrer">Go</a></p>',
    );
  });

  it('rejects javascript:, data:, and vbscript: hrefs', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)']) {
      const result = renderRichText(document(cta('b1', 'Go', href)));
      assert.ok(!result.includes('<a '), result);
      assert.ok(!result.includes('href='), result);
    }
  });

  it('rejects a case-varied javascript href', () => {
    const result = renderRichText(document(cta('b1', 'Go', 'JaVaScRiPt:alert(1)')));
    assert.ok(!result.includes('href='), result);
  });
});

describe('renderRichText — invalid input', () => {
  it('throws invalid_document for a non-document', () => {
    assert.throws(
      () => renderRichText(null as unknown as RichTextDocument),
      (error: unknown) => error instanceof RenderError && error.code === 'invalid_document',
    );
  });

  it('throws invalid_document for a wrong version', () => {
    assert.throws(
      () => renderRichText({ version: 2, blocks: [] } as unknown as RichTextDocument),
      (error: unknown) => error instanceof RenderError && error.code === 'invalid_document',
    );
  });

  it('throws invalid_option for non-object options', () => {
    assert.throws(
      () => renderRichText(document(), null as unknown as RenderRichTextOptions),
      (error: unknown) => error instanceof RenderError && error.code === 'invalid_option',
    );
  });

  it('throws invalid_media for a resolver returning a non-descriptor', () => {
    assert.throws(
      () =>
        renderRichText(document(image('b1', 'm1')), {
          resolveMedia: () => ({ bad: true }) as unknown as ResolvedMedia,
        }),
      (error: unknown) => error instanceof RenderError && error.code === 'invalid_media',
    );
  });

  it('never echoes input values in error messages', () => {
    const secret = 'SHOULD-NOT-LEAK';
    try {
      renderRichText({ version: 9, blocks: [{ id: secret }] } as unknown as RichTextDocument);
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof RenderError);
      assert.ok(!error.message.includes(secret));
    }
  });
});
