/**
 * Tests for `.jsails` styles (sfc-plan SFC-08): the scope id depends only on
 * the posix project path, on every platform; a compiled template marks its
 * outermost elements and the outermost elements of the content it passes to
 * a component; the `@scope` wrapper puts a component's own elements in its
 * scope and a child component's root outside it (evaluated with happy-dom's
 * selector engine over compiled output); the lexical check reports what
 * would break the joined stylesheet; and the style ids round-trip.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Window } from 'happy-dom';

import type { SfcDiagnosticCode } from '../../../src/compiler/sfc/diagnostics.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { nameTable } from '../../../src/compiler/sfc/name-resolver.js';
import {
  parseSfcStyleId,
  SCOPE_ATTRIBUTE,
  scopedCss,
  scopeMarker,
  sfcScopeId,
  sfcStyleId,
} from '../../../src/compiler/sfc/style.js';
import type { RenderChild } from '../../../src/contracts/component.js';
import { Fragment, jsx } from '../../../src/jsx/jsx-runtime.js';
import { renderToString } from '../../../src/jsx/render-to-string.js';
import { toPosixId } from '../../../src/support/project-paths.server.js';
import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';

const apps: CompiledFixtureApp[] = [];

after(() => {
  for (const app of apps) app.dispose();
});

function lower(source: string, file = 'ui/probe.jsails'): SfcLowering {
  return lowerSfc(source, file, { resolver: RESOLVER });
}

function codes(source: string, file?: string): readonly SfcDiagnosticCode[] {
  return lower(source, file).diagnostics.map((entry) => entry.code);
}

/** The source text each diagnostic of `code` underlines. */
function underlined(source: string, code: SfcDiagnosticCode): readonly string[] {
  return lower(source)
    .diagnostics.filter((entry) => entry.code === code)
    .map((entry) => source.slice(entry.start, entry.end));
}

const RESOLVER = nameTable({
  Child: { source: { path: 'ui/child.jsails' }, export: 'default' },
  Parent: { source: { path: 'ui/parent.jsails' }, export: 'default' },
});

describe('the scope id', () => {
  it('is eight base36 characters, the same on every run', () => {
    const id = sfcScopeId('pages/about.jsails');
    assert.match(id, /^[0-9a-z]{8}$/);
    assert.equal(sfcScopeId('pages/about.jsails'), id);
    assert.notEqual(sfcScopeId('pages/contact.jsails'), id);
    assert.equal(sfcScopeId('pages/blog/[slug].jsails').length, 8);
  });

  it('depends only on the posix project path: a Windows path normalized with toPosixId gives the same id', () => {
    const windowsRoot = 'C:\\Users\\dev\\app';
    const windowsFile = path.win32.join(windowsRoot, 'pages', 'blog', '[slug].jsails');
    const posixRoot = '/home/dev/elsewhere/app';
    const posixFile = path.posix.join(posixRoot, 'pages', 'blog', '[slug].jsails');
    const fromWindows = toPosixId(path.win32.relative(windowsRoot, windowsFile), path.win32);
    const fromPosix = toPosixId(path.posix.relative(posixRoot, posixFile), path.posix);
    assert.equal(fromWindows, 'pages/blog/[slug].jsails');
    assert.equal(sfcScopeId(fromWindows), sfcScopeId(fromPosix));
  });

  it('ignores case, so two spellings of one file on a case-insensitive file system agree', () => {
    assert.equal(sfcScopeId('UI/Card.jsails'), sfcScopeId('ui/card.jsails'));
  });

  it('refuses a path whose id would depend on the machine, value-free', () => {
    for (const file of [
      'pages\\about.jsails',
      'C:/app/pages/about.jsails',
      '/pages/about.jsails',
      'pages//about.jsails',
      './pages/about.jsails',
      'pages/../about.jsails',
      '',
    ]) {
      assert.throws(
        () => sfcScopeId(file),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: unknown }).code, 'sfc_style.invalid_path', file);
          if (file !== '') assert.ok(!error.message.includes(file), 'the path is not echoed');
          return true;
        },
      );
    }
    assert.throws(() => lower('<template><p /></template>', 'pages\\a.jsails'), {
      code: 'sfc_style.invalid_path',
    });
  });

  it('is the lowering’s, for a single file and for its folder alike', () => {
    const single = lowerSfc('<template><p>x</p></template>\n', 'pages/about.jsails');
    const folder = lowerSfc({ template: '<template><p>x</p></template>\n' }, 'pages/about.jsails');
    assert.equal(single.scopeId, sfcScopeId('pages/about.jsails'));
    assert.equal(folder.scopeId, single.scopeId);
    assert.equal(folder.tsx, single.tsx);
  });
});

