/**
 * Tests for the jsails/view barrel: it exports exactly the template runtime helpers and the island seam, the template helpers import nothing, and the island modules import only Preact, the error kernel and the JSON key guard, so the subpath stays browser-safe.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as view from '../../src/view/index.js';

const source = (module: string): string =>
  readFileSync(new URL(`../../src/view/${module}`, import.meta.url), 'utf8');

const specifiers = (code: string): string[] =>
  [...code.matchAll(/^import [^;]*? from '([^']+)';/gms)].map((match) => match[1] as string);

describe('jsails/view', () => {
  it('exports the template runtime helpers and the island seam', () => {
    assert.deepEqual(Object.keys(view).sort(), [
      'ISLAND_STYLE',
      'Island',
      'IslandErrors',
      'bindAttributes',
      'bindControl',
      'defineIsland',
      'emitter',
      'normalizeClass',
      'normalizeStyle',
      'renderList',
    ]);
  });

  it('has template helpers with no imports', () => {
    for (const module of ['class-style.js', 'render-list.js', 'emit.js', 'control-binding.js']) {
      assert.doesNotMatch(source(module), /\bimport\b/, module);
    }
  });

  it('has island modules that import Preact and browser-safe kernels only', () => {
    assert.deepEqual(specifiers(source('island.js')), ['preact', './island-props.js']);
    assert.deepEqual(specifiers(source('island-props.js')), [
      '../errors/registry.js',
      '../json/shape.js',
    ]);
  });
});
