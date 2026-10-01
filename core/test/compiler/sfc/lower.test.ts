/**
 * Tests for lowerSfc over the function kinds (the live kind has `live.test.ts`): every page, layout, error and view of the corpus lowers to a shadow that renders the expected HTML, the shadow is deterministic and fully mapped, generated functions carry explicit return types and `async` only when setup awaits, and each kind rule is a positioned diagnostic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SfcDiagnosticCode } from '../../../src/compiler/sfc/diagnostics.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { nameTable } from '../../../src/compiler/sfc/name-resolver.js';
import { SpanKind } from '../../../src/compiler/sfc/segments.js';
import { scopeMarker, sfcScopeId } from '../../../src/compiler/sfc/style.js';
import { SERVER_ONLY, type RenderChild } from '../../../src/contracts/component.js';
import { Fragment, jsx } from '../../../src/jsx/jsx-runtime.js';
import { renderToString } from '../../../src/jsx/render-to-string.js';
import { compileFixtureApp, type FixtureFile } from './compiled-fixture.js';
import { CORPUS_APP, CORPUS_RESOLVER, SFC_CORPUS } from './corpus.js';

/** The scope marker of the component at `file`, as its outermost elements carry it. */
function marker(file: string): string {
  return scopeMarker(sfcScopeId(file));
}

const SHELL = marker('ui/shell.jsails');
const POST = marker('pages/blog/[slug].jsails');
const BADGE = marker('ui/tag-badge.jsails');
const CARD = marker('ui/card.jsails');
const LIST = marker('ui/post-list.jsails');

function lowerCorpus(): readonly SfcLowering[] {
  return SFC_CORPUS.map((file) => lowerSfc(file.source, file.path, { resolver: CORPUS_RESOLVER }));
}

function codes(lowering: SfcLowering): readonly SfcDiagnosticCode[] {
  return lowering.diagnostics.map((entry) => entry.code);
}

/** Lower one file and return its diagnostic codes. */
function diagnose(source: string, file = 'ui/view.jsails'): readonly SfcDiagnosticCode[] {
  return codes(lowerSfc(source, file, { resolver: CORPUS_RESOLVER }));
}

/** The source text a diagnostic of `code` underlines. */
function underlined(source: string, code: SfcDiagnosticCode, file = 'ui/view.jsails'): string {
  const entry = lowerSfc(source, file, { resolver: CORPUS_RESOLVER }).diagnostics.find(
    (diagnostic) => diagnostic.code === code,
  );
  assert.ok(entry !== undefined, `expected ${code}`);
  return source.slice(entry.start, entry.end);
}

/** The HTML of a rendered child, which may be text or a list as well as an element. */
function html(child: unknown): string {
  return renderToString(jsx(Fragment, { children: child as RenderChild }));
}

type Render = (props: unknown, context?: unknown) => RenderChild | Promise<RenderChild>;
type LoadedModule = Record<string, unknown>;

function component(module: LoadedModule | undefined): Render {
  assert.ok(module !== undefined);
  return module['default'] as Render;
}

/** Compile `files` into a fixture app and import the modules of `paths`. */
async function loadModules(
  files: readonly FixtureFile[],
  paths: readonly string[],
): Promise<ReadonlyMap<string, LoadedModule>> {
  const app = compileFixtureApp(files, { resolver: CORPUS_RESOLVER });
  try {
    const modules = new Map<string, LoadedModule>();
    for (const path of paths) modules.set(path, await app.load(path));
    return modules;
  } finally {
    app.dispose();
  }
}

function lowered(path: string): SfcLowering {
  const lowering = lowerCorpus().find((entry) => entry.file === path);
  assert.ok(lowering !== undefined, path);
  return lowering;
}

const context = (pathname: string): unknown => ({
  url: new URL(`http://localhost${pathname}`),
  params: { slug: 'hello' },
});

