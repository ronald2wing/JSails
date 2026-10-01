/**
 * Seeded property tests for the .jsails front end: generated templates parse without error both here and with Prettier's vue parser, with the same element structure; random mutations of them only ever produce positioned diagnostics, never a throw; and formatting with Prettier never changes the text the whitespace rule renders.
 *
 * The full seed sets cost about 30 s of CPU, most of it in Prettier (10,000
 * parsed and 400 formatted templates), which every local `npm test` would pay
 * for no new information. So a local run takes the first 1,000 / 100 / 1,000
 * seeds of the parse, format and mutation sets, and a CI run, or one with
 * `JSAILS_TEST_FULL_PROPERTY=1`, takes all of them. GitHub Actions sets `CI`
 * in every job, the Linux `coverage` job included, and the test runner passes it
 * through, so the full sets still guard every merge. The smaller sets are not
 * a weaker sample of the generator: every set starts at seed 0, and a test
 * below fails unless the smallest one reaches every branch and every pool
 * value the generator has, so a generator change that makes a choice rare
 * enough to fall outside it fails instead of going untested locally.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as prettier from 'prettier';

import { parseSfcBlocks } from '../../../src/compiler/sfc/blocks.js';
import { SFC_DIAGNOSTIC_CODES } from '../../../src/compiler/sfc/diagnostics.js';
import type { TemplateNode } from '../../../src/compiler/sfc/template-ast.js';

/** mulberry32: a small deterministic PRNG, so every failure names a reproducible seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

/**
 * The generator branches and pool values the current seeds reached. Every
 * choice the generator makes records itself here, so the seed set can be
 * shown to cover all of them (`GENERATOR_CHOICES`).
 */
const reached = new Set<string>();

function hit(choice: string): void {
  reached.add(choice);
}

/** `pick`, recording the chosen value of the named pool. */
function choose<T extends string>(rng: Rng, pool: string, items: readonly T[]): T {
  const item = pick(rng, items);
  hit(`${pool}:${item}`);
  return item;
}

const WORDS = [
  'hello',
  'world',
  '{',
  '}',
  'a > b',
  '1 { 2 }',
  '&amp;',
  '&larr;',
  '&#65;',
  '&check;',
  'R&D',
  '—',
  'ünïcødé',
  '😀',
  ',',
  '.',
  '(x)',
];
const SPACES = ['', ' ', '  ', '\n', '\n    ', '\t', ' \n  '];
const BREAKS = SPACES.slice(1);
const EXPRESSIONS = [
  'a',
  'page.title',
  "'}}'",
  '`x${y}}`',
  "a > b ? 'x' : 'y'",
  '{ a: { b: 1 } }.a',
  'fn(a, b)',
  'xs.length + 1',
  'a < b',
  '(n as number)',
  'list.map((x) => x.id).join(", ")',
];
const INLINE = ['span', 'b', 'em', 'a', 'Card', 'code', 'Badge'];
const BLOCKS = ['div', 'section', 'p', 'ul', 'article', 'header'];
const VOIDS = ['<input>', '<input />', '<br>', '<img src="a.png" alt="">'];
const ATTRIBUTES = [
  ' class="a b"',
  ' id="main"',
  ' disabled',
  ' :title="page.title"',
  ' @click="go"',
  ' @submit.prevent="save()"',
  ' js-show="open"',
  ' data-x="&quot;q&quot;"',
  ' :href="`/p/${id}`"',
  ' aria-label="Close"',
];
const BRANCHES = [
  'list-item',
  'text',
  'interpolation',
  'comment',
  'void',
  'conditional',
  'conditional-inline',
  'else-if',
  'else',
  'for',
  'prettier-ignore-pre',
  'element-inline-only',
  'element-any',
  'element-text-content',
  'element-children',
  'depth-limit',
  'attribute-duplicate',
];

