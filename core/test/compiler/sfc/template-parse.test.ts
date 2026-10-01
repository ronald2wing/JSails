/**
 * Tests for the .jsails template parser: literal text and entities, void elements and comments, oxc-bounded interpolation, the attribute model, raw js-pre subtrees, structural checks, the fixes for removed syntax, and the whitespace rule pinned to Prettier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSync } from 'rolldown/utils';

import {
  SfcDiagnostics,
  applySfcFix,
  type SfcDiagnostic,
  type SfcDiagnosticCode,
} from '../../../src/compiler/sfc/diagnostics.js';
import {
  CLOSED_BY_CHILDREN,
  DEFAULT_DISPLAY,
  DISPLAY_OVERRIDE_COMMENT,
  ELEMENT_DISPLAY,
  ELEMENT_WHITE_SPACE,
} from '../../../src/compiler/sfc/html-elements.js';
import { htmlNamedEntities } from '../../../src/compiler/sfc/html-entities.js';
import type {
  ElementNode,
  TemplateAttribute,
  TemplateNode,
} from '../../../src/compiler/sfc/template-ast.js';
import { parseTemplateBlock } from '../../../src/compiler/sfc/template-parse.js';

const FILE = 'components/demo.jsails';

interface Parsed {
  readonly source: string;
  readonly children: readonly TemplateNode[];
  readonly diagnostics: readonly SfcDiagnostic[];
}

/** Parse `markup` as the content of a `<template>` block. */
function parse(markup: string, prefix = ''): Parsed {
  const source = `${prefix}<template>${markup}</template>`;
  const diagnostics = new SfcDiagnostics(FILE);
  const parsed = parseTemplateBlock(source, prefix.length + '<template>'.length, diagnostics);
  if (!diagnostics.hasErrors) {
    assert.deepEqual(parsed.closeTag, {
      start: source.length - '</template>'.length,
      end: source.length,
    });
  }
  return { source, children: parsed.root.children, diagnostics: diagnostics.list() };
}

/** Parse markup that must produce no diagnostic. */
function clean(markup: string): readonly TemplateNode[] {
  const parsed = parse(markup);
  assert.deepEqual(parsed.diagnostics, [], markup);
  return parsed.children;
}

/** The only diagnostic of `markup`, which must have `code`. */
function only(
  markup: string,
  code: SfcDiagnosticCode,
): SfcDiagnostic & { readonly source: string } {
  const parsed = parse(markup);
  assert.deepEqual(
    parsed.diagnostics.map((entry) => entry.code),
    [code],
    markup,
  );
  return { ...(parsed.diagnostics[0] as SfcDiagnostic), source: parsed.source };
}

/** The template content after applying the only diagnostic's fix. */
function fixed(markup: string, code: SfcDiagnosticCode): string {
  const diagnostic = only(markup, code);
  assert.ok(diagnostic.fix !== undefined, `no fix for ${code}`);
  const repaired = applySfcFix(diagnostic.source, diagnostic.fix);
  return repaired.slice('<template>'.length, -'</template>'.length);
}

/** Render a tree as compact text for structural assertions. */
function shape(nodes: readonly TemplateNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') {
        return JSON.stringify(node.value);
      }
      if (node.kind === 'interpolation') {
        return `{{${node.expression.code}}}`;
      }
      return `<${node.tag}>${shape(node.children)}</${node.tag}>`;
    })
    .join('');
}

function element(nodes: readonly TemplateNode[], index = 0): ElementNode {
  const node = nodes.filter((entry) => entry.kind === 'element')[index];
  assert.ok(node?.kind === 'element');
  return node;
}

function attribute(node: ElementNode, index = 0): TemplateAttribute {
  const found = node.attributes[index];
  assert.ok(found !== undefined);
  return found;
}

