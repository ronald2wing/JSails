/**
 * Tests for the transitional template lowering: each construct of the new grammar lowers to valid TSX on the live render tools, text never becomes JSX syntax, lines are preserved, and constructs owned by the kind lowerings are reported instead of emitted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { parseSfcBlocks } from '../../src/compiler/sfc/blocks.js';
import { SfcDiagnostics, type SfcDiagnostic } from '../../src/compiler/sfc/diagnostics.js';
import { lowerTemplate } from '../../src/compiler/template-lower.js';

interface Lowered {
  readonly jsx: string;
  readonly diagnostics: readonly SfcDiagnostic[];
}

function lower(markup: string): Lowered {
  const source = `<template>${markup}</template>`;
  const file = parseSfcBlocks(source, 'components/demo.jsails');
  assert.deepEqual(
    file.diagnostics.filter((entry) => entry.severity === 'error'),
    [],
    markup,
  );
  const template = file.template;
  assert.ok(template !== null);
  const diagnostics = new SfcDiagnostics('components/demo.jsails');
  const jsx = lowerTemplate(template.root.children, template.contentStart, {
    source,
    diagnostics,
  });
  return { jsx, diagnostics: diagnostics.list() };
}

/** Lower markup that must lower without a diagnostic to TSX that parses. */
function valid(markup: string): string {
  const { jsx, diagnostics } = lower(markup);
  assert.deepEqual(diagnostics, [], markup);
  const parsed = parseSync('view.tsx', `const view = (<>${jsx}</>);\n`, { sourceType: 'module' });
  assert.deepEqual(
    parsed.errors.filter((error) => error.severity === 'Error').map((error) => error.message),
    [],
    jsx,
  );
  return jsx;
}

describe('lowerTemplate', () => {
  it('emits text as string expressions, so braces and > stay text', () => {
    assert.equal(valid('<p>a { b } > c</p>'), '<p>{"a { b } > c"}</p>');
  });

  it('lowers interpolation and bound attributes verbatim', () => {
    assert.equal(
      valid('<a :href="`/p/${id}`" class="x">{{ title }}</a>'),
      '<a href={`/p/${id}`} class={"x"}>{title}</a>',
    );
  });

  it('lowers a js-if chain to one conditional', () => {
    assert.equal(
      valid('<p js-if="a">1</p><p js-else-if="b">2</p><p js-else>3</p>'),
      '{(a) ? (<p>{"1"}</p>) : (b) ? (<p>{"2"}</p>) : (<p>{"3"}</p>)}',
    );
    assert.equal(valid('<p js-if="a">1</p>'), '{(a) ? (<p>{"1"}</p>) : null}');
  });

  it('lowers js-for to a map and a nested template to a fragment', () => {
    assert.equal(
      valid('<template js-for="(x, i) in xs"><b>{{ i }}</b></template>'),
      '{(xs).map((x, i) => (<><b>{i}</b></>))}',
    );
  });

  it('lowers js-show, js-text, js-html and js-bind', () => {
    assert.equal(
      valid('<p js-show="open" js-bind="rest" js-text="label"></p><div js-html="html"></div>'),
      `<p style={{ display: (open) ? undefined : 'none' }} {...(rest)}>{label}</p><div dangerouslySetInnerHTML={{ __html: html }} />`,
    );
  });

  it('lowers live actions and render-tool directives onto tools', () => {
    assert.equal(
      valid(
        '<form @submit="add"><input js-model="title"><button @click="remove({ index: 1 })" js-confirm="\'Sure?\'" js-loading="add">x</button></form>',
      ),
      `<form {...tools.submit("add")}><input {...tools.bind("title")} /><button {...tools.call("remove", { index: 1 })} {...tools.confirm('Sure?')} {...tools.loadingTarget("add")}>{"x"}</button></form>`,
    );
  });

  it('emits a js-pre subtree literally', () => {
    assert.equal(
      valid('<!-- prettier-ignore -->\n<code js-pre :x="y">{{ a }} <b>c</b></code>'),
      '\n<code {...{":x": "y"}}>{"{{ a }} "}<b>{"c"}</b></code>',
    );
  });

  it('keeps every node on its source line', () => {
    const jsx = valid('<ul>\n  <li\n    :title="t">\n    {{ a }}\n  </li>\n</ul>');
    const lines = jsx.split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[2] ?? '', /title=\{t\}/);
    assert.match(lines[3] ?? '', /\{a\}/);
  });

  it('reports what the kind lowerings own instead of emitting it', () => {
    const cases = [
      '<slot />',
      '<component :is="X" />',
      '<p class="a" :class="b">x</p>',
      '<p style="a" js-show="b">x</p>',
      '<Counter js-hydrate="idle" />',
      '<input js-model.trim="title">',
      '<p js-loading>x</p>',
      '<List><template #row="{ item }">{{ item }}</template></List>',
    ];
    for (const markup of cases) {
      const { diagnostics } = lower(markup);
      assert.deepEqual(
        diagnostics.map((entry) => entry.code),
        ['sfc.not_lowered'],
        markup,
      );
    }
  });

  it('accepts only actions as live event handlers', () => {
    for (const markup of ['<input @input="x">', '<b @click="count++">x</b>']) {
      assert.deepEqual(
        lower(markup).diagnostics.map((entry) => entry.code),
        ['sfc.live_handler_not_action'],
        markup,
      );
    }
  });
});