describe('lowerSfc corpus', () => {
  it('lowers every page, layout, error and view without a diagnostic', () => {
    for (const lowering of lowerCorpus()) {
      assert.deepEqual(lowering.diagnostics, [], lowering.file);
      assert.ok(lowering.shadow !== null, lowering.file);
      assert.equal(lowering.tsx, lowering.shadow.text);
    }
  });

  it('derives each kind from the path', () => {
    assert.deepEqual(
      lowerCorpus().map((lowering) => [lowering.file, lowering.kind]),
      [
        ['pages/blog/[slug].jsails', 'page'],
        ['pages/index.jsails', 'page'],
        ['pages/layout.jsails', 'layout'],
        ['pages/error.jsails', 'error'],
        ['pages/not-found.jsails', 'not-found'],
        ['pages/posts.jsails', 'page'],
        ['pages/broken.jsails', 'page'],
        ['ui/shell.jsails', 'view'],
        ['ui/tag-badge.jsails', 'view'],
        ['ui/card.jsails', 'view'],
        ['ui/post-list.jsails', 'view'],
      ],
    );
  });

  it('is deterministic', () => {
    assert.deepEqual(
      lowerCorpus().map((lowering) => lowering.tsx),
      lowerCorpus().map((lowering) => lowering.tsx),
    );
  });

  it('maps the whole body and copies template code Verbatim', () => {
    for (const lowering of lowerCorpus()) {
      const shadow = lowering.shadow;
      assert.ok(shadow !== null);
      let cursor = shadow.bodyStart;
      for (const span of shadow.spans) {
        assert.equal(span.generatedStart, cursor, lowering.file);
        cursor = span.generatedEnd;
      }
      assert.equal(cursor, shadow.bodyEnd, lowering.file);
      assert.equal(shadow.bodyEnd, shadow.text.length, 'no footer: nothing imports a style block');
    }
    const page = lowerCorpus()[0]?.shadow;
    assert.ok(page !== undefined && page !== null);
    const at = page.text.indexOf('page.tags.length > 0');
    const span = page.spans.find((entry) => entry.generatedStart <= at && at < entry.generatedEnd);
    assert.equal(span?.kind, SpanKind.Verbatim);
  });

  it('reports exports and the imports the catalog resolved', () => {
    const page = lowerCorpus()[0];
    assert.deepEqual(page?.exports, ['Neighbour', 'getStaticPaths', 'load', 'default']);
    assert.deepEqual(
      page?.imports.map((entry) => [entry.name, entry.specifier, entry.export]),
      [
        ['posts', '../../shared/posts.js', 'posts'],
        ['formatDate', '../../shared/format-date.js', 'formatDate'],
        ['Shell', '../../ui/shell.jsails', 'default'],
        ['TagBadge', '../../ui/tag-badge.jsails', 'default'],
      ],
    );
  });

  it('declares explicit return types and async only when setup awaits', () => {
    const page = lowered('pages/blog/[slug].jsails');
    const layout = lowered('pages/layout.jsails');
    const shell = lowered('ui/shell.jsails');
    assert.match(
      page?.tsx ?? '',
      /export default function __Page\(__props: __PageProps<typeof load>, __context: __RequestContext\): __ComponentChild \{/,
    );
    assert.match(
      layout?.tsx ?? '',
      /export default async function __Layout\(__props: \{ readonly children: __ComponentChild \}, __context: __RequestContext\): Promise<__ComponentChild> \{/,
    );
    assert.match(
      shell?.tsx ?? '',
      /export default function Shell\(__props: \(\{ title: string \}\) & \{ readonly children\?: __ComponentChild \}\): __ComponentChild \{/,
    );
  });

  it('renders the corpus pages and views', async () => {
    const modules = await loadModules(
      CORPUS_APP,
      SFC_CORPUS.map((file) => file.path),
    );
    const page = modules.get('pages/blog/[slug].jsails');
    const load = page?.['load'] as (context: unknown) => Promise<unknown>;
    const render = component(page);
    assert.equal(
      html(render(await load(context('/blog/hello')), context('/blog/hello'))),
      `<div class="shell"${SHELL}><header><h2>Hello</h2></header> <article class="post"${POST}><h1>Hello</h1>` +
        '<p class="meta">02/01/2026 · 1 min read</p><ul class="tags">' +
        `<li><span class="badge" style="color:red;font-weight:bold;"${BADGE}>INTRO</span></li>` +
        `<li><span class="badge" style="color:red;font-weight:bold;"${BADGE}>NEWS</span></li></ul>` +
        '<div><p>First</p></div><a href="/blog/again">Next: Again →</a></article> </div>',
    );
    assert.equal(
      html(render({ page: null, minutes: 0 }, context('/blog/missing'))),
      `<div class="shell"${SHELL}><header><h2>Not found</h2></header> <p class="empty"${POST}>No post at /blog/missing.</p> </div>`,
    );
    assert.equal(
      html(component(modules.get('pages/index.jsails'))({}, context('/'))),
      `<main${marker('pages/index.jsails')}><h1>Welcome</h1><p>Braces { and } and a > are text, &amp; entities decode.</p>` +
        '<ol><li>Item 1</li><li>Item 2</li><li>Item 3</li></ol></main>',
    );
    const layout = component(modules.get('pages/layout.jsails'));
    assert.equal(
      html(await layout({ children: 'Page' }, context('/'))),
      `<div class="layout"${marker('pages/layout.jsails')}><nav><a href="/" data-index="0">Home</a><a href="/blog" data-index="1">Blog</a></nav>Page</div>`,
    );
    assert.equal(
      html(
        component(modules.get('pages/error.jsails'))(
          { error: { status: 503, message: 'Down' } },
          context('/'),
        ),
      ),
      `<section class="error" data-status="503"${marker('pages/error.jsails')}><h1>Server error</h1><p>Down</p></section>`,
    );
    assert.equal(
      html(
        component(modules.get('ui/post-list.jsails'))({
          rows: [{ id: 1, label: 'a' }],
          totals: { x: 1, y: 2 },
        }),
      ),
      `<section id="posts" class="card wide"${CARD}><header><b${LIST}>Posts</b></header><ol> <li data-index="0"${LIST}>#1 a</li> </ol>` +
        `<dl${LIST}> <dt>1. x</dt><dd>1</dd>  <dt>2. y</dt><dd>2</dd> </dl> <em class="count">1</em> ` +
        '<code>{{ not   interpolated }}</code></section>',
    );
  });

  it('renders the not-found page and the post index', async () => {
    const modules = await loadModules(CORPUS_APP, ['pages/not-found.jsails', 'pages/posts.jsails']);
    const notFound = modules.get('pages/not-found.jsails');
    assert.equal(
      html(component(notFound)((notFound?.['load'] as () => unknown)(), context('/'))),
      `<main${marker('pages/not-found.jsails')}><h1>Page not found</h1><p>Try <a href="/">/</a><span>, </span><a href="/blog">/blog</a></p></main>`,
    );
    const posts = modules.get('pages/posts.jsails');
    assert.equal(
      html(component(posts)((posts?.['load'] as () => unknown)(), context('/posts'))),
      `<section id="posts" class="card wide"${CARD}><header><b${LIST}>Posts</b></header><ol> <li data-index="0"${LIST}>#1 Hello</li>  ` +
        `<li data-index="1"${LIST}>#2 Again</li> </ol><dl${LIST}> <dt>1. intro</dt><dd>1</dd>  <dt>2. news</dt><dd>1</dd> </dl> ` +
        '<strong class="count">2</strong> <code>{{ not   interpolated }}</code></section>',
    );
  });

  it('marks a page exporting serverOnly = true as SERVER_ONLY', async () => {
    const source =
      '<script lang="ts">\n/** A page only the live server renders. */\nexport const serverOnly = true;\n</script>\n' +
      '<template><p>Live only</p></template>\n';
    const modules = await loadModules(
      [{ path: 'pages/live.jsails', source }],
      ['pages/live.jsails'],
    );
    const module = modules.get('pages/live.jsails');
    assert.equal((module?.['default'] as Record<symbol, unknown>)[SERVER_ONLY], true);
    assert.equal(
      html(component(module)({}, context('/live'))),
      `<p${marker('pages/live.jsails')}>Live only</p>`,
    );
  });
});

describe('lowerSfc template constructs', () => {
  const P = marker('ui/probe.jsails');

  async function render(template: string, props: unknown, setup = ''): Promise<string> {
    const source = `${setup === '' ? '' : `<script setup lang="ts">\n${setup}\n</script>\n`}<template>\n${template}\n</template>\n`;
    assert.deepEqual(
      lowerSfc(source, 'ui/probe.jsails', { resolver: CORPUS_RESOLVER }).diagnostics,
      [],
    );
    const modules = await loadModules([{ path: 'ui/probe.jsails', source }], ['ui/probe.jsails']);
    return html(component(modules.get('ui/probe.jsails'))(props));
  }

  it('renders a js-if chain with a null fallback', async () => {
    const template = '<p js-if="n === 1">one</p><p js-else-if="n === 2">two</p>';
    assert.equal(
      await render(template, { n: 2 }, 'defineProps<{ n: number }>();'),
      `<p${P}>two</p>`,
    );
    assert.equal(await render(template, { n: 3 }, 'defineProps<{ n: number }>();'), '');
  });

  it('loops over numbers, iterables and records with their indexes', async () => {
    const setup =
      'defineProps<{ list: string[]; map: Map<string, number>; record: Record<string, number> }>();';
    const html = await render(
      '<i js-for="n in 2" :key="n">{{ n }}</i><b js-for="(item, i) of list" :key="item">{{ i }}{{ item }}</b>' +
        '<u js-for="([key, value]) in map" :key="key">{{ key }}={{ value }}</u>' +
        '<s js-for="(value, key, index) in record" :key="key">{{ index }}{{ key }}{{ value }}</s>',
      { list: ['a', 'b'], map: new Map([['m', 1]]), record: { r: 7 } },
      setup,
    );
    assert.equal(
      html,
      `<i${P}>1</i><i${P}>2</i><b${P}>0a</b><b${P}>1b</b><u${P}>m=1</u><s${P}>0r7</s>`,
    );
  });

  it('merges static and bound class and style, and js-show last', async () => {
    const html = await render(
      '<p class="a" :class="{ b: on }" style="color: red" :style="{ color: \'blue\' }" js-show="on">x</p>',
      { on: false },
      'defineProps<{ on: boolean }>();',
    );
    assert.equal(html, `<p class="a" style="color:blue;display:none;"${P}>x</p>`);
  });

  it('leaves the element its own display while js-show holds', async () => {
    const template = '<p style="display: flex" :style="{ gap: 0 }" js-show="on">x</p>';
    const setup = 'defineProps<{ on: boolean }>();';
    assert.equal(
      await render(template, { on: true }, setup),
      `<p style="display:flex;gap:0px;"${P}>x</p>`,
    );
    assert.equal(
      await render(template, { on: false }, setup),
      `<p style="display:none;gap:0px;"${P}>x</p>`,
    );
  });

  it('drops raw-HTML attributes from a js-bind spread', async () => {
    const html = await render(
      '<p js-bind="extra">x</p><i js-bind="extra" class="c"></i>',
      { extra: { id: 'i', dangerouslySetInnerHTML: { __html: '<b>raw</b>' } } },
      'defineProps<{ extra: Record<string, unknown> }>();',
    );
    assert.equal(html, `<p id="i"${P}>x</p><i id="i" class="c"${P}></i>`);
  });

  it('keys a looped slot without passing the key as a slot prop', async () => {
    const setup =
      "import type { ComponentChild } from 'jsails/view';\n" +
      'defineSlots<{ children?: (props: Record<string, unknown>) => ComponentChild }>();';
    const html = await render(
      '<slot js-for="n in 2" :key="n" :n="n" />',
      { children: (props: Record<string, unknown>) => Object.keys(props).join(',') },
      setup,
    );
    assert.equal(html, 'nn');
  });

  it("merges js-bind's class and style after the element's own", async () => {
    const html = await render(
      '<p class="a" js-bind="extra" title="t">x</p>',
      { extra: { class: 'b', id: 'i', title: 'ignored' } },
      'defineProps<{ extra: Record<string, string> }>();',
    );
    assert.equal(html, `<p id="i" title="t" class="a b"${P}>x</p>`);
  });

  it('renders a slot fallback, a named slot and a scoped slot', async () => {
    const setup =
      "import type { ComponentChild } from 'jsails/view';\n" +
      'defineSlots<{ children?: ComponentChild; head?: ComponentChild; item?: (props: { n: number }) => ComponentChild }>();';
    const template =
      '<slot name="head">H</slot><slot :n="1">no item</slot><slot name="item" :n="2" />';
    assert.equal(await render(template, {}, setup), 'Hno item');
    assert.equal(
      await render(
        template,
        {
          head: 'Head',
          children: (props: { n: number }) => `c${props.n}`,
          item: (props: { n: number }) => `i${props.n}`,
        },
        setup,
      ),
      'Headc1i2',
    );
  });

  it('keeps a js-pre subtree literal and inserts js-html as HTML', async () => {
    const html = await render(
      '<!-- prettier-ignore -->\n<pre js-pre :x="y">{{ a   +   b }}</pre><div js-html="\'<i>i</i>\'"></div>',
      {},
    );
    assert.equal(html, `<pre :x="y"${P}>{{ a   +   b }}</pre><div${P}><i>i</i></div>`);
  });

  it('renders <component :is> with the literal type of its expression, marked when outermost', async () => {
    const html = await render(
      '<component :is="big ? \'strong\' : \'em\'" class="c">t</component>' +
        '<p><component :is="\'i\'">u</component></p>',
      { big: true },
      'defineProps<{ big: boolean }>();',
    );
    assert.equal(html, `<strong class="c"${P}>t</strong><p${P}><i>u</i></p>`);
  });
});

describe('lowerSfc kind rules', () => {
  it('reports @event in a server-rendered kind', () => {
    const source = '<template><button @click="go()">Go</button></template>';
    assert.deepEqual(diagnose(source), ['sfc.event_without_client']);
    assert.equal(underlined(source, 'sfc.event_without_client'), '@click');
  });

  it('reports the live directives outside a live component', () => {
    const source = '<template><input js-model="title" /><p js-confirm="\'x\'">y</p></template>';
    assert.deepEqual(diagnose(source), ['sfc.directive_kind', 'sfc.directive_kind']);
    assert.equal(underlined(source, 'sfc.directive_kind'), 'js-model');
  });

  it('reports js-hydrate off an island tag', () => {
    assert.deepEqual(diagnose('<template><div js-hydrate="idle"></div></template>'), [
      'sfc.directive_kind',
    ]);
    assert.deepEqual(diagnose('<template><Card :rows="[]" js-hydrate="load" /></template>'), [
      'sfc.directive_kind',
    ]);
  });

  it('reports <slot> in a page', () => {
    assert.deepEqual(diagnose('<template><slot /></template>', 'pages/a.jsails'), [
      'sfc.slot_kind',
    ]);
  });

  it('reports an unresolved component tag, and a page as a tag', () => {
    const source = '<template><Missing /></template>';
    assert.deepEqual(diagnose(source), ['sfc.unresolved_component']);
    assert.equal(underlined(source, 'sfc.unresolved_component'), 'Missing');
    const resolver = nameTable({
      TaskList: { source: { path: 'components/task-list.jsails' }, export: 'default' },
      Counter: { source: { path: 'islands/counter.jsails' }, export: 'default' },
      Home: { source: { path: 'pages/index.jsails' }, export: 'default' },
    });
    const lowered = lowerSfc(
      '<template><TaskList /><Counter /><Home /></template>',
      'pages/x.jsails',
      {
        resolver,
      },
    );
    assert.deepEqual(codes(lowered), ['sfc.unresolved_component']);
  });

  it('reports a mail file as not lowered', () => {
    const lowered = lowerSfc('<template><p>x</p></template>', 'mail/a.jsails');
    assert.deepEqual(codes(lowered), ['sfc.not_lowered']);
    assert.equal(lowered.shadow, null);
  });

  it('reports <template static> outside a live component, and lowers its styles', () => {
    assert.deepEqual(
      diagnose('<template><p>x</p></template><template static><p>y</p></template>'),
      ['sfc.block_kind'],
    );
    const lowered = lowerSfc(
      '<template><p>x</p></template><style>p { color: red }</style>',
      'ui/a.jsails',
    );
    assert.deepEqual(
      lowered.styles.map((style) => style.css),
      ['p { color: red }\n'],
    );
  });

  it('reports a macro that is imported, misplaced, misused or repeated', () => {
    const setup = (code: string, file = 'ui/view.jsails'): readonly SfcDiagnosticCode[] =>
      diagnose(`<script setup lang="ts">\n${code}\n</script>\n<template><p>x</p></template>`, file);
    assert.deepEqual(
      setup("import { defineProps } from 'jsails/view';\ndefineProps<{ a: string }>();"),
      ['sfc.macro_import'],
    );
    assert.deepEqual(setup('defineProps<{ a: string }>();', 'pages/a.jsails'), [
      'sfc.macro_position',
    ]);
    assert.deepEqual(setup('defineProps({ a: String });'), ['sfc.macro_position']);
    assert.deepEqual(setup('if (true) { defineProps<{ a: string }>(); }'), ['sfc.macro_position']);
    assert.deepEqual(setup('defineProps<{ a: string }>();\ndefineProps<{ b: string }>();'), [
      'sfc.duplicate_macro',
    ]);
    assert.deepEqual(setup('defineEmits<{ change: [] }>();'), ['sfc.macro_position']);
    assert.deepEqual(setup('defineLive({});'), ['sfc.live_outside_components']);
    assert.deepEqual(
      diagnose(
        '<script lang="ts">\ndefineProps<{ a: string }>();\n</script>\n<template><p>x</p></template>',
      ),
      ['sfc.macro_position'],
    );
  });

  it('reports hooks, await in a view, and await in a template', () => {
    const setup = (code: string): readonly SfcDiagnosticCode[] =>
      diagnose(`<script setup lang="ts">\n${code}\n</script>\n<template><p>x</p></template>`);
    assert.deepEqual(setup('const [a] = useState(1);'), ['sfc.hooks_outside_island']);
    assert.deepEqual(setup('const a = await Promise.resolve(1);'), ['sfc.await_in_sync_kind']);
    assert.deepEqual(setup('const f = async () => await Promise.resolve(1);'), []);
    assert.deepEqual(diagnose('<template><p>{{ await value }}</p></template>', 'pages/a.jsails'), [
      'sfc.await_in_template',
    ]);
  });

  it('reports exports from setup, a default export from script, and a bad serverOnly', () => {
    assert.deepEqual(
      diagnose(
        '<script setup lang="ts">\nexport const a = 1;\n</script>\n<template><p>x</p></template>',
      ),
      ['sfc.setup_export'],
    );
    assert.deepEqual(
      diagnose('<script lang="ts">\nexport default 1;\n</script>\n<template><p>x</p></template>'),
      ['sfc.script_default_export'],
    );
    assert.deepEqual(
      diagnose(
        '<script lang="ts">\nexport const serverOnly = false;\n</script>\n<template><p>x</p></template>',
        'pages/a.jsails',
      ),
      ['sfc.server_only_literal'],
    );
    assert.deepEqual(
      diagnose(
        '<script lang="ts">\nexport const serverOnly = true;\n</script>\n<template><p>x</p></template>',
      ),
      ['sfc.server_only_literal'],
    );
  });

  it('reports a view whose file name gives no component name', () => {
    assert.deepEqual(diagnose('<template><p>x</p></template>', 'ui/1-up.jsails'), [
      'sfc.invalid_component_name',
    ]);
    assert.deepEqual(diagnose('<template><p>x</p></template>', 'ui/class.jsails'), []);
  });

  it('reports invalid and repeated slot names and mixed default content', () => {
    const card = (inner: string): readonly SfcDiagnosticCode[] =>
      diagnose(`<template><Card :rows="[]">${inner}</Card></template>`);
    assert.deepEqual(card('<template #my-slot>x</template>'), ['sfc.invalid_slot_name']);
    assert.deepEqual(card('<template #header>x</template><template #header>y</template>'), [
      'sfc.invalid_slot_name',
    ]);
    assert.deepEqual(card('<template #default>x</template><p>y</p>'), ['sfc.mixed_default_slot']);
    assert.deepEqual(card('<template #header js-else>x</template>'), ['sfc.stray_else']);
    assert.deepEqual(diagnose('<template><slot :name="x" /></template>'), [
      'sfc.invalid_slot_name',
    ]);
  });

  it('reports a raw-HTML attribute: js-html is the one door', () => {
    const source = '<template><div :dangerouslySetInnerHTML="{ __html: x }"></div></template>';
    assert.deepEqual(diagnose(source), ['sfc.raw_html_attribute']);
    assert.equal(underlined(source, 'sfc.raw_html_attribute'), ':dangerouslySetInnerHTML');
    assert.deepEqual(diagnose('<template><div :innerHTML="x" /></template>'), [
      'sfc.raw_html_attribute',
    ]);
    assert.deepEqual(diagnose('<template><Card :rows="[]" innerHTML="x" /></template>'), [
      'sfc.raw_html_attribute',
    ]);
  });

  it('reports a component tag inside js-pre', () => {
    assert.deepEqual(
      diagnose('<template>\n<!-- prettier-ignore -->\n<pre js-pre><Card /></pre></template>'),
      ['sfc.raw_component_tag'],
    );
  });
});