/** The probe components of the marker tests, each rendered with its props. */
const MARKER_APP: readonly { readonly path: string; readonly source: string }[] = [
  {
    path: 'ui/child.jsails',
    source:
      '<script setup lang="ts">\nimport type { ComponentChild } from \'jsails/view\';\n' +
      'defineSlots<{ children?: ComponentChild; head?: ComponentChild }>();\n</script>\n' +
      '<template><section class="child"><slot name="head" /><slot /></section></template>\n',
  },
  {
    path: 'ui/flow.jsails',
    source:
      '<script setup lang="ts">\ndefineProps<{ a: boolean }>();\n</script>\n' +
      '<template><header><h1>t</h1></header><p js-if="a">a</p><p js-else>b</p>' +
      '<template js-for="n in 2" :key="n"><i>{{ n }}</i></template><template js-if="a"><b /></template></template>\n',
  },
  {
    path: 'ui/bound.jsails',
    source:
      '<script setup lang="ts">\ndefineProps<{ extra: Record<string, string> }>();\n</script>\n' +
      '<template><p js-bind="extra" class="a">x</p></template>\n',
  },
  {
    path: 'ui/slots.jsails',
    source:
      '<template><Child><p>default <b>in</b></p>' +
      '<template #head><h2>head</h2><span>more</span></template></Child></template>\n',
  },
  {
    path: 'ui/literal.jsails',
    source:
      '<script setup lang="ts">\nimport type { ComponentChild } from \'jsails/view\';\n' +
      'defineSlots<{ children?: ComponentChild }>();\n</script>\n' +
      '<template>\n<!-- prettier-ignore -->\n<pre js-pre><b>{{ x }}</b></pre><slot><em>none</em></slot></template>\n',
  },
  {
    path: 'ui/dynamic.jsails',
    source:
      "<script setup lang=\"ts\">\ndefineProps<{ tag: 'h2' | 'h3' }>();\n</script>\n" +
      '<template><component :is="tag" class="t">a</component><component :is="Child"><i>b</i></component>' +
      '<div><component :is="tag">c</component></div></template>\n',
  },
];

describe('the scope marker', () => {
  const marked = (file: string): string => scopeMarker(sfcScopeId(file));
  const child = marked('ui/child.jsails');
  let app: CompiledFixtureApp | undefined;

  /** The HTML the probe `file` renders with `props`. */
  async function rendered(file: string, props: unknown = {}): Promise<string> {
    app ??= compileFixtureApp(MARKER_APP, { resolver: RESOLVER });
    if (!apps.includes(app)) apps.push(app);
    const render = (await app.load(file))['default'] as (props: unknown) => RenderChild;
    return renderToString(jsx(Fragment, { children: render(props) }));
  }

  it('goes on the outermost elements only, through js-if, js-for and <template>', async () => {
    const own = marked('ui/flow.jsails');
    assert.equal(
      await rendered('ui/flow.jsails', { a: true }),
      `<header${own}><h1>t</h1></header><p${own}>a</p><i${own}>1</i><i${own}>2</i><b${own}></b>`,
    );
  });

  it('is written after a js-bind spread, so bound data cannot replace it', async () => {
    assert.equal(
      await rendered('ui/bound.jsails', { extra: { 'data-s': 'forged', id: 'i' } }),
      `<p${marked('ui/bound.jsails')} id="i" class="a">x</p>`,
    );
  });

  it('goes on the outermost elements of slot content, default and named alike, never on a component', async () => {
    const own = marked('ui/slots.jsails');
    assert.equal(
      await rendered('ui/slots.jsails'),
      `<section class="child"${child}><h2${own}>head</h2><span${own}>more</span>` +
        `<p${own}>default <b>in</b></p></section>`,
    );
  });

  it('goes on a js-pre root and on the elements of a slot fallback', async () => {
    const own = marked('ui/literal.jsails');
    assert.equal(
      await rendered('ui/literal.jsails'),
      `<pre${own}><b>{{ x }}</b></pre><em${own}>none</em>`,
    );
  });

  it('goes on an outermost <component :is> only when it renders a tag, and type-checks either way', async () => {
    const own = marked('ui/dynamic.jsails');
    assert.equal(
      await rendered('ui/dynamic.jsails', { tag: 'h2' }),
      `<h2 class="t"${own}>a</h2><section class="child"${child}><i${own}>b</i></section>` +
        `<div${own}><h2>c</h2></div>`,
    );
    assert.ok(app !== undefined);
    const typecheck = app.typecheck();
    assert.deepEqual(
      typecheck.diagnostics.map((entry) => entry.message),
      [],
    );
  });

  it('refuses data-s written by the author, static or bound, as reserved', () => {
    const source = '<template><p data-s="x">a</p><i :data-s="y" /><b DATA-S /></template>';
    assert.deepEqual(codes(source), [
      'sfc.reserved_attribute',
      'sfc.reserved_attribute',
      'sfc.reserved_attribute',
    ]);
    assert.deepEqual(underlined(source, 'sfc.reserved_attribute'), ['data-s', ':data-s', 'DATA-S']);
    assert.equal(SCOPE_ATTRIBUTE, 'data-s');
  });
});

