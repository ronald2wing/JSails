/**
 * Seeded property tests for the HTML escaping paths: `Str.escapeHtml` /
 * `Str.unescapeHtml`, Preact text and attribute escaping behind
 * `renderToString`, and the `</script>`-safe `serializeJsonLd`.
 *
 * Inputs come from a small deterministic PRNG (mulberry32) biased toward
 * markup metacharacters, entity fragments, control and bidi characters, lone
 * surrogates, and astral code points, so every run is reproducible and a
 * failure names the seed that produced it. No property-testing dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToString } from '../../src/jsx/render-to-string.js';
import { serializeJsonLd } from '../../src/seo/json-ld.js';
import { escapeHtml, unescapeHtml } from '../../src/support/strings.js';

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

const BASE_SEED = 0x6a5a_1001;
const RUNS = 400;

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
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  text(maxParts?: number): string;
}

const FRAGMENTS: readonly string[] = [
  '<',
  '>',
  '&',
  '"',
  "'",
  '`',
  '=',
  '/',
  '\\',
  ' ',
  '\t',
  '\n',
  '\r',
  '\0',
  ' ',
  ' ',
  '﻿',
  '‮',
  '\u0085',
  '\ud800',
  '\udfff',
  '😀',
  'é',
  'a',
  'Z',
  '0',
  '&amp;',
  '&lt;',
  '&#39;',
  '&#x27;',
  '&quot;',
  '&',
  '&#',
  '<script>',
  '</script>',
  '<!--',
  '-->',
  ']]>',
  'onerror=',
  'javascript:',
  '<img src=x>',
  '{{',
  '${',
  '</title>',
];

function generator(seed: number): Gen {
  const next = mulberry32(seed);
  const gen: Gen = {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    text: (maxParts = 12) => {
      let out = '';
      const parts = gen.int(0, maxParts);
      for (let i = 0; i < parts; i += 1) {
        out += next() < 0.8 ? gen.pick(FRAGMENTS) : String.fromCodePoint(gen.int(0, 0x2ffff));
      }
      return out;
    },
  };
  return gen;
}

/** Run `check` against `RUNS` seeded cases, naming the failing seed. */
function forAll(check: (gen: Gen) => void, seed = BASE_SEED): void {
  for (let run = 0; run < RUNS; run += 1) {
    const caseSeed = (seed + run) >>> 0;
    try {
      check(generator(caseSeed));
    } catch (error) {
      assert.fail(`property failed for seed ${caseSeed}: ${(error as Error).message}`);
    }
  }
}

/** Decode the entities an HTML parser would, enough to recover escaped text. */
function decodeEntities(html: string): string {
  return html.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi,
    (_m, dec, hex, name) => {
      if (dec !== undefined) return String.fromCodePoint(Number(dec));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex as string, 16));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[(name as string).toLowerCase()]!;
    },
  );
}

// ---------------------------------------------------------------------------
// Str.escapeHtml
// ---------------------------------------------------------------------------

describe('property: Str.escapeHtml', () => {
  it('never emits a raw markup metacharacter', () => {
    forAll((gen) => {
      const escaped = escapeHtml(gen.text());
      assert.doesNotMatch(escaped, /[<>"']/);
    });
  });

  it('emits & only as the start of one of its five entities', () => {
    forAll((gen) => {
      const escaped = escapeHtml(gen.text());
      assert.equal(escaped.replace(/&(?:amp|lt|gt|quot|#39);/g, '').includes('&'), false);
    });
  });

  it('round-trips through unescapeHtml exactly', () => {
    forAll((gen) => {
      const input = gen.text();
      assert.equal(unescapeHtml(escapeHtml(input)), input);
    });
  });

  it('is what an HTML parser decodes back to the input', () => {
    forAll((gen) => {
      const input = gen.text();
      assert.equal(decodeEntities(escapeHtml(input)), input);
    });
  });

  it('changes only the five metacharacters', () => {
    forAll((gen) => {
      const input = gen.text();
      const stripped = input.replace(/[&<>"']/g, '');
      assert.equal(escapeHtml(input).replace(/&(?:amp|lt|gt|quot|#39);/g, ''), stripped);
    });
  });
});

// ---------------------------------------------------------------------------
// JSX renderToString
// ---------------------------------------------------------------------------

describe('property: renderToString text and attribute escaping', () => {
  it('keeps arbitrary text inside its element and recoverable', () => {
    forAll((gen) => {
      const text = gen.text();
      const html = renderToString(<p>{text}</p>);
      const match = /^<p>([^<]*)<\/p>$/.exec(html);
      assert.ok(match, `text broke out of its element: ${JSON.stringify(html)}`);
      assert.equal(decodeEntities(match[1]!), text);
    });
  });

  it('keeps arbitrary attribute values inside their quotes and recoverable', () => {
    forAll((gen) => {
      const title = gen.text();
      const id = gen.text(4);
      const html = renderToString(<div title={title} data-x={id} />);
      // Preact renders an empty string value as a bare boolean-style attribute.
      const match = /^<div title(?:="([^"]*)")? data-x(?:="([^"]*)")?><\/div>$/.exec(html);
      assert.ok(match, `attribute broke out of its quotes: ${JSON.stringify(html)}`);
      assert.doesNotMatch(match[1] ?? '', /</);
      assert.equal(decodeEntities(match[1] ?? ''), title);
      assert.equal(decodeEntities(match[2] ?? ''), id);
    });
  });

  it('never lets a child string open a tag', () => {
    forAll((gen) => {
      const parts = [gen.text(), gen.text(), gen.text()];
      const html = renderToString(
        <ul>
          {parts.map((part, index) => (
            <li key={index}>{part}</li>
          ))}
        </ul>,
      );
      const tags = html.match(/<\/?[a-z][^>]*>/gi) ?? [];
      assert.deepEqual(
        tags.map((tag) => tag.replace(/\s.*$/, '>')),
        ['<ul>', '<li>', '</li>', '<li>', '</li>', '<li>', '</li>', '</ul>'],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/** A random JSON value biased toward strings that try to close the script. */
function jsonValue(gen: Gen, depth = 0): unknown {
  const kind = depth > 3 ? gen.int(0, 3) : gen.int(0, 5);
  switch (kind) {
    case 0:
      return gen.text();
    case 1:
      return gen.int(-1e6, 1e6);
    case 2:
      return gen.pick([true, false, null]);
    case 3:
      return `${gen.text(3)}</script>${gen.text(3)}`;
    case 4: {
      const out: unknown[] = [];
      for (let i = gen.int(0, 4); i > 0; i -= 1) out.push(jsonValue(gen, depth + 1));
      return out;
    }
    default: {
      const out: Record<string, unknown> = {};
      for (let i = gen.int(0, 4); i > 0; i -= 1) out[gen.text(3)] = jsonValue(gen, depth + 1);
      return out;
    }
  }
}

describe('property: serializeJsonLd', () => {
  it('never contains a raw < and parses back to the same value', () => {
    forAll((gen) => {
      const value = { '@context': 'https://schema.org', '@type': 'Thing', data: jsonValue(gen) };
      const serialized = serializeJsonLd(value);
      assert.equal(serialized.includes('<'), false);
      assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(value)));
    });
  });
});
