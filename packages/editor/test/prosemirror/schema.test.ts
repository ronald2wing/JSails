/**
 * The editor schema holds only what the model accepts:
 *
 * - every attribute refuses the values the model refuses, from `nodeFromJSON`,
 *   from mark creation and from transform steps, with a value-free
 *   `rich_text_editor.invalid_attribute` and the state left unchanged;
 * - structure the model cannot express (a fourth list level, a nested list
 *   at the top, a line break in a heading, `code` with another mark, an
 *   empty list or gallery) fails `check()`;
 * - the DOM parse rules skip refused values (a `javascript:` link arrives as
 *   text, an `<img onerror>` not at all), map pasted HTML onto the model
 *   (a line break in a heading is a space; the paragraphs of a list item,
 *   a quote or an aside stay in that one block), and read back everything
 *   the schema serializes (the clipboard round trip).
 */

import { closeEditorDom, editorWindow } from './editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { DOMParser, DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';

import { normalizeRichText, parseRichText, type RichTextDocument } from 'jsails/rich-text';
import { forEachSeed, generateRichTextDocument } from 'jsails/testing';

import { decode, encode } from '../../src/prosemirror/codec.js';
import { RichTextEditorErrors } from '../../src/prosemirror/editor-errors.js';
import { richTextEditorSchema as schema } from '../../src/prosemirror/schema.js';

after(closeEditorDom);

/** Asserts `fn` throws `invalid_attribute` for `owner.attribute` without echoing `value`. */
function assertRefused(fn: () => unknown, owner: string, attribute: string, value: unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(RichTextEditorErrors.is(error, 'invalid_attribute'), String(error));
    assert.deepEqual(error.context, { owner, attribute });
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length > 3) {
      assert.ok(!error.message.includes(text), 'the refused value is not echoed');
    }
    return true;
  });
}

const HOSTILE: readonly (readonly [string, Readonly<Record<string, unknown>>, string, unknown])[] =
  [
    ['heading', {}, 'level', 1],
    ['heading', {}, 'level', 7],
    ['heading', {}, 'level', '2'],
    ['heading', {}, 'level', 2.5],
    ['quote', {}, 'citation', 'a\u202eb'],
    ['quote', {}, 'citation', 'line\nbreak'],
    ['quote', {}, 'citation', 'x'.repeat(501)],
    ['callout', {}, 'tone', 'bogus'],
    ['code_block', {}, 'language', 'x'.repeat(65)],
    ['code_block', {}, 'language', 'a\u0000'],
    ['list', {}, 'style', 'checklist'],
    ['image', {}, 'mediaId', ''],
    ['image', {}, 'mediaId', 42],
    ['image', { mediaId: 'm' }, 'alt', 'a\u0007'],
    ['image', { mediaId: 'm' }, 'caption', 'x'.repeat(256)],
    ['image', { mediaId: 'm' }, 'alt', '\ud800'],
    ['gallery', {}, 'mediaIds', []],
    ['gallery', {}, 'mediaIds', ['ok', '']],
    ['gallery', {}, 'mediaIds', 'abc'],
    ['gallery', {}, 'mediaIds', Array.from({ length: 26 }, (_, index) => `m${index}`)],
    ['embed', {}, 'url', 'http://www.youtube.com/embed/x'],
    ['embed', {}, 'url', 'javascript:alert(1)'],
    ['embed', {}, 'url', 'https://user:pass@example.com/'],
    ['cta', { href: '/' }, 'label', ''],
    ['cta', { label: 'Go' }, 'href', 'javascript:alert(1)'],
    ['cta', { label: 'Go' }, 'href', '//evil.example/'],
  ];

const HOSTILE_HREFS: readonly unknown[] = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '//evil.example/',
  'https://trusted.example@evil.example/',
  ' https://example.com',
  'relative/path',
  '',
  null,
  42,
];

function paragraphWithLink(href: unknown) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
      },
    ],
  };
}