/** The `@scope` prelude of a scoped block: its root and limit selector lists. */
function scopePrelude(scopeId: string): { readonly root: string; readonly limit: string } {
  const css = scopedCss('p {}', scopeId);
  const match = /^@scope \((.+)\) to \((.+)\) \{\np \{\}\n\}\n$/.exec(css);
  assert.ok(match !== null, css);
  return { root: match[1] as string, limit: match[2] as string };
}

/**
 * The elements a scoped rule of `scopeId` can match in `document`, by the
 * semantics of `@scope (<root>) to (<limit>)`: each element matching the
 * root list is a scoping root, a selector without `:scope` matches only its
 * descendants, and an element matching the limit list (relative to that root,
 * a descendant of it) ends the scope at itself and its subtree. Each element
 * is named by its `id`.
 */
function inScope(document: HappyDocument, scopeId: string): readonly string[] {
  const { root, limit } = scopePrelude(scopeId);
  const reached = new Set<unknown>();
  for (const scopingRoot of document.querySelectorAll(root)) {
    const limits = [...scopingRoot.querySelectorAll(limit)];
    for (const element of scopingRoot.querySelectorAll('*')) {
      if (!limits.some((end) => end === element || end.contains(element))) reached.add(element);
    }
  }
  return [...document.querySelectorAll('*')]
    .filter((element) => reached.has(element) && element.id !== '')
    .map((element) => element.id);
}

type HappyDocument = InstanceType<typeof Window>['document'];

const windows: InstanceType<typeof Window>[] = [];

after(async () => {
  for (const window of windows) await window.happyDOM.close();
});

function documentOf(html: string): HappyDocument {
  const window = new Window();
  windows.push(window);
  window.document.write(html);
  return window.document;
}

describe('the @scope wrapper', () => {
  it('wraps a scoped block in native @scope with no selector rewritten', () => {
    const id = sfcScopeId('ui/card.jsails');
    assert.equal(
      scopedCss('.card > h2 { color: red }', id),
      `@scope (:has(> [data-s="${id}"]), [data-s="${id}"]:root) ` +
        `to (:scope:not([data-s="${id}"]) > :not([data-s="${id}"]), [data-s]:not([data-s="${id}"])) {\n` +
        '.card > h2 { color: red }\n}\n',
    );
  });

  it('reaches a component’s own elements and the slot content it passes, and leaves a child component’s root outside', async () => {
    const app = compileFixtureApp(
      [
        {
          path: 'ui/child.jsails',
          source:
            '<template><section id="child-root" class="card"><h2 id="child-title" class="title">t</h2><slot /></section></template>\n',
        },
        {
          path: 'ui/parent.jsails',
          source:
            '<template><div id="parent-root" class="card"><Child><p id="slotted" class="title">s</p></Child>' +
            '<span id="parent-own" class="title">o</span></div></template>\n',
        },
      ],
      { resolver: RESOLVER },
    );
    apps.push(app);
    const parent = (await app.load('ui/parent.jsails'))['default'] as () => RenderChild;
    const html = renderToString(jsx(Fragment, { children: parent() }));
    const document = documentOf(
      `<!DOCTYPE html><html><body><main id="page"><aside id="sibling">x</aside>${html}</main></body></html>`,
    );
    assert.deepEqual(inScope(document, sfcScopeId('ui/parent.jsails')), [
      'parent-root',
      'slotted',
      'parent-own',
    ]);
    assert.deepEqual(inScope(document, sfcScopeId('ui/child.jsails')), [
      'child-root',
      'child-title',
    ]);
  });

  it('keeps the parent’s other children out, reaches recursion, and roots a layout at <html>', () => {
    const own = '1aaaaaaa';
    const other = '2bbbbbbb';
    const document = documentOf(
      `<!DOCTYPE html><html id="html" data-s="${own}"><head id="head"></head><body id="body">` +
        `<div id="mine" data-s="${own}"><div id="nested" data-s="${own}"><b id="deep"></b></div>` +
        `<section id="foreign" data-s="${other}"><i id="foreign-inner"></i>` +
        `<p id="passed-back" data-s="${own}"><u id="passed-inner"></u></p></section></div>` +
        `<aside id="unmarked"></aside></body></html>`,
    );
    assert.deepEqual(inScope(document, own), [
      'head',
      'body',
      'mine',
      'nested',
      'deep',
      'passed-back',
      'passed-inner',
      'unmarked',
    ]);
    assert.deepEqual(inScope(document, other), ['foreign', 'foreign-inner']);
  });
});

