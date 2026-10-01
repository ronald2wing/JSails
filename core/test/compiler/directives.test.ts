/**
 * Tests for the js-* directive table: its shape, the kinds each directive is allowed in, the removed spellings and their replacements, and the lookup that ignores inherited object keys.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SFC_KINDS } from '../../src/compiler/conventions.js';
import {
  DIRECTIVES,
  EVENT_MODIFIERS,
  HYDRATE_TRIGGERS,
  REMOVED_DIRECTIVE_PREFIXES,
  REMOVED_DIRECTIVES,
  directiveAllowedIn,
  directiveSpec,
} from '../../src/compiler/directives.js';

describe('directive table', () => {
  it('lists exactly the grammar of sfc-plan section 2.4', () => {
    assert.deepEqual(Object.keys(DIRECTIVES).sort(), [
      'js-bind',
      'js-confirm',
      'js-else',
      'js-else-if',
      'js-for',
      'js-html',
      'js-hydrate',
      'js-if',
      'js-ignore',
      'js-loading',
      'js-model',
      'js-poll',
      'js-pre',
      'js-ref',
      'js-show',
      'js-sort',
      'js-text',
    ]);
  });

  it('gives name values to the directives that name a state key, action or ref', () => {
    const names = Object.entries(DIRECTIVES)
      .filter(([, spec]) => spec.value === 'name')
      .map(([name]) => name)
      .sort();
    assert.deepEqual(names, ['js-model', 'js-ref', 'js-sort']);
  });

  it('maps every live render-tool directive to a tool name', () => {
    assert.equal(DIRECTIVES['js-model']?.liveTool, 'bind');
    assert.equal(DIRECTIVES['js-loading']?.liveTool, 'loadingTarget');
    assert.equal(DIRECTIVES['js-if']?.liveTool, undefined);
  });

  it('is frozen and never resolves inherited keys', () => {
    assert.ok(Object.isFrozen(DIRECTIVES));
    assert.equal(directiveSpec('constructor'), undefined);
    assert.equal(directiveSpec('__proto__'), undefined);
    assert.equal(directiveSpec('js-if')?.value, 'expression');
  });

  it('replaces every removed spelling with a directive or shorthand that exists', () => {
    for (const replacement of Object.values(REMOVED_DIRECTIVES)) {
      if (replacement === '' || /^[:@]/.test(replacement)) {
        continue;
      }
      assert.ok(directiveSpec(replacement) !== undefined, replacement);
    }
    assert.deepEqual(REMOVED_DIRECTIVE_PREFIXES, { 'js-bind:': ':', 'js-on:': '@' });
    assert.equal(directiveSpec('js-submit'), undefined);
  });

  it('accepts the event modifiers and hydration triggers of the grammar', () => {
    assert.deepEqual([...EVENT_MODIFIERS].sort(), [
      'capture',
      'once',
      'passive',
      'prevent',
      'self',
      'stop',
    ]);
    assert.deepEqual(HYDRATE_TRIGGERS, ['load', 'idle', 'visible']);
  });
});

describe('directive kinds', () => {
  it('allows the structural directives in every kind', () => {
    for (const name of ['js-if', 'js-else-if', 'js-else', 'js-for', 'js-show', 'js-text']) {
      for (const kind of SFC_KINDS) {
        assert.ok(directiveAllowedIn(name, kind), `${name} in ${kind}`);
      }
    }
  });

  it('keeps the render-tool directives to live components and js-model to live and island', () => {
    for (const name of ['js-confirm', 'js-loading', 'js-poll', 'js-sort', 'js-ref', 'js-ignore']) {
      assert.deepEqual(DIRECTIVES[name]?.kinds, ['live'], name);
    }
    assert.deepEqual(DIRECTIVES['js-model']?.kinds, ['live', 'island']);
    assert.equal(directiveAllowedIn('js-model', 'view'), false);
    assert.equal(directiveAllowedIn('js-confirm', 'page'), false);
  });

  it('allows js-hydrate only where an island can be mounted', () => {
    assert.deepEqual(DIRECTIVES['js-hydrate']?.kinds, [
      'page',
      'layout',
      'error',
      'not-found',
      'view',
    ]);
    assert.equal(directiveAllowedIn('js-hydrate', 'live'), false);
    assert.equal(directiveAllowedIn('js-unknown', 'view'), false);
  });
});
