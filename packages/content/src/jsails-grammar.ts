/**
 * The TextMate grammar of `.jsails` files, the one source of their highlighting.
 * Shiki loads it for ` ```jsails ` fences (`highlight.ts`), and the private
 * VS Code extension (`editors/vscode`) generates its JSON from this module.
 *
 * Scopes (sfc-plan §3.5): `<script>` blocks are `source.tsx`, because their
 * code is copied verbatim into a `.tsx` shadow; `<style>` blocks are
 * `source.css`; `<template>` blocks are HTML-like, with `{{ }}`, `:x`, `@x`,
 * `#x` and expression-valued `js-*` values embedded as TSX expressions (event
 * handlers as statements). The value kinds follow the compiler's directive
 * table: `js-model`, `js-sort` and `js-ref` take a name, `js-hydrate` a
 * trigger, `js-for` an alias, `in`/`of` and a source, and `js-loading` and the
 * other bare directives take none; every other `js-*` value, removed
 * spellings and a value on a bare directive included, is an expression,
 * because the grammar highlights and the compiler validates.
 *
 * Two limits are TextMate's: a rule cannot count same-name elements, so a
 * `js-pre` raw region ends at the first end tag of its own name, and a nested
 * `<template … />` is recognised as self-closing only when its start tag is on
 * one line.
 */

import type { LanguageRegistration } from 'shiki';

/** One TextMate rule. */
type Rule = LanguageRegistration['patterns'][number];
/** A rule's capture map. */
type Captures = NonNullable<Rule['captures']>;

/** An attribute name: anything HTML allows up to whitespace, quotes, `/`, `=` or `>`. */
const NAME = String.raw`[^\s"'<>/=]+`;
/** An attribute name that cannot contain a modifier dot (`@click.prevent`). */
const NAME_NO_DOT = String.raw`[^\s"'<>/=.]+`;
/** `=` and the opening quote of an attribute value. */
const VALUE_OPEN = String.raw`\s*(=)\s*(["'])`;
/** A tag name. */
const TAG = String.raw`[A-Za-z][\w.:-]*`;
/** A component tag, as the compiler tells one (`isComponentTag`): capitalized or dotted. */
const COMPONENT_TAG = String.raw`[A-Z][\w.:-]*|[a-z][\w:-]*\.[\w.:-]*`;
/** The end of a tag name. */
const TAG_END = String.raw`(?=[\s/>]|$)`;

const TAG_OPEN: Rule = { name: 'punctuation.definition.tag.begin.html' };
const TAG_CLOSE: Rule = { name: 'punctuation.definition.tag.end.html' };
const HTML_TAG: Rule = { name: 'entity.name.tag.html' };
const COMPONENT: Rule = { name: 'support.class.component.jsails' };
const EQUALS: Rule = { name: 'punctuation.separator.key-value.html' };
const QUOTE_OPEN: Rule = { name: 'punctuation.definition.string.begin.html' };
const QUOTE_CLOSE: Rule = { name: 'punctuation.definition.string.end.html' };
const ATTRIBUTE_NAME: Rule = { name: 'entity.other.attribute-name.html' };
const DIRECTIVE_NAME: Rule = { name: 'entity.other.attribute-name.directive.jsails' };

/** The modifiers after an event or directive name, each `.` and name scoped apart. */
const MODIFIERS: Rule = {
  patterns: [
    {
      match: String.raw`(\.)(${NAME_NO_DOT})`,
      captures: {
        1: { name: 'punctuation.separator.modifier.jsails' },
        2: { name: 'entity.other.attribute-name.modifier.jsails' },
      },
    },
  ],
};

const EXPRESSION: Rule[] = [{ include: 'source.tsx#expression' }];
const EMBEDDED_EXPRESSION = 'meta.embedded.expression.jsails';

/**
 * A quoted attribute value: `prefix` matches the name part, whose groups are
 * scoped by `groups` in order; the value's content is scoped `contentName`
 * and tokenized by `patterns`.
 */