/** Every choice the generator can make, which the seed set must reach. */
const GENERATOR_CHOICES: readonly string[] = [
  ...BRANCHES.map((branch) => `branch:${branch}`),
  ...WORDS.map((word) => `word:${word}`),
  ...SPACES.map((space) => `space:${space}`),
  ...EXPRESSIONS.map((expression) => `expression:${expression}`),
  ...INLINE.map((tag) => `tag:${tag}`),
  ...BLOCKS.map((tag) => `tag:${tag}`),
  ...VOIDS.map((element) => `void:${element}`),
  ...ATTRIBUTES.map((attribute) => `attribute:${attribute}`),
];

interface Generated {
  readonly markup: string;
}

/** Generate one template's content from `rng`. */
function template(rng: Rng): Generated {
  return { markup: children(rng, 0, 'div') };
}

/** Text whose words are separated, and which ends, by whitespace, so `{` never meets `{{`. */
function text(rng: Rng): string {
  let out = choose(rng, 'space', SPACES);
  const count = 1 + Math.floor(rng() * 3);
  for (let index = 0; index < count; index += 1) {
    out += (index === 0 ? '' : choose(rng, 'space', BREAKS)) + choose(rng, 'word', WORDS);
  }
  return out + choose(rng, 'space', BREAKS);
}

function children(rng: Rng, depth: number, parent: string): string {
  const inlineOnly = parent === 'p' || INLINE.includes(parent);
  let out = '';
  const count = depth === 0 ? 2 + Math.floor(rng() * 5) : Math.floor(rng() * (depth > 2 ? 2 : 5));
  for (let index = 0; index < count; index += 1) {
    const roll = rng();
    if (parent === 'ul') {
      hit('branch:list-item');
      out += `${choose(rng, 'space', SPACES)}<li${attributes(rng)}>${children(rng, depth + 1, 'li')}</li>`;
      continue;
    }
    if (roll < 0.25) {
      hit('branch:text');
      out += text(rng);
    } else if (roll < 0.4) {
      hit('branch:interpolation');
      out += `{{ ${choose(rng, 'expression', EXPRESSIONS)} }}`;
    } else if (roll < 0.45) {
      hit('branch:comment');
      out += '<!-- note -->';
    } else if (roll < 0.5) {
      hit('branch:void');
      out += choose(rng, 'void', VOIDS);
    } else if (roll < 0.55 && depth < 3) {
      out += conditional(rng, depth, parent);
    } else if (roll < 0.6 && depth < 3) {
      hit('branch:for');
      out += `<template js-for="(item, i) in items" :key="item.id">${children(rng, depth + 1, parent)}</template>`;
    } else if (roll < 0.63) {
      hit('branch:prettier-ignore-pre');
      out += '<!-- prettier-ignore -->\n<code js-pre>{{a+b}}  <b :t="p+q">raw</b></code>';
    } else if (depth < 4) {
      hit(inlineOnly ? 'branch:element-inline-only' : 'branch:element-any');
      const tag = inlineOnly
        ? choose(rng, 'tag', INLINE)
        : choose(rng, 'tag', [...BLOCKS, ...INLINE]);
      const textContent = tag === 'a' || tag === 'code';
      hit(textContent ? 'branch:element-text-content' : 'branch:element-children');
      const inner = textContent ? text(rng) : children(rng, depth + 1, tag);
      out += `<${tag}${attributes(rng)}>${inner}</${tag}>`;
    } else {
      hit('branch:depth-limit');
    }
    out += choose(rng, 'space', SPACES);
  }
  return out;
}

function conditional(rng: Rng, depth: number, parent: string): string {
  const inline = parent === 'p' || INLINE.includes(parent);
  hit(inline ? 'branch:conditional-inline' : 'branch:conditional');
  const tag = inline ? 'span' : 'div';
  let out = `<${tag} js-if="a">${children(rng, depth + 1, tag)}</${tag}>`;
  if (rng() < 0.5) {
    hit('branch:else-if');
    out += `${choose(rng, 'space', SPACES)}<${tag} js-else-if="b">${children(rng, depth + 1, tag)}</${tag}>`;
  }
  if (rng() < 0.5) {
    hit('branch:else');
    out += `${choose(rng, 'space', SPACES)}<!-- else -->${choose(rng, 'space', SPACES)}<${tag} js-else>x</${tag}>`;
  }
  return out;
}