describe('template text', () => {
  it('keeps braces, a bare > and a < before a non-letter as text', () => {
    assert.equal(shape(clean('<p>a { b } > c < d <3</p>')), '<p>"a { b } > c < d <3"</p>');
  });

  it('decodes named and numeric character references', () => {
    assert.equal(
      shape(clean('<p>&amp;&lt;&#65;&#x42;&larr;&check;&nbsp;</p>')),
      `<p>${JSON.stringify('&<AB\u2190\u2713\u00a0')}</p>`,
    );
  });

  it('applies the standard replacements to numeric references', () => {
    assert.equal(
      shape(clean('<p>&#x80;&#0;&#xD800;</p>')),
      `<p>${JSON.stringify('\u20ac\ufffd\ufffd')}</p>`,
    );
  });

  it('reports an unknown entity, with a fix escaping the ampersand', () => {
    assert.equal(fixed('<p>&nope;</p>', 'sfc.unknown_entity'), '<p>&amp;nope;</p>');
  });

  it('reports a reference without its semicolon, with a fix', () => {
    assert.equal(fixed('<p>&copy 2026</p>', 'sfc.entity_missing_semicolon'), '<p>&copy; 2026</p>');
    assert.equal(fixed('<p>&#65 x</p>', 'sfc.entity_missing_semicolon'), '<p>&#65; x</p>');
  });

  it('keeps an ampersand that starts no reference', () => {
    assert.equal(shape(clean('<p>R&D &copyright & co</p>')), '<p>"R&D &copyright & co"</p>');
  });

  it('decodes static attribute values but keeps a no-semicolon name literal there', () => {
    const node = element(clean('<a href="/x?a=1&copy=2&amp;b" title="&quot;q&quot;">x</a>'));
    assert.deepEqual(
      node.attributes.map((entry) => (entry.kind === 'static' ? entry.value : null)),
      ['/x?a=1&copy=2&b', '"q"'],
    );
  });

  it('drops comments and joins the text around them', () => {
    assert.equal(shape(clean('<p>a<!-- note -->b</p>')), '<p>"ab"</p>');
    assert.equal(shape(clean('<p>a <!-- note --> b</p>')), '<p>"a b"</p>');
  });

  it('reports an unclosed comment', () => {
    const parsed = parse('<p>a<!-- open</p>');
    assert.ok(parsed.diagnostics.some((entry) => entry.code === 'sfc.unclosed_comment'));
  });

  it('rejects doctypes and CDATA', () => {
    only('<![CDATA[x]]><p>a</p>', 'sfc.unsupported_markup');
  });
});

