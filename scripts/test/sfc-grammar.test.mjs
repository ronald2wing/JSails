/**
 * The `.jsails` TextMate grammar (`packages/content/src/jsails-grammar.ts`)
 * against the compiler's directive table (`core/src/compiler/directives.ts`):
 * every directive's value tokenizes by the kind of value the table declares,
 * every modifier and hydration trigger is scoped, and the removed spellings
 * still highlight as directives, so the grammar cannot drift from the table.
 *
 * It reads both workspaces' builds, as every CI leg, `npm test` and
 * `npm run check` build before the tooling tests.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../workspaces.mjs';

const DIRECTIVES_MODULE = join(repoRoot, 'core', 'dist', 'src', 'compiler', 'directives.js');
const GRAMMAR_MODULE = join(repoRoot, 'packages', 'content', 'dist', 'src', 'jsails-grammar.js');

let table;
let highlighter;

before(async () => {
  for (const module of [DIRECTIVES_MODULE, GRAMMAR_MODULE]) {
    if (!existsSync(module))
      throw new Error(
        'sfc-grammar reads core/dist and packages/content/dist: run npm run build first',
      );
  }
  table = await import(pathToFileURL(DIRECTIVES_MODULE).href);
  const { jsailsGrammar } = await import(pathToFileURL(GRAMMAR_MODULE).href);
  // Shiki as @jsails/content loads it.
  const shiki = await import(
    pathToFileURL(
      createRequire(join(repoRoot, 'packages', 'content', 'package.json')).resolve('shiki'),
    ).href
  );
  highlighter = await shiki.createHighlighter({ themes: ['github-light'], langs: ['tsx', 'css'] });
  await highlighter.loadLanguage(jsailsGrammar);
});

/** Each non-blank token of the attribute list `attributes` on a `<p>`, with its scopes. */
function tokens(attributes) {
  const lines = highlighter.codeToTokensBase(`<template><p ${attributes}></p></template>`, {
    lang: 'jsails',
    includeExplanation: 'scopeName',
    // Shiki stops a line after 500 ms by default; under a loaded CI runner
    // its two tokenizer passes then disagree and the explanation is cut off.
    tokenizeTimeLimit: 0,
  });
  return lines
    .flat()
    .flatMap((token) => token.explanation)
    .filter((part) => part.content.trim() !== '')
    .map((part) => ({ text: part.content, scopes: part.scopes.map((scope) => scope.scopeName) }));
}

/** The scopes of the token `text` in `attributes`. */
function scopesOf(attributes, text) {
  const token = tokens(attributes).find((entry) => entry.text === text);
  assert.ok(token !== undefined, `${attributes} has a token ${JSON.stringify(text)}`);
  return token.scopes;
}

function assertScope(attributes, text, scope) {
  assert.ok(
    scopesOf(attributes, text).includes(scope),
    `${JSON.stringify(text)} in ${attributes} is ${scope}`,
  );
}

function refuteScope(attributes, text, scope) {
  assert.ok(
    !scopesOf(attributes, text).includes(scope),
    `${JSON.stringify(text)} in ${attributes} is not ${scope}`,
  );
}

const DIRECTIVE = 'entity.other.attribute-name.directive.jsails';
const EXPRESSION = 'meta.embedded.expression.jsails';
const NAME = 'variable.other.property.jsails';
const MODIFIER = 'entity.other.attribute-name.modifier.jsails';

describe('jsails grammar and the directive table', () => {
  it('tokenizes every directive value by the kind the table declares', () => {
    const kinds = new Set();
    for (const [name, spec] of Object.entries(table.DIRECTIVES)) {
      kinds.add(spec.value);
      switch (spec.value) {
        case 'expression':
          assertScope(`${name}="alpha + 1"`, name, DIRECTIVE);
          assertScope(`${name}="alpha + 1"`, 'alpha', EXPRESSION);
          refuteScope(`${name}="alpha + 1"`, 'alpha', NAME);
          break;
        case 'name':
          assertScope(`${name}="alpha"`, name, DIRECTIVE);
          assertScope(`${name}="alpha"`, 'alpha', NAME);
          refuteScope(`${name}="alpha"`, 'alpha', EXPRESSION);
          break;
        case 'none':
          assertScope(name, name, DIRECTIVE);
          // A value the compiler refuses never highlights as a name.
          refuteScope(`${name}="alpha"`, 'alpha', NAME);
          break;
        case 'for':
          assertScope(`${name}="(item, i) of items"`, 'of', 'keyword.control.loop.jsails');
          assertScope(`${name}="item in items"`, 'in', 'keyword.control.loop.jsails');
          assertScope(`${name}="item in items"`, 'items', EXPRESSION);
          break;
        case 'hydrate':
          for (const trigger of table.HYDRATE_TRIGGERS) {
            assertScope(`${name}="${trigger}"`, trigger, 'support.constant.hydrate.jsails');
          }
          break;
        default:
          assert.fail(`the grammar test has no case for ${spec.value} values (${name})`);
      }
    }
    assert.deepEqual(
      [...kinds].sort(),
      ['expression', 'for', 'hydrate', 'name', 'none'],
      'every value kind is exercised',
    );
  });

  it('scopes every directive and event modifier', () => {
    for (const [name, spec] of Object.entries(table.DIRECTIVES)) {
      for (const modifier of spec.modifiers) {
        assertScope(`${name}.${modifier}="alpha"`, modifier, MODIFIER);
      }
    }
    for (const modifier of table.EVENT_MODIFIERS) {
      assertScope(`@click.${modifier}="go()"`, modifier, MODIFIER);
    }
  });

  it('highlights the removed spellings as directives, which the compiler reports', () => {
    for (const name of Object.keys(table.REMOVED_DIRECTIVES)) {
      assertScope(`${name}="alpha"`, name, DIRECTIVE);
    }
  });
});