function quotedValue(
  prefix: string,
  groups: readonly Rule[],
  name: string,
  contentName: string | undefined,
  patterns: Rule[],
): Rule {
  const beginCaptures: Captures = {};
  [...groups, EQUALS, QUOTE_OPEN].forEach((rule, index) => {
    beginCaptures[String(index + 1)] = rule;
  });
  return {
    begin: `${prefix}${VALUE_OPEN}`,
    beginCaptures,
    // The closing quote is the one that opened the value.
    end: `(\\${groups.length + 2})`,
    endCaptures: { 1: QUOTE_CLOSE },
    name,
    ...(contentName === undefined ? {} : { contentName }),
    patterns,
  };
}

/** The start tag of a block, its attributes all plain. */
function blockStartTag(): Rule {
  return {
    begin: String.raw`\G`,
    end: '(/?)(>)',
    endCaptures: { 1: TAG_CLOSE, 2: TAG_CLOSE },
    name: 'meta.tag.start.jsails',
    patterns: [{ include: '#attribute-plain' }],
  };
}

/** A top-level `<script>` or `<style>` block whose content is `scope`. */
function rawTextBlock(tag: string, scope: string): Rule {
  return {
    begin: String.raw`(<)(${tag})(?![\w.:-])`,
    beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
    end: String.raw`(</)(${tag})\s*(>)`,
    endCaptures: { 1: TAG_OPEN, 2: HTML_TAG, 3: TAG_CLOSE },
    name: `meta.block.${tag}.jsails`,
    patterns: [
      blockStartTag(),
      {
        begin: '(?<=>)',
        end: String.raw`(?=</${tag}\s*>)`,
        contentName: scope,
        patterns: [{ include: scope }],
      },
    ],
  };
}