describe('elements', () => {
  it('accepts void elements with and without />, and self-closing elements', () => {
    assert.equal(
      shape(clean('<section><input><br/><img src="a.png"><Card /><div /></section>')),
      '<section><input></input><br></br><img></img><Card></Card><div></div></section>',
    );
  });

  it('reports the end tag of a void element, with a fix removing it', () => {
    assert.equal(fixed('<p>a<br></br></p>', 'sfc.void_end_tag'), '<p>a<br></p>');
  });

  it('closes an element whose end tag is missing at its ancestor, with a fix', () => {
    assert.equal(fixed('<ul><li>one</ul>', 'sfc.missing_end_tag'), '<ul><li>one</li></ul>');
  });

  it('reports a missing end tag at the end of the block', () => {
    assert.equal(fixed('<div><p>a</p>', 'sfc.missing_end_tag'), '<div><p>a</p></div>');
  });

  it('skips a stray end tag, with a fix removing it', () => {
    assert.equal(fixed('<p>a</span></p>', 'sfc.unexpected_end_tag'), '<p>a</p>');
  });

  it('reports attributes on an end tag', () => {
    assert.equal(fixed('<p>a</p class>', 'sfc.end_tag_attribute'), '<p>a</p>');
  });

  it('counts nested templates so the block ends at its own end tag', () => {
    const nodes = clean(
      '<template js-if="a"><template js-for="x in xs" :key="x">{{ x }}</template></template>',
    );
    assert.equal(shape(nodes), '<template><template>{{x}}</template></template>');
  });

  it('rejects a child whose start tag HTML and Prettier read as ending the parent', () => {
    const nested = only('<p><div>x</div></p>', 'sfc.invalid_nesting');
    assert.equal(nested.source.slice(nested.start, nested.end), '<div');
    only('<p><Header /></p>', 'sfc.invalid_nesting');
    only('<ul><li><li>x</li></li></ul>', 'sfc.invalid_nesting');
    only('<table><tbody><tr><td><td>x</td></td></tr></tbody></table>', 'sfc.invalid_nesting');
    clean('<p><svg><p></p></svg></p>');
    clean('<P><div>x</div></P>');
    clean('<div><p>a</p><ul><li><p>b</p></li></ul></div>');
  });

  it('forbids script and style elements and skips their content', () => {
    const diagnostic = only('<script>const a = "</p>";</script><p>a</p>', 'sfc.forbidden_tag');
    assert.equal(diagnostic.start, '<template>'.length);
  });

  it('treats textarea and title content as text with interpolation', () => {
    const nodes = clean('<textarea>\n  a <b> {{ x }}</textarea>');
    assert.equal(shape(nodes), '<textarea>"  a <b> "{{x}}</textarea>');
  });

  it('parses an svg <title> as elements, as HTML and Prettier do', () => {
    assert.equal(
      shape(clean('<svg><title><tspan>x</tspan></title></svg>')),
      '<svg><title><tspan>"x"</tspan></title></svg>',
    );
  });

  it('reads CRLF as LF in kept whitespace and attribute values, as HTML does', () => {
    const nodes = clean('<pre>a\r\nb\rc&#13;</pre><p title="x\r\ny">z</p>');
    assert.equal(shape(nodes), '<pre>"a\\nb\\nc\\r"</pre><p>"z"</p>');
    const title = attribute(element(nodes, 1));
    assert.ok(title.kind === 'static');
    assert.equal(title.value, 'x\ny');
  });

  it('keeps pre whitespace exactly and drops the one line break after <pre>', () => {
    assert.equal(shape(clean('<pre>\n  a\n    b  </pre>')), '<pre>"  a\\n    b  "</pre>');
  });

  it('keeps whitespace inside an element nested in pre', () => {
    assert.equal(shape(clean('<pre><b>  x  </b>\n</pre>')), '<pre><b>"  x  "</b>"\\n"</pre>');
  });

  it('records ranges in the file even when the block starts late in it', () => {
    const prefix = `<script lang="ts">\n${'x'.repeat(400)}\n</script>\n`;
    const parsed = parse('<p :title="t">{{ a }}</p>', prefix);
    const node = element(parsed.children);
    assert.equal(parsed.source.slice(node.start, node.end), '<p :title="t">{{ a }}</p>');
    const bind = attribute(node);
    assert.ok(bind.kind === 'bind');
    assert.equal(parsed.source.slice(bind.expression.start, bind.expression.end), 't');
    const interpolation = node.children[0];
    assert.ok(interpolation?.kind === 'interpolation');
    assert.equal(
      parsed.source.slice(interpolation.expression.start, interpolation.expression.end),
      'a',
    );
  });
});

describe('interpolation', () => {
  it('ends at the first }} after which the code is one expression', () => {
    const cases: readonly [string, string][] = [
      ["{{ '}}' }}", "'}}'"],
      ['{{ `a}}b${c}` }}', '`a}}b${c}`'],
      ['{{ { a: { b: 1 } }.a }}', '{ a: { b: 1 } }.a'],
      ['{{ a > b ? "x" : "y" }}', 'a > b ? "x" : "y"'],
      ['{{ a < b }}', 'a < b'],
      ['{{ (n as number) + 1 }}', '(n as number) + 1'],
      ['{{ a /* }} */ }}', 'a /* }} */'],
    ];
    for (const [markup, code] of cases) {
      const node = clean(`<p>${markup}</p>`)[0];
      assert.ok(node?.kind === 'element');
      const interpolation = node.children[0];
      assert.ok(interpolation?.kind === 'interpolation', markup);
      assert.equal(interpolation.expression.code, code);
      assert.equal(interpolation.expression.verbatim, true);
    }
  });

  it('rejects code that is more than one expression', () => {
    only('<p>{{ a); evil(( }}</p>', 'sfc.invalid_expression');
  });

  it('rejects code ending in a line comment, which would swallow what follows it', () => {
    only('<p>{{ a // note }}</p>', 'sfc.invalid_expression');
    only('<p>{{ a // note\n }}</p>', 'sfc.invalid_expression');
    only('<p :t="a // note">x</p>', 'sfc.invalid_expression');
    only('<p @click="n++ // note">x</p>', 'sfc.invalid_expression');
    assert.equal(shape(clean('<p>{{ a /* note */ }}</p>')), '<p>{{a /* note */}}</p>');
    assert.equal(shape(clean('<p>{{ a // note\n + b }}</p>')), '<p>{{a // note\n + b}}</p>');
  });

  it('points an error at the end of an interpolation at its closing }}', () => {
    const invalid = only('<p>{{ a +}}</p>', 'sfc.invalid_expression');
    assert.equal(invalid.source.slice(invalid.start, invalid.end), '}}');
  });

  it('reports an empty, invalid or unterminated interpolation at its position', () => {
    only('<p>{{ }}</p>', 'sfc.empty_expression');
    const invalid = only('<p>{{ a + }}</p>', 'sfc.invalid_expression');
    assert.ok(invalid.start > '<template><p>{{'.length);
    only('<p>{{ a </p>', 'sfc.unterminated_interpolation');
  });

  it('keeps the message free of source text', () => {
    const invalid = only('<p>{{ secretToken + }}</p>', 'sfc.invalid_expression');
    assert.doesNotMatch(invalid.message, /secretToken/);
  });
});

