/**
 * Tests for the island lowering: an `islands/**.jsails` file compiles to a
 * named function component wrapped by `defineIsland` with its path id; its
 * template sets typed Preact handler props for `@event` (DOM events from
 * Preact's own list, component events as `on…` props), with Vue's handler
 * forms and modifier order; `js-model` spreads a `bindControl` binding chosen
 * by the control; `defineEmits` adds handler props and an `emit` value; an
 * island's tag mounts `<Island>` where a template renders on the server, is
 * a plain component inside an island and an error in a live component; and
 * the client target compiles islands and views only, to the server's bytes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { islandIdFor, islandPathIsId } from '../../../src/compiler/conventions.js';
import { compileSfc } from '../../../src/compiler/sfc/compile.js';
import type { SfcDiagnosticCode } from '../../../src/compiler/sfc/diagnostics.js';
import { DOM_EVENT_PROPS } from '../../../src/compiler/sfc/island-events.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { nameTable } from '../../../src/compiler/sfc/name-resolver.js';

const ISLAND = 'islands/probe.jsails';

const RESOLVER = nameTable({
  useSignal: { source: { package: '@preact/signals' }, export: 'useSignal' },
  Counter: { source: { path: 'islands/counter.jsails' }, export: 'default' },
  Card: { source: { path: 'ui/card.jsails' }, export: 'default' },
});

/** An island with `setup` in `<script setup>` and `template`. */
function island(template: string, setup = ''): string {
  return `<script setup lang="ts">\nconst text = useSignal('');\n${setup}\n</script>\n\n<template>${template}</template>\n`;
}

function lower(source: string, file = ISLAND): SfcLowering {
  return lowerSfc(source, file, { resolver: RESOLVER });
}

function codes(source: string, file = ISLAND): readonly SfcDiagnosticCode[] {
  return lower(source, file).diagnostics.map((entry) => entry.code);
}

/** The source text the first diagnostic underlines, with its code. */
function underlined(source: string, file = ISLAND): string {
  const [entry] = lower(source, file).diagnostics;
  assert.ok(entry !== undefined, 'expected a diagnostic');
  return `${entry.code} ${source.slice(entry.start, entry.end)}`;
}

/** The shadow text of a file that lowers without a diagnostic. */
function tsx(source: string, file = ISLAND): string {
  const lowered = lower(source, file);
  assert.deepEqual(lowered.diagnostics, []);
  return lowered.tsx;
}

