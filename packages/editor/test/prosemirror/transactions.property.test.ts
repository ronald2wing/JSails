/**
 * The reverse codec law: from seeded documents, random sequences of editing
 * operations (typing hostile text, toggling marks, wrapping in and nesting
 * lists, setting links, setting attributes to hostile values, together or
 * one attribute step at a time, changing block types, deleting, pasting
 * slices of the document, inserting over-budget content, undo and redo)
 * always leave a state that decodes to a document `parseRichText` accepts and
 * that is within budget, and that holds nothing more than that document: the
 * state is exactly `encode` of what it decodes to. A hostile attribute value
 * never reaches the state: building its step throws
 * `rich_text_editor.invalid_attribute`, and nothing else may throw. The
 * counts are checked per seed, so a seed replayed with `JSAILS_TEST_SEED`
 * checks exactly what the full run checks for it.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { setBlockType, toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import { wrapInList } from 'prosemirror-schema-list';
import {
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';

import {
  LIST_STYLES,
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_LIST_ITEMS,
  normalizeRichText,
  parseRichText,
} from 'jsails/rich-text';
import {
  FIXED_SEEDS,
  TEST_SEED_ENV,
  forEachSeed,
  generateRichTextDocument,
  type SeededRandom,
  type TestSeedsOptions,
} from 'jsails/testing';

import { decodeUnchecked, encode } from '../../src/prosemirror/codec.js';
import { RichTextEditorErrors } from '../../src/prosemirror/editor-errors.js';
import {
  liftRichTextListItem,
  sinkRichTextListItem,
  splitRichTextListItem,
} from '../../src/prosemirror/list-commands.js';
import { createRichTextEditorState } from '../../src/prosemirror/mount.js';
import { richTextEditorSchema as schema } from '../../src/prosemirror/schema.js';

const DOCUMENTS_PER_SEED = Math.ceil(1_000 / (FIXED_SEEDS.length + 1));
const OPERATIONS = 25;
const ATTEMPTS = DOCUMENTS_PER_SEED * OPERATIONS;

/** A seed outside the fixed list, replayed the way a failure's diagnostic says to. */
const REPLAYED_SEED = 7;

/** Text no model string may hold, mixed with text it may. */
const TEXTS: readonly string[] = [
  'a',
  'word ',
  '日本語',
  '😀',
  '\n',
  '\r\n',
  '\r',
  '\t',
  '\u0000',
  '\u0007',
  '\u001b[31m',
  '\u007f',
  '\u0085',
  '\u009b',
  '\u202e',
  '\u2066',
  '\ud800',
  '\udfff',
  'x\ud83d',
  '<script>alert(1)</script>',
];

const HREFS: readonly unknown[] = [
  '/ok',
  '#frag',
  'https://example.com/',
  'mailto:a@b.c',
  'javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  '//evil.example',
  'data:text/html,x',
  ' https://example.com',
  '',
  null,
  7,
];

/** Attribute values, valid and hostile, for whichever node is picked. */
const ATTRIBUTES: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {
  heading: [{ level: 3 }, { level: 1 }, { level: 7 }, { level: '2' }],
  quote: [{ citation: 'ok' }, { citation: 'a\u202eb' }, { citation: 'x\ny' }],
  callout: [{ tone: 'warning' }, { tone: 'loud' }],
  code_block: [{ language: 'ts' }, { language: 'x'.repeat(65) }],
  list: [{ style: 'task' }, { style: 'ordered' }, { style: 'bogus' }],
  list_item: [{ checked: true }, { checked: 'yes' }],
  list_item_2: [{ checked: true }, { checked: 1 }],
  list_item_3: [{ checked: false }, { checked: null }],
  image: [{ mediaId: 'other' }, { mediaId: '' }, { mediaId: 'm', alt: 'x\u0000' }],
  gallery: [{ mediaIds: ['a', 'b'] }, { mediaIds: [] }, { mediaIds: ['a', 7] }],
  embed: [{ url: 'https://example.com/x' }, { url: 'http://example.com/x' }],
  cta: [
    { label: 'Go', href: '/go' },
    { label: 'Go', href: 'javascript:x' },
    { label: '', href: '/' },
  ],
};

interface Outcome {
  readonly tr?: Transaction;
  /** True when building the transaction threw `invalid_attribute`. */
  readonly refused?: boolean;
}

