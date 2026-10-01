/**
 * Tests for the live lowering: a `components/**.jsails` file compiles to a
 * schema-first `defineLiveComponent` definition whose render reads state
 * fields and the tools' kind names, `@` handlers and the live directives
 * become render-tool spreads with Alias names, `<template static>` becomes
 * `staticFallback`, a page hoists the mounts of its live tags under the
 * template's own conditions, and every rule of the kind is a positioned
 * diagnostic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SfcDiagnosticCode } from '../../../src/compiler/sfc/diagnostics.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { generatedToOriginal, SpanKind } from '../../../src/compiler/sfc/segments.js';
import { scopeMarker, sfcScopeId } from '../../../src/compiler/sfc/style.js';
import { LIVE_RESOLVER, liveFile } from './live-corpus.js';

const COMPONENT = 'components/widget.jsails';
/** The widget's scope marker, as its outermost elements carry it (no character to escape in a pattern). */
const W = scopeMarker(sfcScopeId(COMPONENT));

/** A live component with `defineLive(definition)`, `template` and optional extra blocks. */
function live(template: string, options: { definition?: string; blocks?: string } = {}): string {
  const definition =
    options.definition ??
    `{
  stateSchema: z.object({ title: z.string(), done: z.boolean(), items: z.array(z.string()) }),
  initialState: () => ({ title: '', done: false, items: [] }),
  authorize: () => true,
  actions: { save: serverAction({ run() {} }), pick: serverAction({ input: z.object({ at: z.number() }), run() {} }) },
  derived: { total: (state) => state.items.length },
}`;
  return `<script lang="ts">
import { z } from 'zod';

defineLive(${definition});
</script>

${options.blocks ?? ''}<template>${template}</template>
`;
}

function lower(source: string, file = COMPONENT): SfcLowering {
  return lowerSfc(source, file, { resolver: LIVE_RESOLVER });
}

function codes(source: string, file = COMPONENT): readonly SfcDiagnosticCode[] {
  return lower(source, file).diagnostics.map((entry) => entry.code);
}

/** The source text the diagnostic of `code` underlines. */
function underlined(source: string, code: SfcDiagnosticCode, file = COMPONENT): string {
  const entry = lower(source, file).diagnostics.find((diagnostic) => diagnostic.code === code);
  assert.ok(entry !== undefined, `expected ${code}`);
  return source.slice(entry.start, entry.end);
}

/** The shadow text of a file that lowers without a diagnostic. */
function tsx(source: string, file = COMPONENT): string {
  const lowered = lower(source, file);
  assert.deepEqual(lowered.diagnostics, []);
  return lowered.tsx;
}