function attributes(rng: Rng): string {
  let out = '';
  const used = new Set<string>();
  const count = Math.floor(rng() * 3);
  for (let index = 0; index < count; index += 1) {
    const attribute = choose(rng, 'attribute', ATTRIBUTES);
    const key = attribute
      .replace(/=.*/, '')
      .replace(/^ [:@]/, ' ')
      .replace(/\..*/, '');
    if (used.has(key)) {
      hit('branch:attribute-duplicate');
    } else {
      used.add(key);
      out += attribute;
    }
  }
  return out;
}

/** A structural skeleton: element names, attribute names and nesting. */
function jsailsSkeleton(nodes: readonly TemplateNode[]): string {
  return nodes
    .flatMap((node) => {
      if (node.kind !== 'element') {
        return [];
      }
      const names = node.attributes.map((attribute) => source(attribute.start, attribute.nameEnd));
      return [`${node.tag}[${names.join(' ')}](${jsailsSkeleton(node.children)})`];
    })
    .join('');
}

let currentSource = '';
function source(start: number, end: number): string {
  return currentSource.slice(start, end);
}

interface PrettierNode {
  readonly kind: string;
  readonly name?: string;
  readonly attrs?: readonly { readonly name: string }[];
  readonly children?: readonly PrettierNode[];
}

function prettierSkeleton(nodes: readonly PrettierNode[]): string {
  return nodes
    .flatMap((node) => {
      if (node.kind !== 'element') {
        return [];
      }
      const names = (node.attrs ?? []).map((attribute) => attribute.name);
      return [`${node.name ?? ''}[${names.join(' ')}](${prettierSkeleton(node.children ?? [])})`];
    })
    .join('');
}

/** Prettier's parser entry point, which its public types leave out. */
const prettierDebug = (
  prettier as unknown as {
    readonly __debug: {
      parse(text: string, options: { parser: string }): Promise<{ readonly ast: PrettierNode }>;
    };
  }
).__debug;