function textblockPositions(doc: ProseMirrorNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push(pos);
      return false;
    }
    return true;
  });
  return out;
}

/** A text selection inside a random textblock, or `undefined` in a document without one. */
function randomTextSelection(state: EditorState, random: SeededRandom): EditorState | undefined {
  const blocks = textblockPositions(state.doc);
  if (blocks.length === 0) {
    return undefined;
  }
  const pos = random.pick(blocks);
  const block = state.doc.nodeAt(pos) as ProseMirrorNode;
  const a = pos + 1 + random.int(0, block.content.size + 1);
  const b = random.next() < 0.5 ? a : pos + 1 + random.int(0, block.content.size + 1);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, Math.min(a, b), Math.max(a, b))),
  );
}

function runCommand(state: EditorState, command: Command): Outcome {
  let tr: Transaction | undefined;
  command(state, (next) => {
    tr = next;
  });
  return tr === undefined ? {} : { tr };
}

function hostileText(random: SeededRandom): string {
  let out = '';
  const count = random.int(1, 6);
  for (let index = 0; index < count; index += 1) {
    out += random.pick(TEXTS);
  }
  return out;
}

function paragraphs(count: number): Fragment {
  return Fragment.from(
    Array.from({ length: count }, () => schema.nodes.paragraph.create(null, schema.text('p'))),
  );
}

function longList(): ProseMirrorNode {
  return schema.nodes.list.create(
    { style: 'unordered' },
    Array.from({ length: MAX_LIST_ITEMS + 1 }, () =>
      schema.nodes.list_item.create(null, schema.nodes.paragraph.create()),
    ),
  );
}

/** Build one random operation on `state`; only a hostile attribute may throw. */
function operation(state: EditorState, random: SeededRandom): Outcome {
  const roll = random.int(0, 13);
  const selected = randomTextSelection(state, random);
  switch (roll) {
    case 0:
    case 1: {
      if (selected === undefined) {
        return { tr: state.tr.insertText(hostileText(random)) };
      }
      return { tr: selected.tr.insertText(hostileText(random)) };
    }
    case 2: {
      if (selected === undefined) {
        return {};
      }
      const mark = random.pick(['bold', 'italic', 'strike', 'code'] as const);
      return runCommand(selected, toggleMark(schema.marks[mark]));
    }
    case 3: {
      if (selected === undefined) {
        return {};
      }
      return runCommand(
        selected,
        wrapInList(schema.nodes.list, { style: random.pick(LIST_STYLES) }),
      );
    }
    case 4: {
      if (selected === undefined) {
        return {};
      }
      const command = random.pick([
        splitRichTextListItem,
        sinkRichTextListItem,
        liftRichTextListItem,
      ]);
      return runCommand(selected, command);
    }
    case 5: {
      if (selected === undefined || selected.selection.empty) {
        return {};
      }
      const { from, to } = selected.selection;
      return {
        tr: selected.tr.addMark(from, to, schema.marks.link.create({ href: random.pick(HREFS) })),
      };
    }
    case 6: {
      const nodes: { pos: number; node: ProseMirrorNode }[] = [];
      state.doc.descendants((node, pos) => {
        if (ATTRIBUTES[node.type.name] !== undefined) {
          nodes.push({ pos, node });
        }
      });
      if (nodes.length === 0) {
        return {};
      }
      const { pos, node } = random.pick(nodes);
      const attrs = random.pick(ATTRIBUTES[node.type.name] as readonly Record<string, unknown>[]);
      if (random.int(0, 2) === 0) {
        return { tr: state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }) };
      }
      // One attribute step per attribute: a step whose map is empty.
      const tr = state.tr;
      for (const [name, value] of Object.entries(attrs)) {
        tr.setNodeAttribute(pos, name, value);
      }
      return { tr };
    }
    case 7: {
      if (selected === undefined) {
        return {};
      }
      const target = random.pick([
        [schema.nodes.paragraph, null],
        [schema.nodes.heading, { level: random.int(2, 7) }],
        [schema.nodes.code_block, null],
        [schema.nodes.quote, null],
        [schema.nodes.callout, { tone: 'success' }],
      ] as const);
      return runCommand(selected, setBlockType(target[0], target[1]));
    }
    case 8: {
      const size = state.doc.content.size;
      const a = random.int(0, size + 1);
      const b = random.int(0, size + 1);
      return { tr: state.tr.delete(Math.min(a, b), Math.max(a, b)) };
    }
    case 9: {
      const size = state.doc.content.size;
      const a = random.int(0, size + 1);
      const b = random.int(a, size + 1);
      const at = random.int(0, size + 1);
      return { tr: state.tr.replace(at, at, state.doc.slice(a, b)) };
    }
    case 10: {
      const roll2 = random.int(0, 3);
      if (roll2 === 0) {
        // Edits just past a budget, which must be refused (the limits suite covers the boundary).
        const target = selected ?? state;
        return {
          tr: target.tr.insertText('x'.repeat(MAX_BLOCK_CHARS + random.int(1, 20))),
        };
      }
      const at = random.pick([0, state.doc.content.size]);
      return {
        tr: state.tr.insert(
          at,
          roll2 === 1
            ? paragraphs(MAX_BLOCKS + random.int(1, 20) - state.doc.childCount)
            : longList(),
        ),
      };
    }
    case 11:
      return runCommand(state, random.next() < 0.5 ? undo : redo);
    default: {
      // Select a random atom and type over it.
      const atoms: number[] = [];
      state.doc.descendants((node, pos) => {
        if (node.isAtom && node.isBlock) {
          atoms.push(pos);
        }
      });
      if (atoms.length === 0) {
        return {};
      }
      const withAtom = state.apply(
        state.tr.setSelection(NodeSelection.create(state.doc, random.pick(atoms))),
      );
      return { tr: withAtom.tr.insertText(hostileText(random)) };
    }
  }
}

