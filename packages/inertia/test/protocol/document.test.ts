/**
 * The full-page document (P-2 HTML Responses; clause numbering as in
 * props.test.ts): the `<script data-page type="application/json">` block, the
 * upstream escaping, asset and head inputs, the SSR body pass-through, and a
 * seeded property test that happy-dom's parser plus @inertiajs/core 3.11.0's
 * own `getInitialPageFromDOM` read back exactly the page that was built.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Window } from 'happy-dom';

import {
  buildDocument,
  escapeScriptJson,
  InertiaError,
  pageDataBlock,
  serializePage,
  type InertiaPageObject,
} from '../../src/index.js';

const PAGE: InertiaPageObject = {
  component: 'Event',
  props: { errors: {}, event: { id: 80, title: 'Birthday party' } },
  url: '/events/80',
  version: 'c32b8e49',
};

function invalidOptions(error: unknown): boolean {
  return error instanceof InertiaError && error.code === 'invalid_options';
}

describe('buildDocument', () => {
  it('embeds the page in a script element before the root element (protocol example)', () => {
    assert.equal(
      buildDocument({ page: PAGE }),
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' +
        '<script data-page="app" type="application/json">' +
        '{"component":"Event","props":{"errors":{},"event":{"id":80,"title":"Birthday party"}},' +
        '"url":"\\/events\\/80","version":"c32b8e49"}</script><div id="app"></div></body></html>',
    );
  });

  it('renders lang, nonce, assets, and head strings in a fixed order', () => {
    const html = buildDocument({
      page: PAGE,
      rootId: 'root',
      lang: 'en-GB',
      nonce: 'r4nd0m+/=',
      head: ['<title inertia>Event</title>'],
      assets: {
        styles: ['/assets/app.css'],
        preloads: ['/assets/chunk.js'],
        scripts: ['/assets/app.js?v="1"&x=<y>'],
      },
    });
    assert.equal(
      html.slice(0, html.indexOf('<body>')),
      '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/assets/app.css" nonce="r4nd0m+/=">' +
        '<link rel="modulepreload" href="/assets/chunk.js" nonce="r4nd0m+/=">' +
        '<title inertia>Event</title>' +
        '<script type="module" src="/assets/app.js?v=&quot;1&quot;&amp;x=&lt;y&gt;" nonce="r4nd0m+/="></script>' +
        '</head>',
    );
    assert.match(
      html,
      /<script data-page="root" type="application\/json">.*<\/script><div id="root"><\/div>/u,
    );
    assert.equal(html.includes('<script data-page="root" type="application/json" nonce'), false);
  });

  it('passes an SSR body through in place of the data block and root element', () => {
    const ssrBody =
      '<script data-page="app" type="application/json">{}</script><div data-server-rendered="true" id="app"><h1>Hi</h1></div>';
    const html = buildDocument({ page: PAGE, ssrBody });
    assert.ok(html.endsWith(`<body>${ssrBody}</body></html>`));
  });

  it('rejects an unsafe root id, language, nonce, or asset URL', () => {
    const cases = [
      { rootId: 'app"><script>' },
      { rootId: '1app' },
      { lang: 'en"' },
      { nonce: 'a b' },
      { assets: { scripts: [''] } },
      { assets: { scripts: '/app.js' as unknown as string[] } },
      { assets: { styles: [7 as unknown as string] } },
      { assets: [] as unknown as { scripts: string[] } },
    ];
    for (const options of cases) {
      assert.throws(() => buildDocument({ page: PAGE, ...options }), invalidOptions);
    }
    assert.throws(() => pageDataBlock(PAGE, 'bad id'), invalidOptions);
  });
});

describe('script-block escaping', () => {
  it('escapes / and < as upstream buildSSRBody does, so </script> never occurs', () => {
    const hostile: InertiaPageObject = {
      ...PAGE,
      props: { errors: {}, bio: '</script><script>alert(1)</script><!-- </SCRIPT >' },
    };
    const block = pageDataBlock(hostile);
    assert.equal(block.match(/<\/script/giu)?.length, 1);
    assert.equal(block.includes('<!--'), false);
    assert.equal(escapeScriptJson('{"a":"</script>"}'), '{"a":"\\u003c\\/script>"}');
  });

  it('escapes U+2028 and U+2029 and keeps them in the parsed value', () => {
    const json = escapeScriptJson(
      serializePage({ ...PAGE, props: { errors: {}, s: 'a\u2028b\u2029c' } }),
    );
    assert.equal(json.includes('\u2028'), false);
    assert.equal(json.includes('\u2029'), false);
    assert.equal((JSON.parse(json) as { props: { s: string } }).props.s, 'a\u2028b\u2029c');
  });

  it('uses no HTML entities inside the block', () => {
    const block = pageDataBlock({ ...PAGE, props: { errors: {}, q: '"&amp;\'' } });
    assert.match(block, /"q":"\\"&amp;'"/u);
  });
});

// ---------------------------------------------------------------------------
// Property test against happy-dom and @inertiajs/core getInitialPageFromDOM
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  '</script>',
  '</SCRIPT',
  '<!--',
  '-->',
  '<script>',
  '\u2028',
  '\u2029',
  '&amp;',
  '&lt;',
  '"',
  "'",
  '\\',
  '/',
  ']]>',
  '😀',
  'text',
];

function hostileString(random: () => number): string {
  const parts = Math.floor(random() * 5);
  let text = '';
  for (let index = 0; index < parts; index += 1) {
    text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
  }
  return text;
}

function hostileTree(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth < 3 && roll < 0.3) {
    const tree: Record<string, unknown> = {};
    const size = Math.floor(random() * 4);
    for (let index = 0; index < size; index += 1) {
      tree[`${hostileString(random)}${index}`] = hostileTree(random, depth + 1);
    }
    return tree;
  }
  if (depth < 3 && roll < 0.45) {
    return Array.from({ length: Math.floor(random() * 4) }, () => hostileTree(random, depth + 1));
  }
  if (roll < 0.55) return Math.floor(random() * 1000);
  if (roll < 0.6) return null;
  return hostileString(random);
}

describe('document property test (happy-dom + getInitialPageFromDOM)', () => {
  const window = new Window({ url: 'https://example.test/' });
  let getInitialPageFromDOM: (id: string) => unknown;

  before(async () => {
    Object.defineProperty(globalThis, 'window', {
      value: window,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: window.document,
      configurable: true,
      writable: true,
    });
    ({ getInitialPageFromDOM } = await import('@inertiajs/core'));
  });

  after(async () => {
    await window.happyDOM.close();
  });

  it('boots the exact page from every generated document', () => {
    const SEED = 0xd0c_2026;
    const random = prng(SEED);
    const parser = new window.DOMParser();
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const page: InertiaPageObject = {
        component: 'Fuzz',
        props: { errors: {}, data: hostileTree(random, 0), title: hostileString(random) },
        url: `/fuzz/${iteration}?q=${encodeURIComponent(hostileString(random))}`,
        version: 'v1',
        flash: { notice: hostileString(random) },
      };
      const html = buildDocument({ page, rootId: 'app' });
      const label = `seed ${SEED} iteration ${iteration}`;
      const block = html.slice(html.indexOf('<body>'), html.indexOf('<div id="app">'));
      assert.equal(block.toLowerCase().split('</script').length, 2, label);
      const parsed = parser.parseFromString(html, 'text/html');
      Object.defineProperty(globalThis, 'document', {
        value: parsed,
        configurable: true,
        writable: true,
      });
      assert.deepEqual(getInitialPageFromDOM('app'), JSON.parse(serializePage(page)), label);
      assert.ok(parsed.getElementById('app'), label);
    }
  });
});