describe('attributes', () => {
  it('classifies plain, bound, event, slot and directive attributes', () => {
    const node = element(
      clean(
        '<Card class="c" disabled :title="t" @click.prevent.stop="go()" js-model.trim="name" js-for="(item, index) in items" :key="item.id"></Card>',
      ),
    );
    const kinds = node.attributes.map((entry) => entry.kind);
    assert.deepEqual(kinds, ['static', 'static', 'bind', 'on', 'directive', 'directive', 'bind']);
    const event = attribute(node, 3);
    assert.ok(event.kind === 'on');
    assert.deepEqual(
      [event.event, event.modifiers, event.handlerForm],
      ['click', ['prevent', 'stop'], 'expression'],
    );
    const model = attribute(node, 4);
    assert.ok(model.kind === 'directive' && model.value.kind === 'name');
    assert.deepEqual([model.modifiers, model.value.name], [['trim'], 'name']);
    const loop = attribute(node, 5);
    assert.ok(loop.kind === 'directive' && loop.value.kind === 'for');
    assert.deepEqual(
      [loop.value.alias.code, loop.value.keyword, loop.value.source.code],
      ['item, index', 'in', 'items'],
    );
  });

  it('parses every js-for alias form', () => {
    const cases: readonly [string, string, string][] = [
      ['tag of page.tags', 'tag', 'page.tags'],
      ['n in 10', 'n', '10'],
      ['(value, key, index) in record', 'value, key, index', 'record'],
      ['{ id, name } in rows', '{ id, name }', 'rows'],
      ['[a, b] of pairs.filter((p) => p.x in y)', '[a, b]', 'pairs.filter((p) => p.x in y)'],
    ];
    for (const [value, alias, source] of cases) {
      const node = element(clean(`<li js-for="${value}" :key="1">x</li>`));
      const loop = attribute(node);
      assert.ok(loop.kind === 'directive' && loop.value.kind === 'for', value);
      assert.equal(loop.value.alias.code, alias);
      assert.equal(loop.value.source.code, source);
    }
    only('<li js-for="items" :key="1">x</li>', 'sfc.invalid_for');
  });

  it('accepts statement handlers and valueless modified events', () => {
    const node = element(
      clean('<form @submit.prevent><button @click="count++; save()">+</button></form>'),
    );
    const submit = attribute(node);
    assert.ok(submit.kind === 'on' && submit.handler === null);
    const click = attribute(element(node.children));
    assert.ok(click.kind === 'on');
    assert.equal(click.handlerForm, 'statements');
  });

  it('decodes character references in code-valued attributes, as HTML does', () => {
    const node = element(clean('<p :t="`say &quot;hi&quot;`">x</p>'));
    const bind = attribute(node);
    assert.ok(bind.kind === 'bind');
    assert.equal(bind.expression.code, '`say "hi"`');
    assert.equal(bind.expression.verbatim, false);
    const decoded = element(
      clean('<p :a="a &amp;&amp; b" :b="x&y" :c="\'?q=1&copy=2\'" js-if="n &lt; 2">x</p>'),
    );
    assert.deepEqual(
      decoded.attributes.map((entry) =>
        entry.kind === 'bind'
          ? [entry.expression.code, entry.expression.verbatim]
          : entry.kind === 'directive' && entry.value.kind === 'expression'
            ? [entry.value.expression.code, entry.value.expression.verbatim]
            : [],
      ),
      [
        ['a && b', false],
        ['x&y', true],
        ["'?q=1&copy=2'", true],
        ['n < 2', false],
      ],
    );
    const first = attribute(decoded);
    assert.ok(first.kind === 'bind');
    assert.equal(first.expression.end - first.expression.start, 'a &amp;&amp; b'.length);
  });

  it('parses slot props as a parameter list', () => {
    const node = element(clean('<List><template #row="{ item }">{{ item }}</template></List>'));
    const slot = attribute(element(node.children));
    assert.ok(slot.kind === 'slot');
    assert.equal(slot.name, 'row');
    assert.equal(slot.params?.code, '{ item }');
  });

  it('reports value errors per directive kind', () => {
    only('<p js-if>x</p>', 'sfc.missing_value');
    assert.equal(
      fixed('<p js-if="a">x</p><p js-else="b">y</p>', 'sfc.unexpected_value'),
      '<p js-if="a">x</p><p js-else>y</p>',
    );
    only('<input js-model="a.b">', 'sfc.invalid_name_value');
    only('<Counter js-hydrate="soon" />', 'sfc.invalid_name_value');
    only('<p js-wat="a">x</p>', 'sfc.unknown_directive');
    assert.equal(
      fixed('<input js-model.lazyy="a">', 'sfc.unknown_modifier'),
      '<input js-model="a">',
    );
    assert.equal(fixed('<p :title.camel="a">x</p>', 'sfc.unknown_modifier'), '<p :title="a">x</p>');
    only('<p :[name]="a">x</p>', 'sfc.dynamic_argument');
    only('<p :title="a +">x</p>', 'sfc.invalid_expression');
    only('<p @click>x</p>', 'sfc.missing_value');
  });

  it('reports a duplicate attribute, with a fix removing the second', () => {
    assert.equal(
      fixed('<p title="a" :title="b">x</p>', 'sfc.duplicate_attribute'),
      '<p title="a">x</p>',
    );
    clean('<p class="a" :class="b" style="c" :style="d">x</p>');
  });

  it('reports malformed attributes', () => {
    assert.ok(
      parse('<p title="a>x</p>').diagnostics.some(
        (entry) => entry.code === 'sfc.invalid_attribute',
      ),
    );
    only('<p title=a"b>x</p>', 'sfc.invalid_attribute');
  });
});