describe('rich-text editor schema: attributes', () => {
  it('refuses every value the model refuses, from nodeFromJSON', () => {
    for (const [owner, base, attribute, value] of HOSTILE) {
      assertRefused(
        () =>
          schema.nodeFromJSON({
            type: 'doc',
            content: [{ type: owner, attrs: { ...base, [attribute]: value } }],
          }),
        owner,
        attribute,
        value,
      );
    }
    for (const href of HOSTILE_HREFS) {
      assertRefused(() => schema.nodeFromJSON(paragraphWithLink(href)), 'link', 'href', href);
      assertRefused(() => schema.marks.link.create({ href }), 'link', 'href', href);
    }
    for (const owner of ['list_item', 'list_item_2', 'list_item_3']) {
      assertRefused(
        () => schema.nodes[owner as 'list_item'].create({ checked: 'true' }),
        owner,
        'checked',
        'true',
      );
    }
  });

  it('refuses hostile values in steps and leaves the state unchanged', () => {
    const state = EditorState.create({
      doc: schema.nodeFromJSON(
        encode({
          version: 2,
          blocks: [
            { type: 'paragraph', content: [{ text: 'text' }] },
            { type: 'cta', label: 'Go', href: '/go' as never },
            { type: 'embed', url: 'https://example.com/e' as never },
          ],
        }),
      ),
    });
    const before = state.doc;
    const ctaPos = before.child(0).nodeSize;
    const embedPos = ctaPos + before.child(1).nodeSize;
    assertRefused(
      () => state.tr.setNodeAttribute(ctaPos, 'href', 'javascript:x'),
      'cta',
      'href',
      'javascript:x',
    );
    assertRefused(
      () => state.tr.setNodeMarkup(embedPos, undefined, { url: 'http://insecure.example/' }),
      'embed',
      'url',
      'http://insecure.example/',
    );
    assertRefused(
      () => state.tr.addMark(1, 3, schema.marks.link.create({ href: 'vbscript:x' })),
      'link',
      'href',
      'vbscript:x',
    );
    assertRefused(
      () => state.tr.setNodeMarkup(0, schema.nodes.heading, { level: 9 }),
      'heading',
      'level',
      9,
    );
    assert.equal(state.doc, before);
  });
});

