/**
 * Tests for the version 2 rich-text schema: every block kind, the text rules,
 * list nesting, versions, and that the JSON Schema stays generatable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ALT_LENGTH,
  MAX_GALLERY_ITEMS,
  RICH_TEXT_VERSION,
  createEmptyRichTextDocument,
  parseRichText,
  richTextContract,
  richTextSchema,
  type RichTextIssue,
} from '../../src/rich-text/index.js';

function document(...blocks: readonly unknown[]): unknown {
  return { version: RICH_TEXT_VERSION, blocks };
}

function codes(input: unknown): readonly string[] {
  const result = parseRichText(input);
  return result.ok ? [] : result.issues.map((issue: RichTextIssue) => issue.code);
}

function paths(input: unknown): readonly string[] {
  const result = parseRichText(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path.join('.'));
}

const run = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

describe('createEmptyRichTextDocument', () => {
  it('returns an empty document at version 2', () => {
    assert.deepEqual(createEmptyRichTextDocument(), { version: 2, blocks: [] });
    assert.equal(parseRichText(createEmptyRichTextDocument()).ok, true);
  });
});

describe('block kinds', () => {
  const valid: readonly [string, unknown][] = [
    ['paragraph', { type: 'paragraph', content: [run('Hi '), run('there', { marks: ['bold'] })] }],
    ['empty paragraph', { type: 'paragraph', content: [] }],
    ['heading', { type: 'heading', level: 2, content: [run('Title')] }],
    ['quote', { type: 'quote', content: [run('Said.')], citation: 'Someone' }],
    ['callout', { type: 'callout', tone: 'warning', content: [run('Careful')] }],
    ['code', { type: 'code', code: 'if (a) {\n\treturn b;\n}\n', language: 'ts' }],
    [
      'task list',
      {
        type: 'list',
        style: 'task',
        items: [
          { content: [run('Do')], checked: true, children: [{ content: [], checked: false }] },
        ],
      },
    ],
    ['image', { type: 'image', mediaId: 'm1', alt: 'A cat', caption: 'Ours' }],
    ['gallery', { type: 'gallery', mediaIds: ['m1', 'm2'], alt: 'Cats' }],
    ['embed', { type: 'embed', url: 'https://www.youtube.com/embed/x' }],
    ['cta', { type: 'cta', label: 'Sign up', href: '/signup' }],
    ['divider', { type: 'divider' }],
  ];
  for (const [name, block] of valid) {
    it(`accepts a ${name}`, () => {
      assert.deepEqual(codes(document(block)), []);
    });
  }

  it('refuses an unknown block type', () => {
    assert.notDeepEqual(codes(document({ type: 'video', content: [] })), []);
  });

  it('refuses a block id, which version 2 does not have', () => {
    assert.deepEqual(codes(document({ id: 'b1', type: 'divider' })), ['unknown_field']);
  });

  it('refuses a heading level outside 2..6', () => {
    for (const level of [1, 7, 2.5]) {
      assert.notDeepEqual(codes(document({ type: 'heading', level, content: [] })), []);
    }
  });

  it('refuses an unknown mark, tone and list style', () => {
    assert.notDeepEqual(
      codes(document({ type: 'paragraph', content: [run('x', { marks: ['underline'] })] })),
      [],
    );
    assert.notDeepEqual(codes(document({ type: 'callout', tone: 'pink', content: [] })), []);
    assert.notDeepEqual(codes(document({ type: 'list', style: 'checklist', items: [] })), []);
  });

  it('refuses an empty media id, CTA label and too many gallery items', () => {
    assert.notDeepEqual(codes(document({ type: 'image', mediaId: '' })), []);
    assert.notDeepEqual(codes(document({ type: 'cta', label: '', href: '/x' })), []);
    const mediaIds = Array.from({ length: MAX_GALLERY_ITEMS + 1 }, (_, i) => `m${i}`);
    assert.notDeepEqual(codes(document({ type: 'gallery', mediaIds })), []);
  });

  it('bounds the single-line fields', () => {
    assert.deepEqual(
      codes(document({ type: 'image', mediaId: 'm', alt: 'a'.repeat(MAX_ALT_LENGTH + 1) })),
      ['too_big'],
    );
  });
});

describe('text rules', () => {
  it('allows a hard break in run text but not in a heading', () => {
    assert.deepEqual(codes(document({ type: 'paragraph', content: [run('a\nb')] })), []);
    assert.deepEqual(codes(document({ type: 'heading', level: 2, content: [run('a\nb')] })), [
      'invalid_text',
    ]);
  });

  it('allows a tab in code only', () => {
    assert.deepEqual(codes(document({ type: 'code', code: '\tx' })), []);
    assert.deepEqual(codes(document({ type: 'paragraph', content: [run('\tx')] })), [
      'invalid_text',
    ]);
  });

  it('refuses line breaks in single-line fields', () => {
    assert.deepEqual(codes(document({ type: 'cta', label: 'a\nb', href: '/x' })), ['invalid_text']);
    assert.deepEqual(codes(document({ type: 'quote', content: [], citation: 'a\nb' })), [
      'invalid_text',
    ]);
  });

  const refused = [
    ['NUL', '\u0000'],
    ['carriage return', '\r'],
    ['escape', '\u001b'],
    ['DEL', '\u007f'],
    ['C1 NEL', '\u0085'],
    ['C1 CSI', '\u009b'],
    ['LRE', '\u202a'],
    ['RLO', '\u202e'],
    ['LRI', '\u2066'],
    ['PDI', '\u2069'],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
  ] as const;
  for (const [name, character] of refused) {
    it(`refuses a ${name} in any text field`, () => {
      const blocks = [
        { type: 'paragraph', content: [run(`a${character}b`)] },
        { type: 'code', code: `a${character}` },
        { type: 'image', mediaId: 'm', alt: character },
        { type: 'cta', label: `go${character}`, href: '/x' },
      ];
      for (const block of blocks) {
        assert.deepEqual(codes(document(block)), ['invalid_text'], JSON.stringify(block.type));
      }
    });
  }

  it('allows paired surrogates, joiners and right-to-left text', () => {
    assert.deepEqual(
      codes(document({ type: 'paragraph', content: [run('😀 👩‍💻 שלום مرحبا ‏')] })),
      [],
    );
  });
});

describe('list nesting', () => {
  const item = (children?: unknown[]) => ({ content: [], ...(children ? { children } : {}) });

  it('accepts three levels', () => {
    const list = { type: 'list', style: 'ordered', items: [item([item([item()])])] };
    assert.deepEqual(codes(document(list)), []);
  });

  it('refuses a fourth level', () => {
    const list = { type: 'list', style: 'ordered', items: [item([item([item([item()])])])] };
    assert.deepEqual(codes(document(list)), ['unknown_field']);
    assert.deepEqual(paths(document(list)), ['blocks.0.items.0.children.0.children.0.children']);
  });
});

describe('versions', () => {
  it('refuses version 1 by number and names the upgrade', () => {
    const result = parseRichText({ version: 1, blocks: [] });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues[0]?.path, ['version']);
      assert.equal(result.issues[0]?.code, 'unsupported_version');
      assert.match(result.issues[0]?.message ?? '', /upgradeRichTextDocument/);
    }
  });

  it('refuses other versions and non-documents', () => {
    assert.deepEqual(codes({ version: 3, blocks: [] }), ['unsupported_version']);
    assert.deepEqual(codes({ blocks: [] }), ['unsupported_version']);
    assert.deepEqual(codes(null), ['invalid_type']);
    assert.deepEqual(codes([]), ['invalid_type']);
    assert.deepEqual(codes('{"version":2,"blocks":[]}'), ['invalid_type']);
  });

  it('refuses a value that is not JSON', () => {
    const cyclic: Record<string, unknown> = { version: 2, blocks: [] };
    cyclic['self'] = cyclic;
    assert.deepEqual(codes(cyclic), ['invalid_type']);
  });
});

describe('richTextContract', () => {
  it('generates input and output JSON Schemas (the schema has no transforms)', () => {
    assert.equal(richTextContract.jsonSchema.type, 'object');
    assert.equal(richTextContract.outputJsonSchema.type, 'object');
    assert.equal(richTextContract.schema, richTextSchema);
  });

  it('carries the text rules as patterns', () => {
    assert.match(JSON.stringify(richTextContract.jsonSchema), /u202a-\\\\u202e/);
  });
});