describe('removed syntax', () => {
  const cases: readonly [string, SfcDiagnosticCode, string][] = [
    ['<p title={page.title}>x</p>', 'sfc.legacy_syntax', '<p :title="page.title">x</p>'],
    ['<p title={a + "b"}>x</p>', 'sfc.legacy_syntax', `<p :title='a + "b"'>x</p>`],
    ['<p title="{{ t }}">x</p>', 'sfc.legacy_syntax', '<p :title="t">x</p>'],
    ['<a js-bind:href="url">x</a>', 'sfc.legacy_syntax', '<a :href="url">x</a>'],
    ['<b js-on:click.prevent="go">x</b>', 'sfc.legacy_syntax', '<b @click.prevent="go">x</b>'],
    ['<form js-submit="add">x</form>', 'sfc.legacy_syntax', '<form @submit="add">x</form>'],
    ['<b js-call="remove">x</b>', 'sfc.legacy_syntax', '<b @click="remove">x</b>'],
    ['<b js-intersect="more">x</b>', 'sfc.legacy_syntax', '<b @intersect="more">x</b>'],
    ['<b js-visible="open">x</b>', 'sfc.legacy_syntax', '<b js-show="open">x</b>'],
    ['<b js-content="text"></b>', 'sfc.legacy_syntax', '<b js-text="text"></b>'],
    ['<b js-once>x</b>', 'sfc.legacy_syntax', '<b>x</b>'],
    ['<p v-if="a">x</p>', 'sfc.vue_syntax', '<p js-if="a">x</p>'],
    ['<p v-bind:title="a">x</p>', 'sfc.vue_syntax', '<p :title="a">x</p>'],
    ['<p v-on:click="a">x</p>', 'sfc.vue_syntax', '<p @click="a">x</p>'],
  ];
  for (const [markup, code, repaired] of cases) {
    it(`fixes ${markup}`, () => {
      assert.equal(fixed(markup, code), repaired);
    });
  }

  it('replaces <component js-is> with :is', () => {
    const parsed = parse('<component js-is="Comp" />');
    const diagnostic = parsed.diagnostics.find((entry) => entry.code === 'sfc.legacy_syntax');
    assert.ok(diagnostic?.fix !== undefined);
    assert.equal(
      applySfcFix(parsed.source, diagnostic.fix),
      '<template><component :is="Comp" /></template>',
    );
  });

  it('warns on {name} in text, which is literal, with a fix to {{ }}', () => {
    const diagnostic = only('<p>Hello {name}!</p>', 'sfc.legacy_syntax');
    assert.equal(diagnostic.severity, 'warning');
    assert.equal(
      fixed('<p>Hello {page.title}!</p>', 'sfc.legacy_syntax'),
      '<p>Hello {{ page.title }}!</p>',
    );
  });

  it('does not warn on braces in code samples or prose that is not an identifier', () => {
    clean('<p>Use <code>{name}</code> or {a, b} or { spaced } or {}</p>');
    clean('<pre>{x}</pre>');
  });
});

