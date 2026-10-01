/**
 * Tests for the `.jsails` TextMate grammar: per-token scope tables for every construct (blocks, text, interpolation, bound, event and slot attributes, each directive value kind, raw `js-pre` regions, nested templates, component tags), its deep freeze, and its registration as the `jsails` fence language of `renderMarkdown`.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { bundledLanguages, bundledThemes } from 'shiki';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

import { jsailsGrammar } from '../src/jsails-grammar.js';
import { renderMarkdown } from '../src/render.js';

/** One token: its text, the deepest scope this grammar gave it, and `tsx`/`css` inside an embedded language. */
type Row =
  readonly [text: string, scope: string] | readonly [text: string, scope: string, embedded: string];

const OWN_SCOPE = /\.(?:jsails|html)$|^source\.(?:tsx|css)$/;
const MARKUP_PUNCTUATION = /^punctuation\.(?:definition\.(?:tag|string)|separator\.key-value)\./;

let highlighter: HighlighterCore;

before(async () => {
  // The core highlighter takes any language id, as a third-party Shiki setup would.
  highlighter = await createHighlighterCore({
    themes: [bundledThemes['github-light']],
    langs: [bundledLanguages.tsx, bundledLanguages.css, jsailsGrammar],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
});

/**
 * The non-blank tokens of `code`, each with the deepest scope this grammar
 * assigned (inside embedded TSX or CSS, the embedding scope, so the table
 * does not depend on the TSX and CSS grammars' own scopes). Tag, quote and
 * `=` punctuation is left out unless `punctuation` is set.
 */
function tokens(code: string, punctuation = false): Row[] {
  const rows: Row[] = [];
  const lines = highlighter.codeToTokensBase(code, {
    lang: 'jsails',
    includeExplanation: 'scopeName',
    // Shiki stops a line after 500 ms by default; under a loaded CI runner
    // its two tokenizer passes then disagree and the explanation is cut off.
    tokenizeTimeLimit: 0,
  });
  for (const token of lines.flat()) {
    for (const part of token.explanation ?? []) {
      if (part.content.trim() === '') continue;
      const scopes = part.scopes.map((scope) => scope.scopeName);
      const own = scopes.findLast((scope) => OWN_SCOPE.test(scope)) ?? '';
      if (!punctuation && MARKUP_PUNCTUATION.test(own)) continue;
      const deepest = scopes.at(-1) ?? '';
      const embedded = /\.tsx$/.test(deepest) ? 'tsx' : /\.css$/.test(deepest) ? 'css' : undefined;
      rows.push(embedded === undefined ? [part.content, own] : [part.content, own, embedded]);
    }
  }
  return rows;
}

/** The tokens of `markup` inside a `<template>` block, without the block's own tags. */
function template(markup: string): Row[] {
  const rows = tokens(`<template>${markup}</template>`);
  assert.deepEqual(rows[0], ['template', 'entity.name.tag.html']);
  assert.deepEqual(rows.at(-1), ['template', 'entity.name.tag.html']);
  return rows.slice(1, -1);
}

const EXPRESSION = 'meta.embedded.expression.jsails';
const DIRECTIVE = 'entity.other.attribute-name.directive.jsails';
const TAG = 'entity.name.tag.html';

describe('jsails grammar: blocks', () => {
  it('scopes the header comment, script, setup script, style and static template blocks', () => {
    const source = [
      '<!-- A header. -->',
      '<script lang="ts">',
      'const n: number = 1;',
      '</script>',
      '<script setup lang="ts">const m = n;</script>',
      '<style scoped>',
      '.a { color: red; }',
      '</style>',
      '<template static><p>x</p></template>',
    ].join('\n');
    assert.deepEqual(tokens(source, true), [
      ['<!--', 'punctuation.definition.comment.html'],
      [' A header. ', 'comment.block.html'],
      ['-->', 'punctuation.definition.comment.html'],
      ['<', 'punctuation.definition.tag.begin.html'],
      ['script', TAG],
      ['lang', 'entity.other.attribute-name.html'],
      ['=', 'punctuation.separator.key-value.html'],
      ['"', 'punctuation.definition.string.begin.html'],
      ['ts', 'string.quoted.html'],
      ['"', 'punctuation.definition.string.end.html'],
      ['>', 'punctuation.definition.tag.end.html'],
      ['const', 'source.tsx', 'tsx'],
      ['n', 'source.tsx', 'tsx'],
      [':', 'source.tsx', 'tsx'],
      ['number', 'source.tsx', 'tsx'],
      ['=', 'source.tsx', 'tsx'],
      ['1', 'source.tsx', 'tsx'],
      [';', 'source.tsx', 'tsx'],
      ['</', 'punctuation.definition.tag.begin.html'],
      ['script', TAG],
      ['>', 'punctuation.definition.tag.end.html'],
      ['<', 'punctuation.definition.tag.begin.html'],
      ['script', TAG],
      ['setup', 'entity.other.attribute-name.html'],
      ['lang', 'entity.other.attribute-name.html'],
      ['=', 'punctuation.separator.key-value.html'],
      ['"', 'punctuation.definition.string.begin.html'],
      ['ts', 'string.quoted.html'],
      ['"', 'punctuation.definition.string.end.html'],
      ['>', 'punctuation.definition.tag.end.html'],
      ['const', 'source.tsx', 'tsx'],
      ['m', 'source.tsx', 'tsx'],
      ['=', 'source.tsx', 'tsx'],
      ['n', 'source.tsx', 'tsx'],
      [';', 'source.tsx', 'tsx'],
      ['</', 'punctuation.definition.tag.begin.html'],
      ['script', TAG],
      ['>', 'punctuation.definition.tag.end.html'],
      ['<', 'punctuation.definition.tag.begin.html'],
      ['style', TAG],
      ['scoped', 'entity.other.attribute-name.html'],
      ['>', 'punctuation.definition.tag.end.html'],
      ['.', 'source.css', 'css'],
      ['a', 'source.css', 'css'],
      ['{', 'source.css', 'css'],
      ['color', 'source.css', 'css'],
      [':', 'source.css', 'css'],
      ['red', 'source.css', 'css'],
      [';', 'source.css', 'css'],
      ['}', 'source.css', 'css'],
      ['</', 'punctuation.definition.tag.begin.html'],
      ['style', TAG],
      ['>', 'punctuation.definition.tag.end.html'],
      ['<', 'punctuation.definition.tag.begin.html'],
      ['template', TAG],
      ['static', 'entity.other.attribute-name.html'],
      ['>', 'punctuation.definition.tag.end.html'],
      ['<', 'punctuation.definition.tag.begin.html'],
      ['p', TAG],
      ['>', 'punctuation.definition.tag.end.html'],
      ['x', 'meta.block.template.jsails'],
      ['</', 'punctuation.definition.tag.begin.html'],
      ['p', TAG],
      ['>', 'punctuation.definition.tag.end.html'],
      ['</', 'punctuation.definition.tag.begin.html'],
      ['template', TAG],
      ['>', 'punctuation.definition.tag.end.html'],
    ]);
  });

  it('ends a script block at its end tag, not at an end tag inside the code', () => {
    const rows = tokens(
      '<script lang="ts">\nconst s = 1;\n</script>\n<template><p>x</p></template>',
    );
    assert.deepEqual(rows.slice(-6), [
      ['script', TAG],
      ['template', TAG],
      ['p', TAG],
      ['x', 'meta.block.template.jsails'],
      ['p', TAG],
      ['template', TAG],
    ]);
  });
});

describe('jsails grammar: template text and interpolation', () => {
  it('keeps braces and > as text, scopes entities and embeds {{ }} as TSX', () => {
    assert.deepEqual(template(`<p>a > b { c } &amp; {{ x + '}}' }}</p>`), [
      ['p', TAG],
      ['a > b { c } ', 'meta.block.template.jsails'],
      ['&', 'punctuation.definition.entity.html'],
      ['amp', 'constant.character.entity.html'],
      [';', 'punctuation.definition.entity.html'],
      ['{{', 'punctuation.definition.interpolation.begin.jsails'],
      ['x', EXPRESSION, 'tsx'],
      ['+', EXPRESSION, 'tsx'],
      ["'", EXPRESSION, 'tsx'],
      ['}}', EXPRESSION, 'tsx'],
      ["'", EXPRESSION, 'tsx'],
      ['}}', 'punctuation.definition.interpolation.end.jsails'],
      ['p', TAG],
    ]);
  });

  it('gives the TSX grammar the interpolation content', () => {
    const lines = highlighter.codeToTokensBase(`<template>{{ '}}' }}</template>`, {
      lang: 'jsails',
      includeExplanation: 'scopeName',
      tokenizeTimeLimit: 0,
    });
    const string = lines
      .flat()
      .flatMap((token) => token.explanation ?? [])
      .find((part) => part.content === '}}');
    assert.ok(
      string?.scopes.some((scope) => scope.scopeName === 'string.quoted.single.tsx'),
      'a }} inside a string literal is string content, not the end of the interpolation',
    );
  });
});

describe('jsails grammar: attributes', () => {
  it('scopes plain, entity-bearing, unquoted and bare attributes as HTML', () => {
    assert.deepEqual(template('<a class="x &quot;y&quot;" disabled data-n=1></a>'), [
      ['a', TAG],
      ['class', 'entity.other.attribute-name.html'],
      ['x ', 'string.quoted.html'],
      ['&', 'punctuation.definition.entity.html'],
      ['quot', 'constant.character.entity.html'],
      [';', 'punctuation.definition.entity.html'],
      ['y', 'string.quoted.html'],
      ['&', 'punctuation.definition.entity.html'],
      ['quot', 'constant.character.entity.html'],
      [';', 'punctuation.definition.entity.html'],
      ['disabled', 'entity.other.attribute-name.html'],
      ['data-n', 'entity.other.attribute-name.html'],
      ['1', 'string.unquoted.html'],
      ['a', TAG],
    ]);
  });

  it('embeds a bound value as a TSX expression', () => {
    assert.deepEqual(template(`<a :href="url" :class="[a, { b: c }]" :disabled></a>`), [
      ['a', TAG],
      [':', 'punctuation.attribute-shorthand.bind.jsails'],
      ['href', 'entity.other.attribute-name.html'],
      ['url', EXPRESSION, 'tsx'],
      [':', 'punctuation.attribute-shorthand.bind.jsails'],
      ['class', 'entity.other.attribute-name.html'],
      ['[', EXPRESSION, 'tsx'],
      ['a', EXPRESSION, 'tsx'],
      [',', EXPRESSION, 'tsx'],
      ['{', EXPRESSION, 'tsx'],
      ['b', EXPRESSION, 'tsx'],
      [':', EXPRESSION, 'tsx'],
      ['c', EXPRESSION, 'tsx'],
      ['}', EXPRESSION, 'tsx'],
      [']', EXPRESSION, 'tsx'],
      [':', 'punctuation.attribute-shorthand.bind.jsails'],
      ['disabled', 'entity.other.attribute-name.html'],
      ['a', TAG],
    ]);
  });

  it('scopes an event name and its modifiers, and embeds the handler as TSX statements', () => {
    assert.deepEqual(
      template(`<form @submit.prevent="save(); done = true"></form><b @click></b>`),
      [
        ['form', TAG],
        ['@', 'punctuation.attribute-shorthand.event.jsails'],
        ['submit', 'entity.other.attribute-name.event.jsails'],
        ['.', 'punctuation.separator.modifier.jsails'],
        ['prevent', 'entity.other.attribute-name.modifier.jsails'],
        ['save', EXPRESSION, 'tsx'],
        ['(', EXPRESSION, 'tsx'],
        [')', EXPRESSION, 'tsx'],
        [';', EXPRESSION, 'tsx'],
        ['done', EXPRESSION, 'tsx'],
        ['=', EXPRESSION, 'tsx'],
        ['true', EXPRESSION, 'tsx'],
        ['form', TAG],
        ['b', TAG],
        ['@', 'punctuation.attribute-shorthand.event.jsails'],
        ['click', 'entity.other.attribute-name.event.jsails'],
        ['b', TAG],
      ],
    );
  });

  it('scopes slot names and embeds slot parameters as TSX', () => {
    assert.deepEqual(
      template('<Card><template #row="{ item }">{{ item }}</template><template #empty /></Card>'),
      [
        ['Card', 'support.class.component.jsails'],
        ['template', TAG],
        ['#', 'punctuation.attribute-shorthand.slot.jsails'],
        ['row', 'entity.other.attribute-name.slot.jsails'],
        ['{', 'meta.embedded.parameters.jsails', 'tsx'],
        ['item', 'meta.embedded.parameters.jsails', 'tsx'],
        ['}', 'meta.embedded.parameters.jsails', 'tsx'],
        ['{{', 'punctuation.definition.interpolation.begin.jsails'],
        ['item', EXPRESSION, 'tsx'],
        ['}}', 'punctuation.definition.interpolation.end.jsails'],
        ['template', TAG],
        ['template', TAG],
        ['#', 'punctuation.attribute-shorthand.slot.jsails'],
        ['empty', 'entity.other.attribute-name.slot.jsails'],
        ['Card', 'support.class.component.jsails'],
      ],
    );
  });
});

describe('jsails grammar: directives', () => {
  it('splits js-for into alias, in/of and source, and embeds js-if as an expression', () => {
    assert.deepEqual(
      template(
        '<li js-for="(item, i) in items" :key="item.id"></li><b js-for="n of 3"></b><i js-if="a"></i><i js-else></i>',
      ),
      [
        ['li', TAG],
        ['js-for', DIRECTIVE],
        ['(', EXPRESSION, 'tsx'],
        ['item', EXPRESSION, 'tsx'],
        [',', EXPRESSION, 'tsx'],
        ['i', EXPRESSION, 'tsx'],
        [')', EXPRESSION, 'tsx'],
        ['in', 'keyword.control.loop.jsails'],
        ['items', EXPRESSION, 'tsx'],
        [':', 'punctuation.attribute-shorthand.bind.jsails'],
        ['key', 'entity.other.attribute-name.html'],
        ['item', EXPRESSION, 'tsx'],
        ['.', EXPRESSION, 'tsx'],
        ['id', EXPRESSION, 'tsx'],
        ['li', TAG],
        ['b', TAG],
        ['js-for', DIRECTIVE],
        ['n', EXPRESSION, 'tsx'],
        ['of', 'keyword.control.loop.jsails'],
        ['3', EXPRESSION, 'tsx'],
        ['b', TAG],
        ['i', TAG],
        ['js-if', DIRECTIVE],
        ['a', EXPRESSION, 'tsx'],
        ['i', TAG],
        ['i', TAG],
        ['js-else', DIRECTIVE],
        ['i', TAG],
      ],
    );
  });

  it('scopes name-valued directives, their modifiers, and the hydration trigger', () => {
    assert.deepEqual(
      template(
        '<input js-model.trim.lazy="title"><b js-loading js-sort="name"></b><Counter js-hydrate="visible" />',
      ),
      [
        ['input', TAG],
        ['js-model', DIRECTIVE],
        ['.', 'punctuation.separator.modifier.jsails'],
        ['trim', 'entity.other.attribute-name.modifier.jsails'],
        ['.', 'punctuation.separator.modifier.jsails'],
        ['lazy', 'entity.other.attribute-name.modifier.jsails'],
        ['title', 'variable.other.property.jsails'],
        ['b', TAG],
        ['js-loading', DIRECTIVE],
        ['js-sort', DIRECTIVE],
        ['name', 'variable.other.property.jsails'],
        ['b', TAG],
        ['Counter', 'support.class.component.jsails'],
        ['js-hydrate', DIRECTIVE],
        ['visible', 'support.constant.hydrate.jsails'],
      ],
    );
  });

  it('embeds the value of a removed or unknown js-* attribute as an expression', () => {
    assert.deepEqual(template('<p js-visible="open" js-text="t"></p>'), [
      ['p', TAG],
      ['js-visible', DIRECTIVE],
      ['open', EXPRESSION, 'tsx'],
      ['js-text', DIRECTIVE],
      ['t', EXPRESSION, 'tsx'],
      ['p', TAG],
    ]);
  });
});

describe('jsails grammar: structure', () => {
  it('keeps a js-pre subtree raw up to its own end tag', () => {
    assert.deepEqual(
      template('<!-- prettier-ignore -->\n<pre js-pre>{{ a+b }} <b :t="p">x</b></pre>{{ after }}'),
      [
        ['<!--', 'punctuation.definition.comment.html'],
        [' prettier-ignore ', 'comment.block.html'],
        ['-->', 'punctuation.definition.comment.html'],
        ['pre', TAG],
        ['js-pre', DIRECTIVE],
        ['{{ a+b }} ', 'meta.element.raw.jsails'],
        ['b', TAG],
        [':t', 'entity.other.attribute-name.html'],
        ['p', 'string.quoted.html'],
        ['x', 'meta.element.raw.jsails'],
        ['b', TAG],
        ['pre', TAG],
        ['{{', 'punctuation.definition.interpolation.begin.jsails'],
        ['after', EXPRESSION, 'tsx'],
        ['}}', 'punctuation.definition.interpolation.end.jsails'],
      ],
    );
  });

  it('pairs nested <template> elements so their end tags never close the block', () => {
    assert.deepEqual(
      template(
        '<template js-if="a"><template js-for="x of xs">{{ x }}</template></template><p>{{ y }}</p>',
      ),
      [
        ['template', TAG],
        ['js-if', DIRECTIVE],
        ['a', EXPRESSION, 'tsx'],
        ['template', TAG],
        ['js-for', DIRECTIVE],
        ['x', EXPRESSION, 'tsx'],
        ['of', 'keyword.control.loop.jsails'],
        ['xs', EXPRESSION, 'tsx'],
        ['{{', 'punctuation.definition.interpolation.begin.jsails'],
        ['x', EXPRESSION, 'tsx'],
        ['}}', 'punctuation.definition.interpolation.end.jsails'],
        ['template', TAG],
        ['template', TAG],
        ['p', TAG],
        ['{{', 'punctuation.definition.interpolation.begin.jsails'],
        ['y', EXPRESSION, 'tsx'],
        ['}}', 'punctuation.definition.interpolation.end.jsails'],
        ['p', TAG],
      ],
    );
  });

  it('scopes capitalized and dotted tags as components, the rest as HTML', () => {
    assert.deepEqual(template('<ui.Card></ui.Card><Foo.Bar /><DIV></DIV><my-el></my-el>'), [
      ['ui.Card', 'support.class.component.jsails'],
      ['ui.Card', 'support.class.component.jsails'],
      ['Foo.Bar', 'support.class.component.jsails'],
      ['DIV', 'support.class.component.jsails'],
      ['DIV', 'support.class.component.jsails'],
      ['my-el', TAG],
      ['my-el', TAG],
    ]);
  });
});

describe('jsails grammar: value', () => {
  it('is deep-frozen', () => {
    assert.ok(Object.isFrozen(jsailsGrammar));
    assert.ok(Object.isFrozen(jsailsGrammar.repository));
    const event = jsailsGrammar.repository['attribute-event'];
    assert.ok(event !== undefined && Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.patterns?.[0]?.beginCaptures?.['3']));
  });

  it('names the TSX and CSS grammars it embeds', () => {
    assert.equal(jsailsGrammar.name, 'jsails');
    assert.equal(jsailsGrammar.scopeName, 'source.jsails');
    assert.deepEqual(jsailsGrammar.embeddedLangs, ['tsx', 'css']);
  });
});

describe('jsails fences in renderMarkdown', () => {
  it('highlights a jsails fence with the grammar, also when fences highlight in parallel', async () => {
    const fence = '```jsails\n<template><p :title="t">{{ n }}</p></template>\n```\n';
    const { html } = await renderMarkdown(
      `${fence}\n${fence}\n\`\`\`nonexistent\n{{ n }}\n\`\`\`\n`,
    );
    const blocks = html.split('<pre').slice(1);
    assert.equal(blocks.length, 3);
    const colours = (block: string): number =>
      new Set(block.match(/--shiki-light:#[0-9A-Fa-f]+/g) ?? []).size;
    for (const block of blocks.slice(0, 2)) {
      assert.ok(colours(block) >= 3, `the jsails fence is tokenized: ${block}`);
    }
    assert.equal(
      colours(blocks[2] ?? ''),
      1,
      'an unknown language renders in the text colour only',
    );
  });
});