function attempt(state: EditorState, random: SeededRandom): Outcome {
  try {
    return operation(state, random);
  } catch (error) {
    if (RichTextEditorErrors.is(error, 'invalid_attribute')) {
      return { refused: true };
    }
    throw error;
  }
}

interface Counts {
  readonly applied: number;
  readonly refused: number;
}

/**
 * Runs {@link OPERATIONS} random operations on each of
 * {@link DOCUMENTS_PER_SEED} documents, asserting after each applied one
 * that the state is valid, readable and within budget.
 */
function exercise(random: SeededRandom): Counts {
  let applied = 0;
  let refused = 0;
  for (let index = 0; index < DOCUMENTS_PER_SEED; index += 1) {
    let state = createRichTextEditorState(
      normalizeRichText(generateRichTextDocument(random, { maxBlocks: 8 })),
    );
    for (let step = 0; step < OPERATIONS; step += 1) {
      const outcome = attempt(state, random);
      if (outcome.refused === true) {
        refused += 1;
        continue;
      }
      if (outcome.tr === undefined) {
        continue;
      }
      state = state.apply(outcome.tr);
      applied += 1;
      state.doc.check();
      const document = decodeUnchecked(state.doc);
      // parseRichText also checks the budget, so `ok` means readable and within budget.
      const parsed = parseRichText(document);
      assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.issues));
      assert.deepEqual(JSON.parse(JSON.stringify(state.doc.toJSON())), encode(document));
    }
  }
  return { applied, refused };
}

/**
 * The law for every seed `options` selects. The counts are checked per seed,
 * so replaying one seed with `JSAILS_TEST_SEED` checks exactly what the full
 * run checks for it.
 */
async function readableLaw(t: TestContext, options: TestSeedsOptions = {}): Promise<void> {
  await forEachSeed(
    t,
    (random) => {
      const { applied, refused } = exercise(random);
      // Most operations build a transaction, and hostile values come up often
      // enough to test their refusal (about 60% and 5% of attempts are typical).
      assert.ok(applied >= ATTEMPTS / 2, `${applied} of ${ATTEMPTS} transactions applied`);
      assert.ok(refused >= ATTEMPTS / 50, `${refused} hostile attribute values refused`);
    },
    options,
  );
}

describe('rich-text editor transactions', () => {
  it('always leave a readable document within budget', (t) => readableLaw(t));

  it('check the same for a single seed replayed with JSAILS_TEST_SEED', (t) =>
    readableLaw(t, { env: { [TEST_SEED_ENV]: String(REPLAYED_SEED) } }));
});