describe('js-pre', () => {
  it('requires <!-- prettier-ignore --> before it, with a fix on its own line', () => {
    assert.equal(
      fixed('\n  <div js-pre>{{ a }}</div>\n', 'sfc.js_pre_needs_prettier_ignore'),
      '\n  <!-- prettier-ignore -->\n  <div js-pre>{{ a }}</div>\n',
    );
  });

  it('inserts the comment inline when the element is inside a line', () => {
    assert.equal(
      fixed('<p>See <code js-pre>{{ x }}</code></p>', 'sfc.js_pre_needs_prettier_ignore'),
      '<p>See <!-- prettier-ignore --><code js-pre>{{ x }}</code></p>',
    );
  });

  it('keeps text-only content of a raw subtree literal', () => {
    const nodes = clean('<!-- prettier-ignore -->\n<textarea js-pre>{{ a }}</textarea>');
    assert.equal(shape(nodes), '<textarea>"{{ a }}"</textarea>');
  });

  it('keeps a raw subtree literal: no interpolation, no directives, exact whitespace', () => {
    const nodes = clean(
      '<!-- prettier-ignore -->\n<div js-pre class="x">  {{a+b}} <b :t="p+q"  @click="z">&lt;</b>\n</div>',
    );
    const pre = element(nodes);
    assert.equal(pre.raw, true);
    assert.equal(shape(pre.children), '"  {{a+b}} "<b>"<"</b>"\\n"');
    const inner = element(pre.children);
    assert.equal(inner.raw, true);
    assert.deepEqual(
      inner.attributes.map((entry) => [entry.kind, entry.kind === 'static' ? entry.name : '']),
      [
        ['static', ':t'],
        ['static', '@click'],
      ],
    );
  });
});

describe('structure', () => {
  it('reports a stray else branch', () => {
    only('<p>a</p><p js-else>b</p>', 'sfc.stray_else');
    only('<p js-if="a">a</p>text<p js-else>b</p>', 'sfc.stray_else');
    clean('<p js-if="a">a</p>\n  <!-- c -->\n  <p js-else-if="b">b</p><p js-else>c</p>');
  });

  it('reports two branch directives on one element', () => {
    only('<p js-if="a" js-else>x</p>', 'sfc.conflicting_directives');
  });

  it('reports js-if with js-for, with a fix moving js-for to a template', () => {
    assert.equal(
      fixed('<li js-for="x in xs" js-if="x.ok" :key="x.id">{{ x }}</li>', 'sfc.if_with_for'),
      '<template js-for="x in xs"><li js-if="x.ok" :key="x.id">{{ x }}</li></template>',
    );
  });

  it('requires a structural directive on a nested template', () => {
    only('<template><p>x</p></template>', 'sfc.bare_template');
    assert.equal(
      fixed('<template js-if="a" class="c">x</template>', 'sfc.template_attribute'),
      '<template js-if="a">x</template>',
    );
  });

  it('puts #slot only on a template inside a component', () => {
    only('<div><template #x>y</template></div>', 'sfc.slot_outside_component');
    only('<Card #x>y</Card>', 'sfc.slot_outside_component');
  });

  it('forbids children beside js-text and js-html, with a fix', () => {
    assert.equal(
      fixed('<p js-text="t">old</p>', 'sfc.directive_with_children'),
      '<p js-text="t"></p>',
    );
    only('<p js-text="t" js-html="h"></p>', 'sfc.conflicting_directives');
    clean('<p js-html="h"> </p>');
  });

  it('requires :is on <component>', () => {
    only('<component />', 'sfc.component_without_is');
  });

  it('warns on js-for without a key', () => {
    const diagnostic = only('<li js-for="x in xs">{{ x }}</li>', 'sfc.for_without_key');
    assert.equal(diagnostic.severity, 'warning');
    clean('<template js-for="x in xs"><li :key="x">{{ x }}</li></template>');
  });
});

