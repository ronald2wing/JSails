/**
 * Tests for the scope pass and the name resolver: free names resolve as template locals, setup and script bindings, `context`, catalog imports, built-ins, then props, in that order; each implicit prop is an Alias of its first use; module-scope names never become props; component tags resolve through the catalog only; and over the whole corpus no free identifier is left outside the built-in list.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import {
  BUILTIN_NAMES,
  EMPTY_RESOLVER,
  importSpecifier,
  nameTable,
} from '../../../src/compiler/sfc/name-resolver.js';
import { SpanKind } from '../../../src/compiler/sfc/segments.js';
import { collectFreeReferences } from '../../../src/compiler/scope-walker.js';
import { CORPUS_RESOLVER, SFC_CORPUS } from './corpus.js';

function lower(source: string, file = 'ui/probe.jsails'): SfcLowering {
  const lowering = lowerSfc(source, file, { resolver: CORPUS_RESOLVER });
  assert.deepEqual(lowering.diagnostics, []);
  return lowering;
}

/** The `const name = …;` lines the lowering put at the top of the render function. */
function prelude(lowering: SfcLowering): readonly string[] {
  return [...lowering.tsx.matchAll(/^ {2}const (\w+) = (__props\.\w+|__context);$/gm)].map(
    (match) => `${match[1]} = ${match[2]}`,
  );
}

describe('analyseScope', () => {
  it('declares each free template name as a prop, in order of first use', () => {
    const lowering = lower('<template><p :title="b">{{ a }}{{ b }}{{ c.d }}</p></template>');
    assert.deepEqual(prelude(lowering), ['b = __props.b', 'a = __props.a', 'c = __props.c']);
  });

  it('maps the property name of an implicit prop to its first use as an Alias', () => {
    const source = '<template><p>{{ total }} {{ total }}</p></template>';
    const shadow = lower(source).shadow;
    assert.ok(shadow !== null);
    const at = shadow.text.indexOf('__props.total') + '__props.'.length;
    const span = shadow.spans.find((entry) => entry.generatedStart === at);
    assert.equal(span?.kind, SpanKind.Alias);
    assert.equal(span?.generatedEnd, at + 'total'.length);
    assert.equal(span?.originalStart, source.indexOf('total'));
    assert.equal(span?.originalEnd, source.indexOf('total') + 'total'.length);
  });

  it('leaves js-for aliases, slot props and setup bindings bound', () => {
    const lowering = lower(
      '<script setup lang="ts">\nconst label = "x";\nfunction format(n: number): string { return String(n); }\n</script>\n' +
        '<template><Card :rows="[]"><template #row="{ item }">{{ item.label }}</template></Card>' +
        '<p js-for="(n, i) in 3" :key="n">{{ format(n + i) }}{{ label }}</p></template>',
    );
    assert.deepEqual(prelude(lowering), []);
  });

  it('leaves <script> bindings and imports bound', () => {
    const lowering = lower(
      '<script lang="ts">\nimport { posts as all } from \'../shared/posts.js\';\nconst limit = 2;\n</script>\n' +
        '<template><p>{{ all.length }} {{ limit }}</p></template>',
    );
    assert.deepEqual(prelude(lowering), []);
    assert.deepEqual(lowering.imports, []);
  });

  it('binds context in a page-tree file and reads it as a prop in a view', () => {
    assert.deepEqual(
      prelude(lower('<template><p>{{ context.url.pathname }}</p></template>', 'pages/a.jsails')),
      ['context = __context'],
    );
    assert.deepEqual(prelude(lower('<template><p>{{ context }}</p></template>')), [
      'context = __props.context',
    ]);
  });

  it('imports a catalog name before treating it as a prop', () => {
    const lowering = lower(
      '<template><p>{{ formatDate(date) }}</p></template>',
      'ui/deep/a.jsails',
    );
    assert.deepEqual(prelude(lowering), ['date = __props.date']);
    assert.deepEqual(lowering.imports, [
      { name: 'formatDate', specifier: '../../shared/format-date.js', export: 'formatDate' },
    ]);
    assert.match(
      lowering.tsx,
      /^import \{ formatDate \} from "\.\.\/\.\.\/shared\/format-date\.js";$/m,
    );
  });

  it('leaves built-ins free, and never treats lib.dom names as built-ins', () => {
    const lowering = lower(
      '<template><p>{{ Math.max(1, Number(n)) }} {{ JSON.stringify(undefined) }} {{ globalThis.location }} {{ document }}</p></template>',
    );
    assert.deepEqual(prelude(lowering), ['n = __props.n', 'document = __props.document']);
  });

  it('leaves the error constructors free, so an error page can test what it caught', () => {
    const lowering = lower(
      '<template><p>{{ failure instanceof Error ? failure.message : String(failure) }} {{ failure instanceof TypeError }}</p></template>',
    );
    assert.deepEqual(prelude(lowering), ['failure = __props.failure']);
  });

  it('resolves a name free in <script> through the catalog only', () => {
    const lowering = lower(
      '<script lang="ts">\nconst first = posts[0];\nconst other = missing;\n</script>\n<template><p>{{ first }}{{ posts.length }}{{ missing }}</p></template>',
    );
    assert.deepEqual(prelude(lowering), []);
    assert.deepEqual(
      lowering.imports.map((entry) => entry.name),
      ['posts'],
    );
  });

  it('imports a component tag and an attribute name resolves nothing', () => {
    const lowering = lower('<template><Shell title="t">x</Shell></template>');
    assert.deepEqual(
      lowering.imports.map((entry) => [entry.name, entry.specifier, entry.export]),
      [['Shell', './shell.jsails', 'default']],
    );
    assert.deepEqual(prelude(lowering), []);
  });

  it('reports an unknown component tag instead of reading it from props', () => {
    const lowering = lowerSfc('<template><Shell /><Nope /></template>', 'ui/a.jsails', {
      resolver: EMPTY_RESOLVER,
    });
    assert.deepEqual(
      lowering.diagnostics.map((entry) => entry.code),
      ['sfc.unresolved_component', 'sfc.unresolved_component'],
    );
  });

  it('leaves no free identifier outside the built-in list over the corpus', () => {
    for (const file of SFC_CORPUS) {
      const lowering = lowerSfc(file.source, file.path, { resolver: CORPUS_RESOLVER });
      assert.ok(lowering.shadow !== null, file.path);
      const { program, errors } = parseSync(`${file.path}.tsx`, lowering.tsx, {
        lang: 'tsx',
        sourceType: 'module',
      });
      assert.deepEqual(errors, [], file.path);
      const free = new Set(collectFreeReferences(program).map((reference) => reference.name));
      for (const name of free) {
        assert.ok(BUILTIN_NAMES.has(name), `${file.path}: ${name} is free in the shadow`);
      }
    }
  });
});

