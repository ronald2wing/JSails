/**
 * Seeded property tests for `parseFrontmatter`.
 *
 * Documents are assembled by a small deterministic PRNG (mulberry32) from
 * delimiter variants (`---`, `...`, CRLF, BOM, trailing spaces), YAML lines
 * that target prototype handling (`__proto__`, `constructor`, merge keys),
 * anchor/alias expansion, tags, non-mapping roots, and Markdown body text. The
 * properties: parsing either returns a plain mapping plus the body or throws
 * the value-free `FrontmatterError` (never a raw YAML or type error), a body
 * without a leading block is returned untouched, and nothing ever reaches
 * `Object.prototype`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FrontmatterError, parseFrontmatter } from '../../src/support/frontmatter.server.js';

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

const BASE_SEED = 0xf407_5001;
const RUNS = 800;

/** mulberry32: a tiny, well-distributed 32-bit PRNG; same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  chance(p: number): boolean;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

function generator(seed: number): Gen {
  const next = mulberry32(seed);
  return {
    chance: (p) => next() < p,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

function forAll(check: (gen: Gen) => void): void {
  for (let run = 0; run < RUNS; run += 1) {
    const caseSeed = (BASE_SEED + run) >>> 0;
    try {
      check(generator(caseSeed));
    } catch (error) {
      assert.fail(`property failed for seed ${caseSeed}: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const PLANTED = 'PLANTEDFRONTMATTER';

const YAML_LINES = [
  'title: Hello',
  `secret: ${PLANTED}`,
  '__proto__:\n  polluted: true',
  '"__proto__": {polluted: true}',
  'constructor:\n  prototype:\n    polluted: true',
  '<<: {polluted: true}',
  'base: &base {polluted: true}\nchild:\n  <<: *base',
  'list: [1, 2, 3',
  'a: &a [x, x, x]\nb: &b [*a, *a, *a]\nc: &c [*b, *b, *b]\nd: &d [*c, *c, *c]\ne: [*d, *d, *d]',
  'date: 2024-01-01',
  'tagged: !!js/function "function(){}"',
  'tagged: !!binary aGVsbG8=',
  'key: "unterminated',
  '- just\n- a\n- list',
  'plain scalar',
  'null',
  '42',
  '\t: tab-indented',
  'dup: 1\ndup: 2',
  `long: ${'z'.repeat(2000)}`,
  'emoji: 😀',
  'ends-with: ...',
  'dashes: ---',
];

const OPENERS = ['---', '---', '---  ', '--- \t', '----', '-- -'];
const CLOSERS = ['---', '---', '...', '---   ', '--- x', '----', ''];
const NEWLINES = ['\n', '\n', '\r\n'];
const BODIES = [
  '',
  '# Heading\n\nText',
  '---\nnot frontmatter\n---',
  '...',
  `body ${PLANTED}`,
  '\n\n',
];

function documentText(gen: Gen): string {
  const nl = gen.pick(NEWLINES);
  const bom = gen.chance(0.1) ? '﻿' : '';
  if (gen.chance(0.15)) return bom + gen.pick(BODIES);
  const lines: string[] = [];
  for (let i = gen.int(0, 4); i > 0; i -= 1) lines.push(gen.pick(YAML_LINES).replace(/\n/g, nl));
  const closer = gen.pick(CLOSERS);
  const block = [gen.pick(OPENERS), ...lines, ...(closer === '' ? [] : [closer])].join(nl);
  return `${bom}${block}${nl}${gen.pick(BODIES)}`;
}

function assertPrototypeClean(): void {
  const probe: Record<string, unknown> = {};
  assert.equal(probe.polluted, undefined, 'Object.prototype was polluted');
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: parseFrontmatter', () => {
  it('returns a plain mapping and body, or throws a value-free FrontmatterError', () => {
    let parsed = 0;
    let rejected = 0;
    forAll((gen) => {
      const input = documentText(gen);
      let result: ReturnType<typeof parseFrontmatter>;
      try {
        result = parseFrontmatter(input);
      } catch (error) {
        assert.ok(error instanceof FrontmatterError, `unexpected ${String(error)}`);
        assert.equal(error.code, 'invalid_argument');
        assert.ok(!error.message.includes(PLANTED), 'the error echoed document text');
        rejected += 1;
        return;
      }
      parsed += 1;
      assert.ok(result.data !== null && typeof result.data === 'object');
      assert.ok(!Array.isArray(result.data));
      assert.equal(Object.getPrototypeOf(result.data), Object.prototype);
      assert.equal(typeof result.content, 'string');
      const source = input.startsWith('﻿') ? input.slice(1) : input;
      assert.ok(source.endsWith(result.content), 'content is a suffix of the document');
      assertPrototypeClean();
    });
    assert.ok(parsed > RUNS / 10 && rejected > RUNS / 10, `${parsed} parsed, ${rejected} rejected`);
  });

  it('returns a document without a leading block untouched', () => {
    forAll((gen) => {
      const body = gen.pick(BODIES.filter((text) => !text.startsWith('---')));
      const input = `${gen.pick(['', 'x', '# ', ' '])}${body}${gen.pick(['', '\n---\na: 1\n---'])}`;
      if (input.startsWith('---')) return;
      assert.deepEqual(parseFrontmatter(input), { data: {}, content: input });
    });
  });

  it('throws FrontmatterError, not TypeError, for a non-string input', () => {
    const inputs: readonly unknown[] = [undefined, null, 42, {}, [], Buffer.from('---\na: 1\n---')];
    for (const input of inputs) {
      assert.throws(() => parseFrontmatter(input as string), FrontmatterError);
    }
  });
});