describe('rich-text editor schema: structure', () => {
  function fails(json: unknown): void {
    assert.throws(() => schema.nodeFromJSON(json).check(), RangeError);
  }
  const item = (content: unknown[] = []) => ({ type: 'paragraph', content });

  it('cannot hold structure the model cannot express', () => {
    fails({
      type: 'doc',
      content: [
        {
          type: 'list',
          content: [
            {
              type: 'list_item',
              content: [
                item(),
                {
                  type: 'list_2',
                  content: [
                    {
                      type: 'list_item_2',
                      content: [
                        item(),
                        {
                          type: 'list_3',
                          content: [
                            {
                              type: 'list_item_3',
                              content: [
                                item(),
                                {
                                  type: 'list_3',
                                  content: [{ type: 'list_item_3', content: [item()] }],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    fails({
      type: 'doc',
      content: [{ type: 'list_2', content: [{ type: 'list_item_2', content: [item()] }] }],
    });
    fails({
      type: 'doc',
      content: [{ type: 'list', content: [{ type: 'list_item_2', content: [item()] }] }],
    });
    fails({ type: 'doc', content: [{ type: 'list', content: [] }] });
    fails({
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'a' }, { type: 'hard_break' }] },
      ],
    });
    fails({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [{ type: 'bold' }, { type: 'code' }] }],
        },
      ],
    });
    fails({
      type: 'doc',
      content: [
        { type: 'code_block', content: [{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }] },
      ],
    });
    fails({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] });
  });

  it('lets code coexist with a link but with no other mark', () => {
    const code = schema.marks.code.create();
    const link = schema.marks.link.create({ href: '/a' });
    const bold = schema.marks.bold.create();
    assert.deepEqual(
      bold.addToSet(code.addToSet([])).map((mark) => mark.type.name),
      ['code'],
    );
    assert.deepEqual(
      code.addToSet(bold.addToSet([])).map((mark) => mark.type.name),
      ['code'],
    );
    assert.deepEqual(
      link.addToSet(code.addToSet([])).map((mark) => mark.type.name),
      ['link', 'code'],
    );
  });
});

/** Parse `html` the way a paste does and decode the result. */
function parseHtml(html: string, preserveWhitespace = false): RichTextDocument {
  const container = editorWindow.document.createElement('div');
  container.innerHTML = html;
  const doc = DOMParser.fromSchema(schema).parse(container as unknown as Node, {
    preserveWhitespace,
  });
  return decode(doc);
}

describe('rich-text editor schema: parsing', () => {
  it('drops refused links at parse and keeps their text', () => {
    assert.deepEqual(
      parseHtml(
        '<p><a href="javascript:alert(1)">bad</a> <a href=" JavaScript:x">worse</a> <a href="https://ok.example/">ok</a> <a href="page.html">rel</a></p>',
      ).blocks,
      [
        {
          type: 'paragraph',
          content: [
            { text: 'bad worse ' },
            { text: 'ok', href: 'https://ok.example/' },
            { text: ' rel' },
          ],
        },
      ],
    );
  });

  it('drops images, scripts and handlers that have no place in the model', () => {
    const document = parseHtml(
      '<p onclick="x()">a<img src="x" onerror="alert(1)"><script>alert(1)</script><style>p{}</style>b</p><iframe src="https://evil.example/"></iframe>',
    );
    assert.deepEqual(document.blocks, [{ type: 'paragraph', content: [{ text: 'ab' }] }]);
  });

  it('maps pasted headings, marks and Word or Docs markup onto the model', () => {
    assert.deepEqual(
      parseHtml(
        '<h1>Title</h1><h4>Sub<br>title</h4><b style="font-weight:normal" id="docs-internal-guid-1"><p><span style="font-weight:700">bold</span> <span style="font-style:italic">it</span> <span style="text-decoration:line-through">s</span> <strong><code>c</code></strong></p></b><p class="MsoNormal"><o:p>word</o:p></p>',
      ).blocks,
      [
        { type: 'heading', level: 2, content: [{ text: 'Title' }] },
        { type: 'heading', level: 4, content: [{ text: 'Sub title' }] },
        {
          type: 'paragraph',
          content: [
            { text: 'bold', marks: ['bold'] },
            { text: ' ' },
            { text: 'it', marks: ['italic'] },
            { text: ' ' },
            { text: 's', marks: ['strike'] },
            { text: ' ' },
            { text: 'c', marks: ['code'] },
          ],
        },
        { type: 'paragraph', content: [{ text: 'word' }] },
      ],
    );
  });

  it('reads a line break in a pasted heading as a space, never splitting the heading', () => {
    for (const preserveWhitespace of [false, true]) {
      assert.deepEqual(
        parseHtml(
          '<h2>Annual<br>Report</h2><h3><b>a</b><span><br></span><i>b</i></h3>',
          preserveWhitespace,
        ).blocks,
        [
          { type: 'heading', level: 2, content: [{ text: 'Annual Report' }] },
          {
            type: 'heading',
            level: 3,
            content: [
              { text: 'a', marks: ['bold'] },
              { text: ' ' },
              { text: 'b', marks: ['italic'] },
            ],
          },
        ],
      );
    }
  });

  it('reads a <br> the browser put in a live heading as a space', () => {
    // How the view re-reads a heading's DOM after the browser changed it.
    const container = editorWindow.document.createElement('div');
    container.innerHTML = 'Annual<br>Report';
    const heading = DOMParser.fromSchema(schema).parse(container as unknown as Node, {
      topNode: schema.nodes.heading.create({ level: 2 }),
      preserveWhitespace: true,
    });
    assert.equal(heading.textContent, 'Annual Report');
  });

  it('keeps a pasted list item of several paragraphs as one item', () => {
    const list = (items: unknown[]) => [{ type: 'list', style: 'unordered', items }];
    assert.deepEqual(
      parseHtml('<ul><li><p>a</p><p>b</p></li><li><p>c</p></li></ul>').blocks,
      list([{ content: [{ text: 'a\nb' }] }, { content: [{ text: 'c' }] }]),
    );
    assert.deepEqual(
      parseHtml(
        '<ul>\n  <li>\n    <p>a</p>\n    <p style="font-weight:700">b <i>c</i></p>\n  </li>\n</ul>',
      ).blocks,
      list([
        {
          content: [
            { text: 'a\n' },
            { text: 'b ', marks: ['bold'] },
            { text: 'c', marks: ['bold', 'italic'] },
          ],
        },
      ]),
      'whitespace between the paragraphs adds nothing; a paragraph style keeps its marks',
    );
    assert.deepEqual(
      parseHtml('<ul><li>a<p>b</p></li><li><div><p>c</p><p>d</p></div></li></ul>').blocks,
      list([{ content: [{ text: 'a\nb' }] }, { content: [{ text: 'c\nd' }] }]),
    );
    assert.deepEqual(
      parseHtml(
        '<ul><li><p>a</p><p>b</p><ul><li><p>c</p><p>d</p><ul><li><p>e</p><p>f</p></li><li>g</li></ul></li></ul></li></ul>',
      ).blocks,
      list([
        {
          content: [{ text: 'a\nb' }],
          children: [
            {
              content: [{ text: 'c\nd' }],
              children: [{ content: [{ text: 'e\nf' }] }, { content: [{ text: 'g' }] }],
            },
          ],
        },
      ]),
      'at every level, the deepest included',
    );
    assert.deepEqual(
      parseHtml(
        '<ul class="contains-task-list"><li><p><input type="checkbox" checked> a</p><p>b</p></li></ul>',
      ).blocks,
      [{ type: 'list', style: 'task', items: [{ content: [{ text: 'a\nb' }], checked: true }] }],
    );
    for (const preserveWhitespace of [false, true]) {
      assert.deepEqual(
        parseHtml(
          '<ul><li><p><a href="/x">a</a></p><pre><code>x\ny</code></pre><p><a href="javascript:alert(1)">z</a></p></li></ul>',
          preserveWhitespace,
        ).blocks,
        list([{ content: [{ text: 'a', href: '/x' }, { text: '\nx\ny\nz' }] }]),
        'links and the lines of code keep, through the parser and back; a refused link is text',
      );
    }
  });

  it('keeps a pasted aside of several paragraphs as one callout', () => {
    assert.deepEqual(
      parseHtml(
        '<aside class="note"><p>a</p><p><em>b</em></p></aside><aside data-tone="warning"><p>c</p></aside>',
      ).blocks,
      [
        {
          type: 'callout',
          tone: 'info',
          content: [{ text: 'a\n' }, { text: 'b', marks: ['italic'] }],
        },
        { type: 'callout', tone: 'warning', content: [{ text: 'c' }] },
      ],
    );
    assert.deepEqual(
      parseHtml('<aside>a<p>b</p></aside><blockquote>c<p>d</p></blockquote>').blocks,
      [
        { type: 'callout', tone: 'info', content: [{ text: 'a\nb' }] },
        { type: 'quote', content: [{ text: 'c\nd' }] },
      ],
      'inline text before the first paragraph is a line of its own, in an aside as in a quote',
    );
  });

  it('maps nested and task lists, never past the third level', () => {
    assert.deepEqual(
      parseHtml(
        '<ol><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li><li><p>e</p></li></ol>',
      ).blocks.slice(0, 1),
      [
        {
          type: 'list',
          style: 'ordered',
          items: [
            {
              content: [{ text: 'a' }],
              children: [{ content: [{ text: 'b' }], children: [{ content: [{ text: 'c' }] }] }],
            },
          ],
        },
      ],
    );
    const flattened = parseHtml(
      '<ol><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li></ol>',
    );
    assert.ok(parseRichText(flattened).ok);
    assert.ok(JSON.stringify(flattened).includes('"d"'), 'the fourth level keeps its text');
    assert.deepEqual(
      parseHtml(
        '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>',
      ).blocks,
      [
        {
          type: 'list',
          style: 'task',
          items: [
            { content: [{ text: 'done' }], checked: true },
            { content: [{ text: 'todo' }], checked: false },
          ],
        },
      ],
    );
  });

  it('keeps a pasted quote of several paragraphs as one quote', () => {
    assert.deepEqual(parseHtml('<blockquote><p>one</p><p><em>two</em></p></blockquote>').blocks, [
      { type: 'quote', content: [{ text: 'one\n' }, { text: 'two', marks: ['italic'] }] },
    ]);
  });

  it('keeps code whitespace and reads the language class', () => {
    assert.deepEqual(parseHtml('<pre><code class="language-ts">a\n\tb  c</code></pre>').blocks, [
      { type: 'code', code: 'a\n\tb  c', language: 'ts' },
    ]);
    assert.deepEqual(
      parseHtml(`<pre data-language="${'x'.repeat(65)}"><code>z</code></pre>`).blocks,
      [{ type: 'code', code: 'z' }],
    );
  });

  it('refuses hostile media, embed and CTA serializations', () => {
    assert.deepEqual(
      parseHtml(
        '<figure data-rich-text="embed" data-url="javascript:alert(1)"></figure><figure data-rich-text="image" data-media-id=""></figure><figure data-rich-text="gallery" data-media-ids="not json"></figure><div data-rich-text="cta" data-label="Go" data-href="javascript:x">Go</div>',
      ).blocks,
      [{ type: 'paragraph', content: [{ text: 'Go' }] }],
    );
  });

  it('reads back everything it serializes (the clipboard round trip)', async (t) => {
    const serializer = DOMSerializer.fromSchema(schema);
    await forEachSeed(t, (random) => {
      for (let index = 0; index < 150; index += 1) {
        const document = normalizeRichText(generateRichTextDocument(random));
        const node: ProseMirrorNode = schema.nodeFromJSON(encode(document));
        const container = editorWindow.document.createElement('div');
        container.appendChild(
          serializer.serializeFragment(node.content, {
            document: editorWindow.document as unknown as Document,
          }) as unknown as never,
        );
        const parsed = DOMParser.fromSchema(schema).parse(container as unknown as Node, {
          preserveWhitespace: true,
        });
        assert.deepEqual(decode(parsed), document);
      }
    });
  });
});
