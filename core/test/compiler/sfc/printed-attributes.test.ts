/**
 * Tests for the canonical form of the static attribute values Prettier reprints: unit cases for `class`, `style`, `srcset` and `allow`, the `style` values reported unstable, and a seeded sweep that formats generated values with the installed Prettier and checks each output reduces to its input's form.
 *
 * The style sweep costs about 13 ms of Prettier per seed, so a local run
 * takes the first 300 seeds of each set and a CI run, or one with
 * `JSAILS_TEST_FULL_PROPERTY=1`, takes 1,000, as grammar-property.test.ts
 * does. Every set starts at its own fixed seed, so a failure names a seed
 * that reproduces it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as prettier from 'prettier';

import { printedAttributeValue } from '../../../src/compiler/sfc/printed-attributes.js';

/** The canonical form of a stable value. */
function canonical(tag: string, name: string, value: string): string {
  const printed = printedAttributeValue(tag, name, value);
  assert.equal(printed.unstable, false, `${name}="${value}" is stable`);
  return printed.value;
}

describe('printedAttributeValue', () => {
  it('trims a class and writes each whitespace run as one space', () => {
    assert.equal(canonical('div', 'class', '  card\n   wide\tshadow '), 'card wide shadow');
    assert.equal(canonical('Card', 'class', ''), '');
  });

  it('writes allow directives `a b; c`, on an iframe only', () => {
    assert.equal(
      canonical('iframe', 'allow', " fullscreen;autoplay  'self' ;;camera\n https://a.example;"),
      "fullscreen; autoplay 'self'; camera https://a.example",
    );
    assert.equal(canonical('div', 'allow', 'a;b'), 'a;b');
  });

  it('writes srcset candidates `url descriptor, …`, on img and source only', () => {
    const cases: readonly [string, string][] = [
      ['/a.png 1x,/b.png   2x', '/a.png 1x, /b.png 2x'],
      [' a.png\n 0100w , b.png 200w ', 'a.png 100w, b.png 200w'],
      ['a.png 1.50x, b.png 0x', 'a.png 1.5x, b.png'],
      ['a.png, c,d.png 2x', 'a.png, c,d.png 2x'],
      ['a.png 1x, b.png 100w', 'a.png 1x, b.png 100w'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(canonical('img', 'srcset', value), expected, value);
      assert.equal(canonical('source', 'srcset', value), expected, value);
    }
    assert.equal(canonical('link', 'srcset', 'a.png 1x,b.png  2x'), 'a.png 1x,b.png  2x');
  });

  it('writes a style as `property: value` declarations joined by `; `', () => {
    const cases: readonly [string, string][] = [
      ['COLOR:#FFAA00;margin:.50EM 0;;', 'color: #ffaa00; margin: 0.5em 0'],
      ['--Accent:#FFF;--empty:', '--Accent: #fff; --empty:'],
      ['color:red /* note */ ;margin:/*c*/0', 'color: red; margin: 0'],
      [
        'transition:opacity .30s ease,transform 1.0S',
        'transition: opacity 0.3s ease, transform 1s',
      ],
      ["font:12px/1.5 'Helvetica Neue',Arial", "font: 12px/1.5 'Helvetica Neue', Arial"],
      [`content:"it's";quotes:'say "hi"'`, `content: "it's"; quotes: 'say "hi"'`],
      ['width:calc( 100% - 2*var(--gap,8px) )', 'width: calc(100% - 2 * var(--gap, 8px))'],
      [
        'background:URL( "a b.png" ) no-repeat center / cover',
        "background: url('a b.png') no-repeat center/cover",
      ],
      ['background:url(data:image/png;base64,AA==)', 'background: url(data:image/png;base64,AA==)'],
      ['color:red ! IMPORTANT', 'color: red !important'],
      ['display:INHERIT;margin:-0.0px 1E3px', 'display: inherit; margin: 0px 1000px'],
      [
        'grid-area:1/span 2;grid-template-columns:[ a b ] 1fr',
        'grid-area: 1/span 2; grid-template-columns: [a b] 1fr',
      ],
      ['font:12px / calc(1em + 2px) serif', 'font: 12px/calc(1em + 2px) serif'],
      ['', ''],
    ];
    for (const [value, expected] of cases) {
      assert.equal(canonical('div', 'style', value), expected, value);
    }
  });

  it('reports a style Prettier would change the meaning of as unstable, keeping its value', () => {
    for (const value of [
      'x: a\\ b',
      'x: a\\,b',
      'margin: +1px',
      'width: 1e+2px',
      'margin: 0 !important auto',
      'background: url(a b)',
      'background: url(a.png)/cover',
      'font: 12px/calc(1em + 2px) serif',
      'width: calc(1px+2px)',
      'width: calc(1px -2px)',
      'a: b + c',
      'x: {a}',
      'x: @a',
      'a: b > c',
      'color red',
      'c',
      'content: "a',
      'width: calc(1px',
      'width: 1px)',
    ]) {
      assert.deepEqual(
        printedAttributeValue('div', 'style', value),
        { value, unstable: true },
        value,
      );
    }
  });

  it('keeps every other attribute as written', () => {
    assert.equal(canonical('div', 'title', '  a   b '), '  a   b ');
    assert.equal(canonical('div', 'onclick', "track( 'x' )"), "track( 'x' )");
  });
});

/** mulberry32: a small deterministic PRNG, so every failure names a reproducible seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

function pick<T>(next: Random, pool: readonly T[]): T {
  return pool[Math.floor(next() * pool.length)] as T;
}

const SPACE = ['', '', ' ', '  ', '\n   ', '\t'];
const SEPARATOR = [' ', ' ', '  ', '\n  ', '\t', ' /* c */ ', '/*c*/'];
const IDENTS = [
  'red',
  'RED',
  'Auto',
  'inherit',
  'INHERIT',
  'unset',
  'Revert-Layer',
  'solid',
  'ease-in-out',
  '-webkit-box',
  'a1',
  'serif',
  'sans-serif',
  'center',
  'currentColor',
];
const NUMBERS = ['0', '1', '.5', '0.50', '1.0', '-2', '1e3', '1E2', '00.5', '-0.0', '1e-7', '-.5'];
const UNITS = [
  '',
  'px',
  'PX',
  'em',
  'Em',
  '%',
  'deg',
  'ms',
  's',
  'kHz',
  'KHZ',
  'q',
  'Q',
  'fr',
  'x',
  'dppx',
];
const STRINGS = [
  '"a b"',
  "'a b'",
  '"it\'s"',
  '\'say "hi"\'',
  '"a\\"b"',
  "'a\\'b'",
  '""',
  '"\\41"',
  '"a;b"',
  '"a,b"',
  '"/*x*/"',
  '"a:b"',
  '"(x)"',
  '"a\\\\b"',
];
const URLS = [
  'url(a.png)',
  'url( a.png )',
  'url(data:image/png;base64,AA==)',
  'url("a b.png")',
  "URL('x')",
  'url(/img/a%20b.png?x=1&y=2)',
];
const HASHES = ['#ABC', '#abcdef', '#AbCdEf12', '#FfFf', '#12'];
const FUNCTIONS = [
  'rgb',
  'RGBA',
  'var',
  'translate',
  'linear-gradient',
  'minmax',
  'repeat',
  'attr',
  'Scale',
];
const MATH = ['calc', 'min', 'max', 'clamp', 'Calc', 'round', 'mod'];
const PROPERTIES = [
  'color',
  'COLOR',
  'Margin',
  'background',
  'transition',
  'grid-template-columns',
  'font',
  'box-shadow',
  'width',
  '--Custom',
  '--x',
  'content',
  'grid-area',
  'Background-Image',
];

/** A component value that is not a call. */
function word(next: Random): string {
  const kind = next();
  if (kind < 0.25) return pick(next, IDENTS);
  if (kind < 0.55) return pick(next, NUMBERS) + pick(next, UNITS);
  if (kind < 0.67) return pick(next, STRINGS);
  if (kind < 0.77) return pick(next, HASHES);
  if (kind < 0.85) return pick(next, URLS);
  return `[${pick(next, SPACE)}${pick(next, ['full-start', 'a b'])}${pick(next, SPACE)}]`;
}

function component(next: Random, depth: number): string {
  const kind = next();
  if (depth < 2 && kind < 0.15) return call(next, depth, pick(next, FUNCTIONS), false);
  if (depth < 2 && kind < 0.25) return call(next, depth, pick(next, MATH), true);
  return word(next);
}

function call(next: Random, depth: number, name: string, math: boolean): string {
  const args: string[] = [];
  for (let count = 1 + Math.floor(next() * 3); count > 0; count -= 1) {
    args.push(math ? sum(next, depth + 1) : list(next, depth + 1));
  }
  const comma = pick(next, [',', ', ', ' , ', ',\n']);
  return `${name}(${pick(next, SPACE)}${args.join(comma)}${pick(next, SPACE)})`;
}

const startsCall = (text: string): boolean => /^[A-Za-z-]*\(/.test(text);

/** A math expression, written within the stable subset: `+` and `-` spaced, `/` spaced at a call. */
function sum(next: Random, depth: number): string {
  let out = component(next, depth);
  for (let count = Math.floor(next() * 3); count > 0; count -= 1) {
    const operator = pick(next, ['+', '-', '*', '/']);
    const operand = component(next, depth).replace(/^-(?=[\d.])/, '');
    let space =
      operator === '+' || operator === '-' ? pick(next, [' ', '  ', '\n ']) : pick(next, ['', ' ']);
    if (operator === '/' && space === '' && (startsCall(operand) || out.endsWith(')'))) space = ' ';
    out += space + operator + space + operand;
  }
  return depth < 3 && next() < 0.2 ? `(${pick(next, SPACE)}${out}${pick(next, SPACE)})` : out;
}

function list(next: Random, depth: number): string {
  let out = component(next, depth);
  for (let count = Math.floor(next() * 4); count > 0; count -= 1) {
    const kind = next();
    const value = component(next, depth);
    if (kind < 0.65) {
      out += pick(next, SEPARATOR) + value;
    } else if (kind < 0.85) {
      out += pick(next, [',', ', ', ' ,', ',\n']) + value;
    } else if (startsCall(value) || out.endsWith(')')) {
      out += pick(next, [' / ', '  /\n ']) + value;
    } else {
      out += pick(next, ['/', ' / ', '/ ', ' /']) + value;
    }
  }
  return out;
}

function style(next: Random): string {
  const declarations: string[] = [];
  for (let count = 1 + Math.floor(next() * 4); count > 0; count -= 1) {
    const important =
      next() < 0.15
        ? `${pick(next, ['', ' '])}!${pick(next, ['', ' '])}${pick(next, ['important', 'IMPORTANT'])}`
        : '';
    declarations.push(
      `${pick(next, SPACE)}${pick(next, PROPERTIES)}${pick(next, ['', ' '])}:${pick(next, SPACE)}${list(next, 0)}${important}${pick(next, SPACE)}`,
    );
  }
  return declarations.join(pick(next, [';', '; ', ';;', ' ;\n'])) + pick(next, ['', ';', '; ']);
}

function classList(next: Random): string {
  const names = [
    'card',
    'w-full',
    'sm:grid-cols-2',
    'text-base-content/60',
    'a b',
    '[&>p]:mt-2',
    'a-long-class-name-to-wrap',
  ];
  const out: string[] = [];
  for (let count = 1 + Math.floor(next() * 5); count > 0; count -= 1) out.push(pick(next, names));
  return pick(next, SPACE) + out.join(pick(next, [' ', '\n  ', '  '])) + pick(next, SPACE);
}

function srcset(next: Random): string {
  const descriptor = pick(next, ['w', 'x', 'h', 'mixed', 'none']);
  const candidates: string[] = [];
  for (let count = 1 + Math.floor(next() * 4); count > 0; count -= 1) {
    const url = pick(next, [
      '/a.png',
      '/a/long/path/to/an/image-version.webp',
      'c,d.png',
      '/e.png?x=1,2',
    ]);
    const value =
      descriptor === 'w'
        ? pick(next, ['100w', '0100w', '480w'])
        : descriptor === 'x'
          ? pick(next, ['1x', '1.50x', '0x', '-1x', '1e1x', '.5x'])
          : descriptor === 'h'
            ? '100h'
            : descriptor === 'mixed'
              ? pick(next, ['1x', '100w'])
              : '';
    candidates.push(
      `${pick(next, SPACE)}${url}${value === '' ? '' : pick(next, [' ', '   ', '\n ']) + value}`,
    );
  }
  return candidates.join(pick(next, [',', ', ', ' ,', ',,']));
}

function allow(next: Random): string {
  const directives = [
    'fullscreen',
    "autoplay 'self'",
    'camera https://a.example https://b.example.com',
    'microphone  *',
  ];
  const out: string[] = [];
  for (let count = 1 + Math.floor(next() * 4); count > 0; count -= 1)
    out.push(pick(next, directives));
  return out.join(pick(next, [';', '; ', ' ;  ', ';\n', ';;'])) + pick(next, ['', ';', ' ']);
}

type Case = readonly [tag: string, name: string, value: string];

const GENERATORS: readonly ((next: Random) => Case)[] = [
  (next) => ['div', 'style', style(next)],
  (next) => [pick(next, ['div', 'Card']), 'class', classList(next)],
  (next) => [pick(next, ['img', 'source']), 'srcset', srcset(next)],
  (next) => ['iframe', 'allow', allow(next)],
];

/** Whether CI is set, read the way the bench gate reads it: anything but empty, `false` or `0`. */
function onCi(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

const SEEDS = onCi(process.env) || process.env.JSAILS_TEST_FULL_PROPERTY === '1' ? 1_000 : 300;
const BATCH = 100;

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const encode = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Format `cases` in one file at `depth` and read each printed value back, in order. */
async function printed(
  cases: readonly Case[],
  options: { readonly printWidth: number; readonly singleQuote: boolean; readonly depth: number },
): Promise<string[]> {
  const open = '<div>'.repeat(options.depth);
  const close = '</div>'.repeat(options.depth);
  const body = cases
    .map(([tag, name, value]) => {
      const end = tag === 'img' || tag === 'source' ? ' />' : `></${tag}>`;
      return `${open}<${tag} ${name}="${encode(value)}"${end}${close}`;
    })
    .join('\n');
  const output = await prettier.format(`<template>\n${body}\n</template>\n`, {
    parser: 'vue',
    printWidth: options.printWidth,
    singleQuote: options.singleQuote,
  });
  return [...output.matchAll(/ (?:class|style|srcset|allow)=(?:"([^"]*)"|'([^']*)')/g)].map(
    (match) => decode(match[1] ?? match[2] ?? ''),
  );
}

describe('generated values formatted with Prettier', () => {
  for (const [index, generate] of GENERATORS.entries()) {
    const name = generate(random(0))[1];
    it(`reduce to the form of their input: ${name} (${SEEDS} seeds)`, async () => {
      for (let first = index * 1_000_000; first < index * 1_000_000 + SEEDS; first += BATCH) {
        const cases: Case[] = [];
        for (let seed = first; seed < first + BATCH; seed += 1) cases.push(generate(random(seed)));
        const expected = cases.map(([tag, attribute, value]) => canonical(tag, attribute, value));
        for (const printWidth of [100, 30]) {
          for (const singleQuote of [true, false]) {
            for (const depth of [0, 5]) {
              const values = await printed(cases, { printWidth, singleQuote, depth });
              assert.equal(values.length, cases.length);
              values.forEach((value, offset) => {
                const [tag, attribute, input] = cases[offset] as Case;
                assert.deepEqual(
                  printedAttributeValue(tag, attribute, value),
                  { value: expected[offset], unstable: false },
                  `seed ${first + offset} at width ${printWidth}, depth ${depth}: ${JSON.stringify(input)}`,
                );
              });
            }
          }
        }
      }
    });
  }
});