describe('style ids', () => {
  it('name a block of a component and read back, a file holding ? included', () => {
    for (const [file, index] of [
      ['pages/about.jsails', 0],
      ['ui/card.jsails', 12],
      ['pages/a?b.jsails', 1],
    ] as const) {
      const id = sfcStyleId(file, index);
      assert.deepEqual(parseSfcStyleId(id), { file, index });
    }
    assert.equal(
      sfcStyleId('ui/card.jsails', 1),
      'ui/card.jsails?jsails&type=style&index=1&lang.css',
    );
  });

  it('read back nothing for another id', () => {
    for (const id of [
      'ui/card.jsails',
      'ui/card.jsails?jsails&type=style&index=01&lang.css',
      'ui/card.jsails?jsails&type=style&index=-1&lang.css',
      'ui/card.jsails?jsails&type=style&index=1&lang.css&x',
      'ui/card.jsails?jsails&type=script&index=1&lang.css',
      '?jsails&type=style&index=1&lang.css',
    ]) {
      assert.equal(parseSfcStyleId(id), undefined, id);
    }
  });
});

describe('the lowered styles', () => {
  it('copy a global block, wrap a scoped one, and number both in source order', () => {
    const lowered = lower(
      '<template><p /></template>\n<style scoped>\np { margin: 0 }\n</style>\n<style>\nbody { color: red }</style>\n',
    );
    const id = sfcScopeId('ui/probe.jsails');
    assert.deepEqual(lowered.styles, [
      {
        id: sfcStyleId('ui/probe.jsails', 0),
        index: 0,
        scoped: true,
        css: scopedCss('p { margin: 0 }\n', id),
      },
      {
        id: sfcStyleId('ui/probe.jsails', 1),
        index: 1,
        scoped: false,
        css: 'body { color: red }\n',
      },
    ]);
    assert.ok(Object.isFrozen(lowered.styles) && Object.isFrozen(lowered.styles[0]));
  });

  it('come out the same from a folder’s x.css and x.scoped.css', () => {
    const single = lower(
      '<template><p /></template>\n<style>\na { color: red }\n</style>\n<style scoped>\np { margin: 0 }\n</style>\n',
      'pages/about.jsails',
    );
    const folder = lowerSfc(
      {
        template: '<template><p /></template>\n',
        style: 'a { color: red }\n',
        scopedStyle: 'p { margin: 0 }\n',
      },
      'pages/about.jsails',
    );
    assert.deepEqual(folder.styles, single.styles);
  });

  it('are empty, with no module, after any error', () => {
    const lowered = lower('<template><p>{{ }}</p></template>\n<style>\na {}\n</style>\n');
    assert.ok(lowered.diagnostics.some((entry) => entry.severity === 'error'));
    assert.deepEqual(lowered.styles, []);
    const broken = lower('<template><p /></template>\n<style>\na {\n</style>\n');
    assert.deepEqual(broken.styles, []);
    assert.equal(broken.shadow, null);
  });

  it('never change the module: the same template with other styles lowers to the same TSX', () => {
    const plain = lower('<template><p class="a">x</p></template>\n');
    const styled = lower(
      '<template><p class="a">x</p></template>\n<style scoped>\n.a { color: red }\n</style>\n',
    );
    assert.equal(styled.tsx, plain.tsx);
  });
});