/** Freeze a JSON-shaped value and everything in it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The `.jsails` TextMate grammar, deep-frozen; Shiki loads it after `tsx` and `css`. */
export const jsailsGrammar: LanguageRegistration = deepFreeze({
  name: 'jsails',
  displayName: 'JSails',
  scopeName: 'source.jsails',
  embeddedLangs: ['tsx', 'css'],
  patterns: [
    { include: '#comment' },
    { include: '#block-script' },
    { include: '#block-style' },
    { include: '#block-template' },
    { include: '#tag-start' },
    { include: '#tag-end' },
  ],
  repository: {
    comment: {
      begin: '<!--',
      beginCaptures: { 0: { name: 'punctuation.definition.comment.html' } },
      end: '-->',
      endCaptures: { 0: { name: 'punctuation.definition.comment.html' } },
      name: 'comment.block.html',
    },
    entity: {
      match: '(&)(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*)(;)',
      captures: {
        1: { name: 'punctuation.definition.entity.html' },
        3: { name: 'punctuation.definition.entity.html' },
      },
      name: 'constant.character.entity.html',
    },
    'block-script': rawTextBlock('script', 'source.tsx'),
    'block-style': rawTextBlock('style', 'source.css'),
    'block-template': {
      begin: String.raw`(<)(template)(?![\w.:-])`,
      beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
      end: String.raw`(</)(template)\s*(>)`,
      endCaptures: { 1: TAG_OPEN, 2: HTML_TAG, 3: TAG_CLOSE },
      name: 'meta.block.template.jsails',
      patterns: [blockStartTag(), { include: '#template-content' }],
    },
    'template-content': {
      patterns: [
        { include: '#comment' },
        { include: '#template-element-self-closing' },
        { include: '#template-element' },
        { include: '#raw-element' },
        { include: '#tag-start' },
        { include: '#tag-end' },
        { include: '#interpolation' },
        { include: '#entity' },
      ],
    },
    // A nested `<template … />` on one line: it has no content to enclose.
    'template-element-self-closing': {
      begin: String.raw`(<)(template)(?=(?:[^>"']|"[^"]*"|'[^']*')*/>)`,
      beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
      end: '(/)(>)',
      endCaptures: { 1: TAG_CLOSE, 2: TAG_CLOSE },
      name: 'meta.tag.start.jsails',
      patterns: [{ include: '#template-attribute' }],
    },
    // A nested `<template>` is matched with its end tag, so that end tag never
    // closes the enclosing block.
    'template-element': {
      begin: String.raw`(<)(template)(?![\w.:-])`,
      beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
      end: String.raw`(</)(template)\s*(>)`,
      endCaptures: { 1: TAG_OPEN, 2: HTML_TAG, 3: TAG_CLOSE },
      name: 'meta.element.template.jsails',
      patterns: [
        {
          begin: String.raw`\G`,
          end: '(>)',
          endCaptures: { 1: TAG_CLOSE },
          name: 'meta.tag.start.jsails',
          patterns: [{ include: '#template-attribute' }],
        },
        { include: '#template-content' },
      ],
    },
    // An element whose start tag (on one line) carries `js-pre`: its content
    // is raw, no interpolation and no directives, up to its end tag. The end
    // pattern wins over the inner end-tag rule at the same position, so only
    // an end tag of the element's own name closes it.
    'raw-element': {
      begin: String.raw`(<)(${TAG})(?=(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?)*?\s+js-pre(?:[\s/>=]|$))`,
      beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
      end: String.raw`(</)(\2)\s*(>)`,
      endCaptures: { 1: TAG_OPEN, 2: HTML_TAG, 3: TAG_CLOSE },
      name: 'meta.element.raw.jsails',
      patterns: [
        {
          begin: String.raw`\G`,
          end: '(/?)(>)',
          endCaptures: { 1: TAG_CLOSE, 2: TAG_CLOSE },
          name: 'meta.tag.start.jsails',
          patterns: [{ include: '#directive-bare' }, { include: '#attribute-plain' }],
        },
        { include: '#comment' },
        { include: '#entity' },
        {
          begin: String.raw`(<)(${TAG})${TAG_END}`,
          beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
          end: '(/?)(>)',
          endCaptures: { 1: TAG_CLOSE, 2: TAG_CLOSE },
          name: 'meta.tag.start.jsails',
          patterns: [{ include: '#attribute-plain' }],
        },
        { include: '#tag-end-plain' },
      ],
    },
    'tag-start': {
      patterns: [
        {
          begin: String.raw`(<)(${COMPONENT_TAG})${TAG_END}`,
          beginCaptures: { 1: TAG_OPEN, 2: COMPONENT },
          end: '(/?)(>)',
          endCaptures: { 1: TAG_CLOSE, 2: TAG_CLOSE },
          name: 'meta.tag.start.jsails',
          patterns: [{ include: '#template-attribute' }],
        },
        {
          begin: String.raw`(<)(${TAG})${TAG_END}`,
          beginCaptures: { 1: TAG_OPEN, 2: HTML_TAG },
          end: '(/?)(>)',
          endCaptures: { 1: TAG_CLOSE, 2: TAG_CLOSE },
          name: 'meta.tag.start.jsails',
          patterns: [{ include: '#template-attribute' }],
        },
      ],
    },
    'tag-end': {
      patterns: [
        {
          match: String.raw`(</)(${COMPONENT_TAG})\s*(>)`,
          captures: { 1: TAG_OPEN, 2: COMPONENT, 3: TAG_CLOSE },
          name: 'meta.tag.end.jsails',
        },
        { include: '#tag-end-plain' },
      ],
    },
    'tag-end-plain': {
      match: String.raw`(</)(${TAG})\s*(>)`,
      captures: { 1: TAG_OPEN, 2: HTML_TAG, 3: TAG_CLOSE },
      name: 'meta.tag.end.jsails',
    },
    interpolation: {
      begin: String.raw`\{\{`,
      beginCaptures: { 0: { name: 'punctuation.definition.interpolation.begin.jsails' } },
      end: String.raw`\}\}`,
      endCaptures: { 0: { name: 'punctuation.definition.interpolation.end.jsails' } },
      name: 'meta.interpolation.jsails',
      contentName: EMBEDDED_EXPRESSION,
      patterns: EXPRESSION,
    },
    'template-attribute': {
      patterns: [
        { include: '#attribute-bind' },
        { include: '#attribute-event' },
        { include: '#attribute-slot' },
        { include: '#directive-for' },
        { include: '#directive-name' },
        { include: '#directive-hydrate' },
        { include: '#directive-expression' },
        { include: '#directive-bare' },
        { include: '#attribute-plain' },
      ],
    },
    'attribute-bind': {
      patterns: [
        quotedValue(
          `(:)(${NAME})`,
          [{ name: 'punctuation.attribute-shorthand.bind.jsails' }, ATTRIBUTE_NAME],
          'meta.attribute.bind.jsails',
          EMBEDDED_EXPRESSION,
          EXPRESSION,
        ),
        {
          match: String.raw`(:)(${NAME})(?!\s*=)`,
          captures: {
            1: { name: 'punctuation.attribute-shorthand.bind.jsails' },
            2: ATTRIBUTE_NAME,
          },
          name: 'meta.attribute.bind.jsails',
        },
      ],
    },
    'attribute-event': {
      patterns: [
        quotedValue(
          `(@)(${NAME_NO_DOT})((?:\\.${NAME_NO_DOT})*)`,
          [
            { name: 'punctuation.attribute-shorthand.event.jsails' },
            { name: 'entity.other.attribute-name.event.jsails' },
            MODIFIERS,
          ],
          'meta.attribute.event.jsails',
          EMBEDDED_EXPRESSION,
          [{ include: 'source.tsx#statements' }],
        ),
        {
          match: String.raw`(@)(${NAME_NO_DOT})((?:\.${NAME_NO_DOT})*)(?!\s*=)`,
          captures: {
            1: { name: 'punctuation.attribute-shorthand.event.jsails' },
            2: { name: 'entity.other.attribute-name.event.jsails' },
            3: MODIFIERS,
          },
          name: 'meta.attribute.event.jsails',
        },
      ],
    },
    'attribute-slot': {
      patterns: [
        quotedValue(
          `(#)(${NAME})`,
          [
            { name: 'punctuation.attribute-shorthand.slot.jsails' },
            { name: 'entity.other.attribute-name.slot.jsails' },
          ],
          'meta.attribute.slot.jsails',
          'meta.embedded.parameters.jsails',
          EXPRESSION,
        ),
        {
          match: String.raw`(#)(${NAME})(?!\s*=)`,
          captures: {
            1: { name: 'punctuation.attribute-shorthand.slot.jsails' },
            2: { name: 'entity.other.attribute-name.slot.jsails' },
          },
          name: 'meta.attribute.slot.jsails',
        },
      ],
    },
    'directive-for': quotedValue(
      '(js-for)',
      [DIRECTIVE_NAME],
      'meta.attribute.directive.jsails',
      EMBEDDED_EXPRESSION,
      [
        { match: String.raw`(?<=\s)(in|of)(?=\s)`, name: 'keyword.control.loop.jsails' },
        ...EXPRESSION,
      ],
    ),
    'directive-name': quotedValue(
      `(js-(?:model|sort|ref))((?:\\.${NAME_NO_DOT})*)`,
      [DIRECTIVE_NAME, MODIFIERS],
      'meta.attribute.directive.jsails',
      undefined,
      [{ match: String.raw`[A-Za-z_$][\w$]*`, name: 'variable.other.property.jsails' }],
    ),
    'directive-hydrate': quotedValue(
      '(js-hydrate)',
      [DIRECTIVE_NAME],
      'meta.attribute.directive.jsails',
      undefined,
      [{ match: '[A-Za-z]+', name: 'support.constant.hydrate.jsails' }],
    ),
    'directive-expression': quotedValue(
      `(js-[\\w-]+)((?:\\.${NAME_NO_DOT})*)`,
      [DIRECTIVE_NAME, MODIFIERS],
      'meta.attribute.directive.jsails',
      EMBEDDED_EXPRESSION,
      EXPRESSION,
    ),
    'directive-bare': {
      match: String.raw`(js-[\w-]+)((?:\.${NAME_NO_DOT})*)(?![\w.-]|\s*=)`,
      captures: { 1: DIRECTIVE_NAME, 2: MODIFIERS },
      name: 'meta.attribute.directive.jsails',
    },
    'attribute-plain': {
      patterns: [
        quotedValue(`(${NAME})`, [ATTRIBUTE_NAME], 'meta.attribute.jsails', 'string.quoted.html', [
          { include: '#entity' },
        ]),
        {
          match: String.raw`(${NAME})\s*(=)\s*([^\s"'=<>\x60]+)`,
          captures: { 1: ATTRIBUTE_NAME, 2: EQUALS, 3: { name: 'string.unquoted.html' } },
          name: 'meta.attribute.jsails',
        },
        { match: NAME, name: 'meta.attribute.jsails entity.other.attribute-name.html' },
      ],
    },
  },
});