describe('the island module', () => {
  it('is a named function wrapped by defineIsland with its path id', () => {
    const text = tsx(island('<p>{{ text.value }}</p>'), 'islands/admin/user-card.jsails');
    assert.match(
      text,
      /\nfunction UserCard\(__props: Record<never, never>\): __ComponentChild \{\n/,
    );
    assert.match(text, /\nexport default __defineIsland\("admin\/user-card", UserCard\);\n/);
    assert.doesNotMatch(text, /export default function/);
    assert.match(text, /import \{ defineIsland as __defineIsland \} from 'jsails\/view';/);
  });

  it('derives the id from the path under islands/, kebab-cased by segment', () => {
    assert.equal(islandIdFor('islands/LoadMore.jsails'), 'load-more');
    assert.equal(islandIdFor('islands/admin/user-card.jsails'), 'admin/user-card');
    assert.equal(islandIdFor('islands/card/card.jsails'), 'card/card');
    assert.equal(islandPathIsId('islands/admin/user-card.jsails'), true);
    assert.equal(islandPathIsId('islands/LoadMore.jsails'), false);
    assert.equal(islandPathIsId('islands/Admin/user-card.jsails'), false);
  });

  it('reports a path that is not its id, or gives an id defineIsland refuses, at the template', () => {
    const paths = [
      'islands/LoadMore.jsails',
      'islands/Admin/user-card.jsails',
      'islands/load_more.jsails',
      'islands/(marketing)/cta.jsails',
      'islands/@shop/cart.jsails',
      'islands/café/cart.jsails',
      'islands/constructor.jsails',
      `islands/${'a'.repeat(200)}/b.jsails`,
    ];
    for (const path of paths) {
      assert.equal(underlined(island('<p />'), path), 'sfc.invalid_island_id <template>', path);
      const compiled = compileSfc(lower(island('<p />'), path));
      assert.equal(compiled.js, null, path);
    }
  });

  it('may call hooks, and refuses await, which a browser render cannot wait for', () => {
    assert.deepEqual(codes(island('<p />', 'const count = useSignal(0);')), []);
    assert.deepEqual(codes(island('<p />', 'const data = await load();')), [
      'sfc.await_in_sync_kind',
    ]);
  });

  it('renders slots', () => {
    const text = tsx(island('<div><slot /></div>'));
    assert.match(text, /__props\.children/);
  });
});

describe('island @event', () => {
  it("sets Preact's typed handler prop of a DOM event, with its capture variant", () => {
    const text = tsx(
      island(
        '<div @keydown="go" @dblclick.capture="go" @focusin="go" />',
        'function go(): void {}',
      ),
    );
    assert.match(text, / onKeyDown=\{go\}/);
    assert.match(text, / onDblClickCapture=\{go\}/);
    assert.match(text, / onFocusIn=\{go\}/);
  });

  it("names every DOM handler prop Preact's DOMAttributes declares, and no other", () => {
    const preact = dirname(createRequire(import.meta.url).resolve('preact/package.json'));
    const declarations = readFileSync(join(preact, 'src', 'dom.d.ts'), 'utf8');
    const start = declarations.indexOf('export interface DOMAttributes<');
    assert.ok(start >= 0);
    const body = declarations.slice(start, declarations.indexOf('\n}', start));
    const declared = [...body.matchAll(/^\s+(on[A-Z][A-Za-z]*)\??:/gm)].map((match) => match[1]);
    assert.deepEqual([...DOM_EVENT_PROPS].sort(), declared.sort());
  });

  it('writes a name as the handler, a member path called through its object, other code as an arrow declaring $event when read', () => {
    const text = tsx(
      island(
        '<div @click="form.reset" @keyup="go" @input="go($event)" @blur="count++" @focus="(e) => go(e)" @copy="go($event); count++" />',
        'let count = 0;\nconst form = { reset(): void {} };\nfunction go(_event: unknown): void {}',
      ),
    );
    assert.match(
      text,
      / onClick=\{\(\$event\) => \(form\.reset satisfies \(event: typeof \$event\) => unknown as unknown as \(event: typeof \$event\) => unknown\)\(\$event\)\}/,
    );
    assert.match(text, / onKeyUp=\{go\}/);
    assert.match(text, / onInput=\{\(\$event\) => \(go\(\$event\)\)\}/);
    assert.match(text, / onBlur=\{\(\) => \(count\+\+\)\}/);
    assert.match(text, / onFocus=\{\(e\) => go\(e\)\}/);
    assert.match(text, / onCopy=\{\(\$event\) => \{\ngo\(\$event\); count\+\+\n \}\}/);
  });

  it('runs .once first, then .self, .prevent and .stop in the order written', () => {
    const text = tsx(
      island(
        '<a @click.stop.once.prevent="go" @submit.self.prevent="go" />',
        'function go(): void {}',
      ),
    );
    assert.match(
      text,
      / onClick=\{\(\$event\) => \{ if \(__once0\.has\(\$event\.currentTarget\)\) return; __once0\.add\(\$event\.currentTarget\); \$event\.stopPropagation\(\); \$event\.preventDefault\(\); \(go satisfies \(event: typeof \$event\) => unknown as unknown as \(event: typeof \$event\) => unknown\)\(\$event\); \}\}/,
    );
    assert.match(
      text,
      / onSubmit=\{\(\$event\) => \{ if \(\$event\.target !== \$event\.currentTarget\) return; \$event\.preventDefault\(\); \(go satisfies \(event: typeof \$event\) => unknown as unknown as \(event: typeof \$event\) => unknown\)\(\$event\); \}\}/,
    );
    assert.match(text, /\nconst __once0 = new WeakSet<object>\(\);\n/);
  });

  it("sets a component event's on… prop, camel-cased", () => {
    const text = tsx(
      island('<Counter @update-value="go" @change="go" />', 'function go(): void {}'),
    );
    assert.match(text, /<Counter onUpdateValue=\{go\} onChange=\{go\} \/>/);
  });

  it('reports an event Preact does not type, a missing capture phase, .passive and a modifier on a component event', () => {
    assert.equal(
      underlined(island('<div @frobnicate="text.value = \'\'" />')),
      'sfc.unknown_event @frobnicate',
    );
    assert.equal(
      underlined(island('<dialog @toggle.capture="text.value = \'\'" />')),
      'sfc.unknown_event @toggle.capture',
    );
    assert.equal(
      underlined(island('<div @wheel.passive="text.value = \'\'" />')),
      'sfc.event_modifier @wheel.passive',
    );
    assert.equal(
      underlined(island('<Counter @change.stop="text.value = \'\'" />')),
      'sfc.event_modifier @change.stop',
    );
  });
});

describe('island js-model', () => {
  it('spreads a bindControl binding chosen by the control, with its modifiers', () => {
    const text = tsx(
      island(
        [
          '<input js-model.trim.lazy="text" />',
          '<textarea js-model="text"></textarea>',
          '<input type="number" js-model.lazy="count" />',
          '<input type="range" js-model="count" />',
          '<input type="checkbox" js-model="on" />',
          '<input type="radio" value="a" js-model="text" />',
          '<input type="radio" :value="choice" js-model="text" />',
          '<select js-model.number="count"></select>',
        ].join(''),
        "const count = useSignal(0);\nconst on = useSignal(false);\nconst choice = 'b';",
      ),
    );
    assert.match(
      text,
      /<input \{\.\.\.__bindControl\(text, "text", \{ lazy: true, trim: true \}\)\} data-s="[0-9a-z]{8}" \/>/,
    );
    assert.match(text, /<textarea \{\.\.\.__bindControl\(text, "text"\)\}/);
    assert.match(text, /\{\.\.\.__bindControl\(count, "number", \{ lazy: true \}\)\}/);
    assert.match(text, /type=\{"range"\} \{\.\.\.__bindControl\(count, "number"\)\}/);
    assert.match(text, /\{\.\.\.__bindControl\(on, "checkbox"\)\}/);
    assert.match(text, /\{\.\.\.__bindControl\(text, "radio", \{ value: "a" \}\)\}/);
    assert.match(text, /\{\.\.\.__bindControl\(text, "radio", \{ value: \(choice\) \}\)\}/);
    assert.match(
      text,
      /<select \{\.\.\.__bindControl\(count, "select", \{ number: true \}\)\} data-s="[0-9a-z]{8}" \/>/,
    );
    assert.match(text, /import \{ bindControl as __bindControl, defineIsland as __defineIsland \}/);
  });

  it("passes the control's own @input and @change to the binding, typed as the element's props, wherever they are written", () => {
    const cast =
      'satisfies \\(event: typeof \\$event\\) => unknown as unknown as \\(event: typeof \\$event\\) => unknown';
    const text = tsx(
      island(
        [
          '<input js-model="text" @input="go" />',
          '<textarea @input="go" js-model.lazy="text" @change="text.value = \'\'"></textarea>',
          '<input type="checkbox" @change.stop="go" js-model="on" />',
          '<select js-model="text" @input.capture="go"></select>',
        ].join(''),
        'const on = useSignal(false);\nfunction go(): void {}',
      ),
    );
    assert.match(
      text,
      /<input \{\.\.\.__bindControl\(text, "text", \{ handlers: \{ onInput: go \} satisfies Pick<__JSX\.IntrinsicElements\["input"\], "onInput"> \}\)\} data-s="[0-9a-z]{8}" \/>/,
    );
    assert.match(
      text,
      /<textarea \{\.\.\.__bindControl\(text, "text", \{ lazy: true, handlers: \{ onInput: go, onChange: \(\) => \(text\.value = ''\) \} satisfies Pick<__JSX\.IntrinsicElements\["textarea"\], "onInput" \| "onChange"> \}\)\} data-s="[0-9a-z]{8}" \/>/,
    );
    assert.match(
      text,
      new RegExp(
        `<input type=\\{"checkbox"\\} \\{\\.\\.\\.__bindControl\\(on, "checkbox", \\{ handlers: \\{ onChange: \\(\\$event\\) => \\{ \\$event\\.stopPropagation\\(\\); \\(go ${cast}\\)\\(\\$event\\); \\} \\} satisfies Pick<__JSX\\.IntrinsicElements\\["input"\\], "onChange"> \\}\\)\\} data-s="[0-9a-z]{8}" \\/>`,
      ),
    );
    assert.match(
      text,
      /<select \{\.\.\.__bindControl\(text, "select"\)\} onInputCapture=\{go\} data-s="[0-9a-z]{8}" \/>/,
    );
    assert.match(text, /import type \{ JSX as __JSX \} from 'jsails\/jsx-runtime';/);
    assert.equal(
      underlined(island('<input js-model="text" @input.passive="text.value = \'\'" />')),
      'sfc.event_modifier @input.passive',
    );
  });

  it('reports a target it cannot bind, at the attribute in the way', () => {
    const cases: [string, string][] = [
      ['<div js-model="text"></div>', 'js-model'],
      ['<Counter js-model="text" />', 'js-model'],
      ['<input type="file" js-model="text" />', 'type'],
      ['<input :type="kind" js-model="text" />', ':type'],
      ['<input value="x" js-model="text" />', 'value'],
      ['<input type="checkbox" checked js-model="text" />', 'checked'],
      ['<input type="radio" js-model="text" />', 'js-model'],
      ['<select multiple js-model="text"></select>', 'multiple'],
      ['<input type="checkbox" js-model.trim="text" />', 'js-model.trim'],
      ['<input type="number" js-model.trim="text" />', 'js-model.trim'],
    ];
    for (const [template, at] of cases) {
      assert.equal(
        underlined(island(template, "const kind = 'text';")),
        `sfc.model_target ${at}`,
        template,
      );
    }
  });
});

describe('defineEmits', () => {
  it('adds the handler props of its events, and binds emit to the props', () => {
    const text = tsx(
      island(
        '<button @click="emit(\'change\', 1)" />',
        'const emit = defineEmits<{ change: [n: number] }>();',
      ),
    );
    assert.match(
      text,
      /function Probe\(__props: __EmitProps<\(\{ change: \[n: number\] \}\)>\): __ComponentChild/,
    );
    assert.match(text, /\nconst emit = __emitter<\(\{ change: \[n: number\] \}\)>\(__props\);\n/);
    assert.match(
      text,
      /import type \{ ComponentChild as __ComponentChild, EmitProps as __EmitProps \}/,
    );
    assert.match(text, /emitter as __emitter/);
  });

  it('as a statement adds the props only', () => {
    const text = tsx(island('<p />', 'defineEmits<{ close: [] }>();'));
    assert.match(text, /__props: __EmitProps<\(\{ close: \[\] \}\)>/);
    assert.doesNotMatch(text, /__emitter/);
  });

  it('is refused bound to a pattern, and outside an island', () => {
    assert.equal(
      underlined(island('<p />', 'const { a } = defineEmits<{ a: [] }>();')),
      'sfc.macro_position defineEmits<{ a: [] }>()',
    );
    assert.deepEqual(
      codes(
        '<script setup lang="ts">\nconst emit = defineEmits<{ a: [] }>();\n</script>\n<template><p /></template>\n',
        'ui/card.jsails',
      ),
      ['sfc.macro_position'],
    );
  });
});

describe('island tags', () => {
  const VIEW = 'ui/host.jsails';

  it('mount <Island> with one props object where a template renders on the server', () => {
    const text = tsx(
      `<script setup lang="ts">\nconst extra = { label: 'x' };\nconst items = [1, 2];\n</script>\n<template><main>` +
        '<Counter :start="1" label="a" data-x="y" post-count="2" js-bind="extra" js-hydrate="load" />' +
        '<Counter js-for="item in items" :key="item" :start="item * 2" />' +
        '</main></template>\n',
      VIEW,
    );
    assert.match(
      text,
      /import \{ Island as __Island(, renderList as __renderList)? \} from 'jsails\/view';/,
    );
    assert.match(
      text,
      /<__Island component=\{Counter\} props=\{\{ start: 1, label: "a", "data-x": "y", postCount: "2", \.\.\.\(extra\) \}\} \/>/,
    );
    assert.match(
      text,
      /<__Island key=\{item\} component=\{Counter\} props=\{\{ start: item \* 2 \}\} \/>/,
    );
    assert.doesNotMatch(text, /js-hydrate|hydrate=/);
  });

  it('is a plain component inside an island', () => {
    const text = tsx(island('<Counter :start="1" />'));
    assert.match(text, /<Counter start=\{1\} \/>/);
    assert.doesNotMatch(text, /__Island/);
  });

  it('is refused in a live component', () => {
    const source = `<script lang="ts">
import { z } from 'zod';

defineLive({
  stateSchema: z.object({ n: z.number() }),
  initialState: () => ({ n: 0 }),
  authorize: () => true,
  actions: {},
});
</script>

<template><div><Counter :start="n" /></div></template>
`;
    assert.equal(
      underlined(source, 'components/widget.jsails'),
      'sfc.island_position <Counter :start="n" />',
    );
  });

  it('reports children, an event, a client directive, deferred hydration and a comma value', () => {
    const view = (template: string): string =>
      underlined(`<template>${template}</template>\n`, VIEW);
    assert.equal(view('<Counter>x</Counter>'), 'sfc.island_children x');
    assert.equal(view('<Counter js-show="true" />'), 'sfc.directive_kind js-show');
    assert.equal(view('<Counter js-hydrate="idle" />'), 'sfc.not_lowered idle');
    assert.equal(view('<Counter js-hydrate="visible" />'), 'sfc.not_lowered visible');
    assert.equal(view('<Counter @change="1" />'), 'sfc.event_without_client @change');
    assert.equal(view('<Counter :start="1, 2" />'), 'sfc.invalid_expression 1');
  });
});

describe('the client target', () => {
  it('compiles an island and a view to the server bytes, and refuses a page', () => {
    for (const [source, file] of [
      [island('<p>{{ text.value }}</p>'), ISLAND],
      ['<template><p>x</p></template>\n', 'ui/card.jsails'],
    ] as const) {
      const lowering = lower(source, file);
      const server = compileSfc(lowering);
      assert.ok(server.js !== null, file);
      assert.equal(compileSfc(lowering, { target: 'client' }).js, server.js, file);
    }
    const page = compileSfc(lower('<template><p>x</p></template>\n', 'pages/index.jsails'), {
      target: 'client',
    });
    assert.equal(page.js, null);
    assert.deepEqual(
      page.diagnostics.map((entry) => entry.code),
      ['sfc.client_target'],
    );
  });
});