describe('the lexical check', () => {
  const style = (body: string, scoped = false): string =>
    `<template><p /></template>\n<style${scoped ? ' scoped' : ''}>\n${body}\n</style>\n`;

  it('accepts braces, quotes and parentheses inside comments, strings, escapes and url()', () => {
    for (const body of [
      '/* } { ( */ a { content: "}"; }',
      "a::before { content: '\\'{'; }",
      'a { background: url(x}.png); }',
      'a { background: url( "y).png" ); }',
      '.\\{ { color: red }',
      '@media (min-width: 1px) { a { color: red } }',
      '@layer components { .a { color: red } }',
      'a { color: rgb(0 0 0 / 50%); } [data-x="]"] { color: red }',
      ':root { --x: { a: b }; }',
    ]) {
      assert.deepEqual(codes(style(body, true)), [], body);
    }
  });

  it('reports what would break the joined sheet, at the construct', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['a { color: red', '{'],
      ['a { color: red } }', '}'],
      ['a { color: red; /* note', '/*'],
      ['a { content: "x; }', '"'],
      ['a { background: url(x.png; }', 'url('],
      ['a:is(.b { color: red }', 'is('],
      ['a { color: red ]', ']'],
    ];
    for (const [body, construct] of cases) {
      const source = style(body);
      assert.deepEqual(codes(source), ['sfc.style_unbalanced'], body);
      assert.deepEqual(underlined(source, 'sfc.style_unbalanced'), [construct], body);
    }
  });

  it('reports @import, @charset and @namespace in any block', () => {
    for (const rule of ['@import "x.css";', '@charset "utf-8";', '@NAMESPACE svg url(x);']) {
      assert.deepEqual(codes(style(rule)), ['sfc.style_at_rule'], rule);
    }
  });

  it('reports a document-wide definition and :scope in a scoped block only', () => {
    for (const rule of [
      '@keyframes spin { to { rotate: 1turn } }',
      '@-webkit-keyframes spin { to { rotate: 1turn } }',
      '@font-face { font-family: X; }',
      '@property --x { syntax: "<length>"; inherits: false; initial-value: 0px; }',
      '@counter-style x { system: cyclic; symbols: a; }',
      '@page { margin: 0 }',
      '@view-transition { navigation: auto; }',
      '@function --double(--n) { result: calc(var(--n) * 2); }',
      '@color-profile --print { src: url(print.icc); }',
    ]) {
      assert.deepEqual(codes(style(rule, true)), ['sfc.scoped_global_rule'], rule);
      assert.deepEqual(codes(style(rule)), [], rule);
    }
    assert.deepEqual(codes(style(':scope > p { color: red }', true)), ['sfc.scope_selector']);
    assert.deepEqual(underlined(style(':scope > p {}', true), 'sfc.scope_selector'), [':scope']);
    assert.deepEqual(codes(style(':scope > p { color: red }')), []);
    assert.deepEqual(codes(style(':scoped-thing, a { --scope: 1 }', true)), []);
  });

  it('accepts a block whose every rule list holds complete rules', () => {
    for (const body of [
      'a { color: red }\n/* trailing note */\n',
      '@layer base;\n@layer reset, base;\na { color: red }',
      '@media (min-width: 1px) { a { color: red } }\n@supports (display: grid) { a { display: grid } }',
      'a:hover { color: red }\nimg:not([alt]) { outline: 1px solid }',
      '@font-face { font-family: X; src: url(x.woff2); }',
      '@keyframes spin { from { rotate: 0 } to { rotate: 1turn } }',
      '& { color: red }\n.a { & > .b { color: red } }',
      ':root { --x: { a: b }; --y: 1; }',
    ]) {
      assert.deepEqual(codes(style(body)), [], body);
    }
  });

  it('reports text left after a global block’s last rule, which would join the next block’s first rule', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['body { margin: 0 }\nh1', 'h1'],
      ['body { margin: 0 }\n@layer base', '@layer base'],
      ['body { margin: 0 }\n@layer base /* note */', '@layer base'],
      ['body { margin: 0 }\ncolor: red;', 'color: red;'],
      ['body { margin: 0 }\ncolor: red', 'color: red'],
      ['body { margin: 0 }\n.a { color: red };', ';'],
      ['color: red;\nbody { margin: 0 }', 'color: red;'],
      ['@media (min-width: 1px) { h1 }', 'h1'],
      ['@media (min-width: 1px) { @layer base }', '@layer base'],
    ];
    for (const [body, construct] of cases) {
      const source = style(body);
      assert.deepEqual(codes(source), ['sfc.style_incomplete'], body);
      assert.deepEqual(underlined(source, 'sfc.style_incomplete'), [construct], body);
    }
  });

  it('refuses the global block that would rewrite the next component’s rule in the joined sheet', () => {
    const broken = lower('<template><p /></template>\n<style>\nbody { margin: 0 }\nh1\n</style>\n');
    assert.deepEqual(
      broken.diagnostics.map((entry) => entry.code),
      ['sfc.style_incomplete'],
    );
    assert.equal(broken.shadow, null);
    assert.deepEqual(broken.styles, []);
  });

  it('reports text with no block left at the end of a scoped block or a group rule in it', () => {
    for (const [body, construct] of [
      ['.a { color: red }\nh1', 'h1'],
      ['.a { color: red }\n@layer base', '@layer base'],
      ['@media (min-width: 1px) { .a }', '.a'],
      ['.a;\n.b { color: red }', '.a;'],
    ] as const) {
      const source = style(body, true);
      assert.deepEqual(codes(source), ['sfc.style_incomplete'], body);
      assert.deepEqual(underlined(source, 'sfc.style_incomplete'), [construct], body);
    }
    assert.deepEqual(codes(style('.a { color: red };\n.b { color: red }', true)), []);
  });

  it('reports & where it names the scoping root in a scoped block, the parent the component is mounted in', () => {
    for (const body of [
      '& { border-top: 5px solid black }',
      '&:hover { color: red }',
      '& > * { color: red }',
      '.a & { color: red }',
      ':is(&) { color: red }',
      '@layer x { & { color: red } }',
      '@media (min-width: 1px) { & { color: red } }',
      '@supports selector(&) { .a { color: red } }',
      '@scope { & { color: red } }',
    ]) {
      const source = style(body, true);
      assert.deepEqual(codes(source), ['sfc.scope_selector'], body);
      assert.deepEqual(underlined(source, 'sfc.scope_selector'), ['&'], body);
    }
    for (const body of [
      '.a { & { color: red } }',
      '.a { &:hover { color: red } }',
      '.a { @media (min-width: 1px) { & > .b { color: red } } }',
      '@scope (.a) { & { color: red } }',
      '.a::after { content: "&" }',
      '.\\& { color: red }',
    ]) {
      assert.deepEqual(codes(style(body, true)), [], body);
    }
  });

  it('reports a declaration outside a rule in a scoped block, which styles the parent the component is mounted in', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['color: blue;', 'color: blue;'],
      ['outline: 7px solid red', 'outline: 7px solid red'],
      ['.a { color: red }\ncolor: blue', 'color: blue'],
      ['color: blue;\n.a { color: red }', 'color: blue;'],
      ['@media (min-width: 1px) { color: blue }', 'color: blue'],
      ['@layer x { .a { color: red } color: blue; }', 'color: blue;'],
      ['--x: { a };', '--x: '],
      ['--x: a {b} c;', '--x: a '],
      ['@scope { color: blue }', 'color: blue'],
      ['@scope to (.b) { color: blue }', 'color: blue'],
      ['@not-a-known-rule { color: blue }', 'color: blue'],
    ];
    for (const [body, construct] of cases) {
      const source = style(body, true);
      assert.deepEqual(codes(source), ['sfc.scope_declaration'], body);
      assert.deepEqual(underlined(source, 'sfc.scope_declaration'), [construct], body);
    }
    for (const body of [
      '.a { color: red; }',
      '@scope (.a) { color: red }',
      '@scope (.a) to (.b) { color: red }',
      '@media (min-width: 1px) { .a { color: red } }',
    ]) {
      assert.deepEqual(codes(style(body, true)), [], body);
    }
    assert.deepEqual(codes(style('color: blue;')), ['sfc.style_incomplete']);
  });

  it('positions a diagnostic of a folder’s style file in that file', () => {
    const lowered = lowerSfc(
      { template: '<template><p /></template>\n', scopedStyle: 'p {\n  color: red;\n' },
      'pages/about.jsails',
    );
    const [entry] = lowered.diagnostics;
    assert.equal(entry?.code, 'sfc.style_unbalanced');
    assert.equal(entry?.file, 'pages/about/about.scoped.css');
    assert.equal(entry?.start, 2);
  });
});