describe('the live module', () => {
  it('is a schema-first definition named by the path, with render and staticFallback', () => {
    const file = liveFile('components/task-list.jsails');
    const text = tsx(file.source, file.path);
    assert.match(
      text,
      /import \{ defineLiveComponent as __defineLiveComponent \} from 'jsails\/server-components';/,
    );
    assert.match(text, /export default __defineLiveComponent\("task-list", z\n/);
    assert.match(text, /\n {2}render\(__state, __tools\): __ComponentChild \{\n/);
    assert.match(
      text,
      /\n {2}staticFallback\(__context: __RequestContext\): __ComponentChild \{\n/,
    );
    assert.doesNotMatch(text, /defineLive\(/);
    assert.deepEqual(lower(file.source, file.path).exports, ['default']);
  });

  it('binds kind names to the tools and free names to state fields, an Alias at first use', () => {
    const source = live('<p>{{ title }} {{ total }} {{ errors.title }} {{ context.url }}</p>');
    const lowered = lower(source);
    const text = lowered.tsx;
    assert.match(text, /const errors = __tools\.errors;/);
    assert.match(text, /const context = __tools\.context;/);
    assert.match(text, /const total = __tools\.computed\("total"\);/);
    assert.match(text, /const title = __state\.title;/);
    const shadow = lowered.shadow;
    assert.ok(shadow !== null);
    const at = text.indexOf('__state.title') + '__state.'.length;
    const mapped = generatedToOriginal(shadow, at);
    assert.ok(mapped.fidelity !== 'none');
    assert.equal(mapped.kind, SpanKind.Alias);
    assert.equal(source.slice(mapped.start, mapped.end), 'title');
  });

  it('awaits in render only when setup awaits', () => {
    const text = tsx(
      live('<p>{{ value }}</p>', {
        blocks: '<script setup lang="ts">\nconst value = await Promise.resolve(1);\n</script>\n\n',
      }),
    );
    assert.match(text, /async render\(__state, __tools\): Promise<__ComponentChild>/);
    assert.match(tsx(live('<p>x</p>')), /\n {2}render\(__state, __tools\): __ComponentChild/);
  });
});

describe('live handlers', () => {
  it('lower @submit, @click and @intersect onto the tools, with modifiers as markers', () => {
    const text = tsx(
      live(
        '<form @submit.prevent="save"><button @click.once.capture="pick({ at: 1 })">x</button></form><div @intersect="save"></div>',
      ),
    );
    assert.match(text, new RegExp(String.raw`<form \{\.\.\.__tools\.submit\("save"\)\}${W}>`));
    assert.match(
      text,
      /<button \{\.\.\.__tools\.call\("pick", \{ at: 1 \}\)\} data-jsails-once="" data-jsails-capture="">/,
    );
    assert.match(text, new RegExp(String.raw`<div \{\.\.\.__tools\.intersect\("save"\)\}${W} \/>`));
  });

  it('write the action name as an Alias of the handler name', () => {
    const source = live('<button @click="save">x</button>');
    const lowered = lower(source);
    assert.ok(lowered.shadow !== null);
    const mapped = generatedToOriginal(lowered.shadow, lowered.tsx.indexOf('"save"'));
    assert.ok(mapped.fidelity !== 'none');
    assert.equal(mapped.kind, SpanKind.Alias);
    assert.equal(source.slice(mapped.start, mapped.end), 'save');
  });

  it('report other events, a misplaced @submit and unsupported modifiers', () => {
    assert.deepEqual(codes(live('<input @input="save" />')), ['sfc.live_event']);
    assert.deepEqual(codes(live('<div @submit="save"></div>')), ['sfc.live_event']);
    assert.deepEqual(codes(live('<button @click.stop="save">x</button>')), [
      'sfc.live_event_modifier',
    ]);
    assert.deepEqual(codes(live('<div @intersect.once="save"></div>')), [
      'sfc.live_event_modifier',
    ]);
  });

  it('report a handler that does not name an action', () => {
    for (const handler of ['n++', 'save(); pick()', 'a.b', 'pick(1, 2)', 'pick(...xs)', 'f()()']) {
      const source = live(`<button @click="${handler}">x</button>`);
      assert.deepEqual(codes(source), ['sfc.live_handler_not_action'], handler);
    }
    assert.deepEqual(codes(live('<div @intersect="pick({ at: 1 })"></div>')), [
      'sfc.live_handler_not_action',
    ]);
  });
});

describe('live directives', () => {
  it('lower each directive onto its tool', () => {
    const text = tsx(
      live(
        '<input js-model.number.lazy="title" /><textarea js-model="title"></textarea>' +
          '<button js-confirm="\'Sure?\'" js-loading>x</button><div js-poll="{ intervalMs: 1000 }" js-ignore js-ref="box"></div>' +
          '<th js-sort="title">t</th>',
      ),
    );
    assert.match(text, /\{\.\.\.__tools\.bind\("title", \{ lazy: true, number: true \}\)\}/);
    assert.match(
      text,
      new RegExp(String.raw`<textarea \{\.\.\.__tools\.bind\("title"\)\}${W} \/>`),
    );
    assert.match(
      text,
      /\{\.\.\.__tools\.confirm\('Sure\?'\)\} \{\.\.\.__tools\.loadingTarget\(\)\}/,
    );
    assert.match(
      text,
      /\{\.\.\.__tools\.poll\(\{ intervalMs: 1000 \}\)\} \{\.\.\.__tools\.ignore\(\)\} \{\.\.\.__tools\.ref\("box"\)\}/,
    );
    assert.match(text, /\{\.\.\.__tools\.sort\("title"\)\}/);
  });

  it('report js-model off a form control, a live directive on a component, and js-loading with a value', () => {
    assert.deepEqual(codes(live('<div js-model="title"></div>')), ['sfc.model_target']);
    assert.deepEqual(codes(live('<TaskList js-confirm="\'x\'" />')), ['sfc.directive_kind']);
    assert.deepEqual(codes(live('<button js-loading="spinner">x</button>')), [
      'sfc.unexpected_value',
    ]);
  });

  it('toggle hidden and add the client marker for js-show and js-text on a bare state field', () => {
    const text = tsx(live('<p js-show="done" js-text="title"></p>'));
    assert.match(
      text,
      new RegExp(
        String.raw`<p hidden=\{!\(done\)\} \{\.\.\.__tools\.show\("done"\)\} \{\.\.\.__tools\.text\("title"\)\}${W}>\{title\}<\/p>`,
      ),
    );
  });

  it('lower js-show as in every kind when its value is not a bare state field', () => {
    const expression = tsx(live('<p js-show="!done">x</p>'));
    assert.match(
      expression,
      /style=\{__normalizeStyle\(\(!done\) \? undefined : \{ display: 'none' \}\)\}/,
    );
    assert.doesNotMatch(expression, /__tools\.show/);
    const local = tsx(
      live('<p js-show="ready">x</p>', {
        blocks: '<script setup lang="ts">\nconst ready = true;\n</script>\n\n',
      }),
    );
    assert.doesNotMatch(local, /__tools\.show/);
    const alias = tsx(
      live('<p js-show="done">a</p><p js-for="done in items" :key="done" js-show="done">b</p>'),
    );
    assert.equal(alias.match(/__tools\.show/g)?.length, 1);
  });
});

describe('the static form', () => {
  it('names only context, imports and catalog names', () => {
    const source = live('<p>x</p>', {
      blocks: '<template static><p>{{ context.url.pathname }} {{ title }}</p></template>\n\n',
    });
    assert.deepEqual(codes(source), ['sfc.static_unbound']);
    assert.equal(underlined(source, 'sfc.static_unbound'), 'title');
    const text = tsx(
      live('<p>x</p>', {
        blocks: '<template static><p>{{ context.url.pathname }}</p></template>\n\n',
      }),
    );
    assert.match(
      text,
      /staticFallback\(__context: __RequestContext\): __ComponentChild \{\n {2}const context = __context;/,
    );
  });

  it('renders without the runtime: no handler, no live directive', () => {
    assert.deepEqual(
      codes(
        live('<p>x</p>', {
          blocks: '<template static><button @click="save">x</button></template>\n\n',
        }),
      ),
      ['sfc.event_without_client'],
    );
    assert.deepEqual(
      codes(
        live('<p>x</p>', { blocks: '<template static><input js-model="title" /></template>\n\n' }),
      ),
      ['sfc.directive_kind'],
    );
  });

  it('is exclusive with staticRender', () => {
    const source = live('<p>x</p>', {
      definition:
        "{ stateSchema: z.object({}), initialState: () => ({}), authorize: () => true, staticRender: 'initial' }",
      blocks: '<template static><p>y</p></template>\n\n',
    });
    assert.deepEqual(codes(source), ['sfc.live_definition']);
    assert.equal(underlined(source, 'sfc.live_definition'), '<template static>');
  });
});

describe('defineLive', () => {
  const minimal = 'stateSchema: z.object({}), initialState: () => ({}), authorize: () => true';

  it('is required, once, as a statement of <script>', () => {
    assert.deepEqual(codes('<template><p>x</p></template>\n'), ['sfc.live_definition']);
    assert.deepEqual(
      codes(
        `<script lang="ts">\ndefineLive({ ${minimal} });\ndefineLive({ ${minimal} });\n</script>\n<template><p>x</p></template>\n`,
      ),
      ['sfc.live_definition'],
    );
    assert.deepEqual(
      codes(
        `<script lang="ts">\nconst d = defineLive({ ${minimal} });\n</script>\n<template><p>x</p></template>\n`,
      ),
      ['sfc.live_definition'],
    );
    assert.deepEqual(
      codes(
        `<script setup lang="ts">\ndefineLive({ ${minimal} });\n</script>\n<template><p>x</p></template>\n`,
      ),
      ['sfc.live_definition', 'sfc.live_definition'],
    );
  });

  it('takes one object literal with static keys, a stateSchema, and no reserved key', () => {
    for (const definition of [
      'options',
      `{ ...base, ${minimal} }`,
      `{ [key]: 1, ${minimal} }`,
      `{ name: 'x', ${minimal} }`,
      `{ render() {}, ${minimal} }`,
      `{ staticFallback() {}, ${minimal} }`,
      `{ ${minimal}, stateSchema: z.object({}) }`,
      '{ initialState: () => ({}), authorize: () => true }',
      `{ ${minimal}, derived: shared }`,
      `{ ${minimal}, derived: { errors: () => 1 } }`,
      `{ stateSchema() { return z.object({}); }, initialState: () => ({}), authorize: () => true }`,
    ]) {
      assert.deepEqual(
        codes(live('<p>x</p>', { definition })),
        ['sfc.live_definition'],
        definition,
      );
    }
    assert.deepEqual(
      codes(
        `<script lang="ts">\ndefineLive<{ a: 1 }>({ ${minimal} });\n</script>\n<template><p>x</p></template>\n`,
      ),
      ['sfc.live_definition'],
    );
  });

  it('belongs to components/ only', () => {
    assert.deepEqual(
      codes(
        `<script lang="ts">\ndefineLive({ ${minimal} });\n</script>\n<template><p>x</p></template>\n`,
        'pages/a.jsails',
      ),
      ['sfc.live_outside_components'],
    );
  });
});

describe('live tags', () => {
  const page = (template: string, file = 'pages/a.jsails', script = ''): SfcLowering =>
    lower(`${script}<template>${template}</template>\n`, file);

  it('hoist an awaited mount under the template’s own chain', () => {
    const lowered = page(
      '<section js-if="a"><TaskList /></section><p js-else-if="b">b</p><div js-else><TaskList /></div>',
    );
    assert.deepEqual(lowered.diagnostics, []);
    const text = lowered.tsx;
    assert.match(text, /import \{ mountLive as __mountLive \} from 'jsails\/server-components';/);
    assert.match(text, /export default async function __Page/);
    assert.match(
      text,
      / {2}let __live0: __ComponentChild = null;\n {2}let __live1: __ComponentChild = null;\n {2}if \(a\) \{\n {4}__live0 = await __mountLive\(TaskList, __context\);\n {2}\} else if \(b\) \{\n {2}\} else \{\n {4}__live1 = await __mountLive\(TaskList, __context\);\n {2}\}\n {2}return/,
    );
    assert.match(
      text,
      new RegExp(
        String.raw`\(a\) \? \(<section${scopeMarker(sfcScopeId('pages/a.jsails'))}>\n\s*\{__live0\}`,
      ),
    );
  });

  it('mount a component <script> imports by a relative path', () => {
    const lowered = page(
      '<Tasks />',
      'pages/a.jsails',
      '<script lang="ts">\nimport Tasks from \'../components/task-list.jsails\';\n</script>\n',
    );
    assert.deepEqual(lowered.diagnostics, []);
    assert.match(lowered.tsx, /__live0 = await __mountLive\(Tasks, __context\);/);
  });

  it('mount in a layout and the not-found page, nowhere else', () => {
    assert.deepEqual(page('<TaskList /><slot />', 'pages/layout.jsails').diagnostics, []);
    assert.deepEqual(page('<TaskList />', 'pages/not-found.jsails').diagnostics, []);
    for (const file of ['pages/error.jsails', 'ui/a.jsails', 'components/b.jsails']) {
      const source =
        file === 'components/b.jsails'
          ? live('<TaskList />')
          : '<template><TaskList /></template>\n';
      assert.deepEqual(codes(source, file), ['sfc.live_outside_page'], file);
      assert.equal(underlined(source, 'sfc.live_outside_page', file), '<TaskList />');
    }
  });

  it('report a live tag in a loop, a scoped slot or a slot fallback', () => {
    const position = (template: string, file = 'pages/a.jsails'): readonly SfcDiagnosticCode[] =>
      codes(`<template>${template}</template>\n`, file);
    assert.deepEqual(position('<ul><li js-for="n in 3" :key="n"><TaskList /></li></ul>'), [
      'sfc.live_tag_position',
    ]);
    assert.deepEqual(
      codes(
        '<script lang="ts">\nimport Card from \'../ui/card.jsails\';\n</script>\n' +
          '<template><Card><template #default="{ row }">{{ row }}<TaskList /></template></Card></template>\n',
        'pages/a.jsails',
      ),
      ['sfc.live_tag_position'],
    );
    assert.deepEqual(position('<slot><TaskList /></slot>', 'pages/layout.jsails'), [
      'sfc.live_tag_position',
    ]);
  });

  it('report attributes and children on a live tag', () => {
    const source = '<template><TaskList :key="1" title="x" /></template>\n';
    assert.deepEqual(codes(source, 'pages/a.jsails'), [
      'sfc.live_props_unsupported',
      'sfc.live_props_unsupported',
    ]);
    assert.equal(underlined(source, 'sfc.live_props_unsupported', 'pages/a.jsails'), ':key="1"');
    assert.deepEqual(codes('<template><TaskList>x</TaskList></template>\n', 'pages/a.jsails'), [
      'sfc.live_props_unsupported',
    ]);
  });
});