describe('name resolver', () => {
  it('looks names up in a table and resolves nothing else', () => {
    const table = nameTable({ Card: { source: { path: 'ui/card.jsails' }, export: 'default' } });
    assert.deepEqual(table.resolve('Card'), {
      source: { path: 'ui/card.jsails' },
      export: 'default',
    });
    assert.equal(table.resolve('toString'), undefined);
    assert.equal(table.resolve('Other'), undefined);
    assert.equal(EMPTY_RESOLVER.resolve('Card'), undefined);
  });

  it('writes import specifiers relative to the importer', () => {
    assert.equal(importSpecifier('pages/a.jsails', { package: 'date-fns' }), 'date-fns');
    assert.equal(importSpecifier('pages/a.jsails', { path: 'pages/b.ts' }), './b.js');
    assert.equal(
      importSpecifier('pages/blog/a.jsails', { path: 'ui/card.jsails' }),
      '../../ui/card.jsails',
    );
    assert.equal(importSpecifier('a.jsails', { path: 'lib/x.tsx' }), './lib/x.js');
    assert.equal(importSpecifier('ui/a.jsails', { path: 'ui/m.mts' }), './m.mjs');
    assert.equal(importSpecifier('ui/a.jsails', { path: 'ui/c.cts' }), './c.cjs');
    assert.equal(importSpecifier('ui/a/b.jsails', { path: 'ui/c.ts' }), '../c.js');
  });

  it('lists JavaScript built-ins and the globalThis escape hatch, not lib.dom', () => {
    for (const name of ['Math', 'JSON', 'Intl', 'Error', 'RegExp', 'undefined', 'globalThis']) {
      assert.ok(BUILTIN_NAMES.has(name), name);
    }
    for (const name of ['window', 'document', 'fetch', 'console', 'localStorage']) {
      assert.ok(!BUILTIN_NAMES.has(name), name);
    }
  });
});