describe('whitespace rule', () => {
  const cases: readonly [string, string][] = [
    // Edges of the root template and of a block parent are insignificant.
    ['\n  <div> text </div>\n', '<div>"text"</div>'],
    // Edges of an inline parent are significant.
    ['<span> x </span>', '<span>" x "</span>'],
    // inline-block parents drop edge whitespace.
    ['<button> x </button>', '<button>"x"</button>'],
    // Next to a block sibling, whitespace is insignificant; nothing is added.
    ['<div>a</div> <div>b</div>', '<div>"a"</div><div>"b"</div>'],
    ['<div>text<p>x</p>more</div>', '<div>"text"<p>"x"</p>"more"</div>'],
    // Between inline siblings it becomes one space, line breaks included.
    ['<p><Card />\n    <Card /></p>', '<p><Card></Card>" "<Card></Card></p>'],
    ['<p><em>a</em> you <strong>b</strong></p>', '<p><em>"a"</em>" you "<strong>"b"</strong></p>'],
    ['<p>a\n      b\t c</p>', '<p>"a b c"</p>'],
    // No whitespace stays no whitespace.
    ['<p>a<button>x</button>b</p>', '<p>"a"<button>"x"</button>"b"</p>'],
    // inline-block siblings keep the whitespace between them.
    ['<p>a <svg></svg> b</p>', '<p>"a "<svg></svg>" b"</p>'],
    // Inside svg, every element but svg itself is block.
    ['<svg> <g></g> <g></g> </svg>', '<svg><g></g><g></g></svg>'],
    // A display: none parent drops boundary whitespace.
    [
      '<datalist> <option>a</option> <b>x</b> </datalist>',
      '<datalist><option>"a"</option><b>"x"</b></datalist>',
    ],
    // Whitespace that is a parent's only child.
    ['<span> </span><div> </div>', '<span>" "</span><div></div>'],
    // Whitespace between the branches of a chain renders nowhere.
    ['<span js-if="a">x</span> <span js-else>y</span>', '<span>"x"</span><span>"y"</span>'],
    // A display comment overrides the table, as in Prettier.
    ['<p>a <!-- display: block --> <span>x</span> b</p>', '<p>"a"<span>"x"</span>"b"</p>'],
    // Prettier's override has no hyphenated value: a <div> stays block.
    [
      '<section>a <!-- display: inline-block --> <div>x</div></section>',
      '<section>"a"<div>"x"</div></section>',
    ],
    // In a foreignObject, svg elements take the table's display (svg: inline).
    [
      '<svg><foreignObject> <svg> <g></g> </svg> </foreignObject></svg>',
      '<svg><foreignObject>" "<svg>" "<g></g>" "</svg>" "</foreignObject></svg>',
    ],
    // Interpolations are inline text.
    ['<p>{{ a }} {{ b }}</p>', '<p>{{a}}" "{{b}}</p>'],
    // An encoded space is content, not whitespace.
    ['<div>&#32;x&#10;</div>', '<div>" x\\n"</div>'],
  ];
  for (const [markup, expected] of cases) {
    it(`condenses ${JSON.stringify(markup)}`, () => {
      assert.equal(shape(clean(markup)), expected);
    });
  }
});