/** Whether CI is set, read the way the bench gate reads it: anything but empty, `false` or `0`. */
function onCi(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

const FULL = onCi(process.env) || process.env.JSAILS_TEST_FULL_PROPERTY === '1';
const SEEDS = FULL
  ? { parsed: 10_000, formatted: 400, mutated: 3_000 }
  : { parsed: 1_000, formatted: 100, mutated: 1_000 };
const SMALLEST_SET = Math.min(SEEDS.parsed, SEEDS.formatted, SEEDS.mutated);
const BATCH = 100;

/** Wrap a batch of generated templates in one file, one `<div data-case>` each. */
function batchFile(first: number): string {
  const cases: string[] = [];
  for (let index = first; index < first + BATCH; index += 1) {
    cases.push(`<div data-case="${index}">${template(random(index)).markup}</div>`);
  }
  return `<template>\n${cases.join('\n')}\n</template>\n`;
}

describe('generated templates', () => {
  it('reach every generator branch and pool value within the smallest seed set', () => {
    reached.clear();
    for (let seed = 0; seed < SMALLEST_SET; seed += 1) {
      template(random(seed));
    }
    assert.deepEqual(
      GENERATOR_CHOICES.filter((choice) => !reached.has(choice)),
      [],
    );
    assert.deepEqual(
      [...reached].filter((choice) => !GENERATOR_CHOICES.includes(choice)),
      [],
      'every recorded choice is listed',
    );
  });

  it('parse without error here and in Prettier vue, with the same structure', async () => {
    for (let first = 0; first < SEEDS.parsed; first += BATCH) {
      const file = batchFile(first);
      const parsed = parseSfcBlocks(file, 'components/generated.jsails');
      const errors = parsed.diagnostics.filter((entry) => entry.severity === 'error');
      assert.deepEqual(
        errors.map(
          (entry) =>
            `${entry.code} at ${entry.start}: ${JSON.stringify(file.slice(entry.start - 40, entry.end + 40))}`,
        ),
        [],
        `batch starting at seed ${first}`,
      );
      const theirs = await prettierDebug.parse(file, { parser: 'vue' });
      const root = theirs.ast.children?.find(
        (node) => node.kind === 'element' && node.name === 'template',
      );
      assert.ok(root !== undefined);
      currentSource = file;
      const ours = (parsed.template?.root.children ?? []).filter((node) => node.kind === 'element');
      const prettierCases = (root.children ?? []).filter((node) => node.kind === 'element');
      assert.equal(ours.length, BATCH);
      assert.equal(prettierCases.length, BATCH);
      ours.forEach((node, index) => {
        assert.equal(
          jsailsSkeleton([node]),
          prettierSkeleton([prettierCases[index] as PrettierNode]),
          `structure differs for seed ${first + index}`,
        );
      });
    }
  });

  it('render the same text after Prettier formats them', async () => {
    for (let seed = 0; seed < SEEDS.formatted; seed += 1) {
      const original = `<template>\n${template(random(seed)).markup}\n</template>\n`;
      const formatted = await prettier.format(original, {
        parser: 'vue',
        singleQuote: true,
        printWidth: 40,
      });
      assert.equal(
        rendered(formatted),
        rendered(original),
        `seed ${seed} renders differently after formatting:\n${original}\n---\n${formatted}`,
      );
    }
  });
});

/** The text a template renders: element nesting and every text node's value. */
function rendered(file: string): string {
  const parsed = parseSfcBlocks(file, 'components/generated.jsails');
  assert.deepEqual(
    parsed.diagnostics.filter((entry) => entry.severity === 'error'),
    [],
  );
  const walk = (nodes: readonly TemplateNode[]): string =>
    nodes
      .map((node) => {
        if (node.kind === 'text') {
          return JSON.stringify(node.value);
        }
        if (node.kind === 'interpolation') {
          return '{{}}';
        }
        return `<${node.tag}>${walk(node.children)}</${node.tag}>`;
      })
      .join('');
  return walk(parsed.template?.root.children ?? []);
}

describe('mutated templates', () => {
  const INSERTS = [
    '<',
    '>',
    '"',
    "'",
    '{',
    '}',
    '{{',
    '}}',
    '=',
    '/',
    '&',
    '!',
    '-',
    '<!--',
    '</',
    'js-',
    ':',
    '@',
    '#',
    '<template>',
    '</template>',
    '<script>',
    '\n',
  ];

  it('only ever produce positioned diagnostics, never a throw', () => {
    const known = new Set<string>(SFC_DIAGNOSTIC_CODES);
    for (let seed = 0; seed < SEEDS.mutated; seed += 1) {
      const rng = random(1_000_000 + seed);
      let file = `<script lang="ts">const a = 1;</script>\n<template>${template(random(seed)).markup}</template>`;
      const edits = 1 + Math.floor(rng() * 3);
      for (let edit = 0; edit < edits; edit += 1) {
        const at = Math.floor(rng() * (file.length + 1));
        const roll = rng();
        if (roll < 0.4) {
          file = file.slice(0, at) + pick(rng, INSERTS) + file.slice(at);
        } else if (roll < 0.8) {
          file = file.slice(0, at) + file.slice(at + 1 + Math.floor(rng() * 6));
        } else {
          file = file.slice(0, at);
        }
      }
      let result;
      try {
        result = parseSfcBlocks(file, 'components/mutated.jsails');
      } catch (error) {
        assert.fail(`seed ${seed} threw ${String(error)} for ${JSON.stringify(file)}`);
      }
      for (const diagnostic of result.diagnostics) {
        assert.ok(known.has(diagnostic.code), diagnostic.code);
        assert.ok(
          diagnostic.start >= 0 &&
            diagnostic.start <= diagnostic.end &&
            diagnostic.end <= file.length,
          `seed ${seed}: ${diagnostic.code} at ${diagnostic.start}-${diagnostic.end} of ${file.length}`,
        );
        assert.equal(diagnostic.file, 'components/mutated.jsails');
        for (const fixEdit of diagnostic.fix?.edits ?? []) {
          assert.ok(
            fixEdit.start >= 0 && fixEdit.start <= fixEdit.end && fixEdit.end <= file.length,
          );
        }
      }
    }
  });
});