describe('tables pinned to the installed Prettier', () => {
  const prettierHtml = readFileSync(
    fileURLToPath(import.meta.resolve('prettier/plugins/html')),
    'utf8',
  );

  /** The object literal in Prettier's bundle that starts with `start`, read by oxc. */
  function literalStartingWith(start: string): Record<string, string> {
    const at = prettierHtml.indexOf(`{${start}`);
    assert.ok(at !== -1, `Prettier no longer contains {${start}`);
    const match = /^\{(?:"(?:[^"\\]|\\.)*"|[^"}])*\}/.exec(prettierHtml.slice(at));
    assert.ok(match !== null);
    const parsed = parseSync('table.js', `(${match[0]})`, { sourceType: 'module' });
    const statement = parsed.program.body[0];
    assert.ok(statement?.type === 'ExpressionStatement');
    let object = statement.expression;
    while (object.type === 'ParenthesizedExpression') {
      object = object.expression;
    }
    assert.ok(object.type === 'ObjectExpression');
    const entries: Record<string, string> = {};
    for (const property of object.properties) {
      assert.ok(property.type === 'Property' && property.key.type === 'Identifier');
      const { value } = property;
      if (value.type === 'TemplateLiteral') {
        assert.equal(value.expressions.length, 0);
        entries[property.key.name] = value.quasis[0]?.value.cooked ?? '';
        continue;
      }
      assert.ok(value.type === 'Literal' && typeof value.value === 'string');
      entries[property.key.name] = value.value;
    }
    return entries;
  }

  it('copies the default-display table exactly', () => {
    assert.deepEqual(literalStartingWith('area:"none"'), { ...ELEMENT_DISPLAY });
  });

  it('copies the white-space table exactly', () => {
    assert.deepEqual(literalStartingWith('listing:"pre"'), { ...ELEMENT_WHITE_SPACE });
  });

  it('reads display override comments with the pattern Prettier uses', () => {
    assert.ok(
      prettierHtml.includes(`.match(/${DISPLAY_OVERRIDE_COMMENT.source}/)`),
      'Prettier changed its display comment pattern',
    );
  });

  it('copies the implied-end-tag table exactly', () => {
    const at = prettierHtml.indexOf('{base:new ');
    assert.ok(at !== -1, 'Prettier no longer defines its tag table as expected');
    const end = prettierHtml.indexOf('}),new ', at);
    const parsed = parseSync('tags.js', `(${prettierHtml.slice(at, end + 1)})`, {
      sourceType: 'module',
    });
    const statement = parsed.program.body[0];
    assert.ok(statement?.type === 'ExpressionStatement');
    let object = statement.expression;
    while (object.type === 'ParenthesizedExpression') {
      object = object.expression;
    }
    assert.ok(object.type === 'ObjectExpression');
    const table: Record<string, string[]> = {};
    for (const property of object.properties) {
      assert.ok(property.type === 'Property' && property.key.type === 'Identifier');
      const call = property.value;
      assert.ok(call.type === 'NewExpression');
      const options = call.arguments[0];
      if (options?.type !== 'ObjectExpression') {
        continue;
      }
      for (const option of options.properties) {
        if (
          option.type === 'Property' &&
          option.key.type === 'Identifier' &&
          option.key.name === 'closedByChildren'
        ) {
          assert.ok(option.value.type === 'ArrayExpression');
          table[property.key.name] = option.value.elements.map((element) => {
            assert.ok(element?.type === 'Literal' && typeof element.value === 'string');
            return element.value;
          });
        }
      }
    }
    assert.deepEqual(
      table,
      Object.fromEntries(
        Object.entries(CLOSED_BY_CHILDREN).map(([parent, children]) => [parent, [...children]]),
      ),
    );
  });

  it('defaults unknown elements to inline, as Prettier does', () => {
    assert.equal(DEFAULT_DISPLAY, 'inline');
    assert.match(prettierHtml, /="inline",\w+=\{area:"none"/);
  });

  it('accepts exactly the named entities Prettier accepts', () => {
    const prettier = literalStartingWith('AElig:');
    assert.deepEqual(Object.fromEntries(htmlNamedEntities()), prettier);
  });
});
