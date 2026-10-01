/**
 * Tests for `compileSfc` (docs/design/sfc.md §8, §10): the shadow it compiles
 * is the shadow TypeScript checks, JSX goes to the automatic `jsails`
 * runtime, the map is composed from oxc's map and the span table with
 * sources relative to the output, no declaration is requested (an untyped
 * author export still compiles), `.jsails` specifiers are rewritten for Node
 * only when asked and as Atoms, a transform error is read by its offset into
 * a value-free positioned diagnostic, and a failed lowering is passed
 * through.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeMappings } from '../../../src/compiler/sfc/vlq.js';
import { lookupMapping } from '../../../src/compiler/sfc/column-map.js';
import { compileSfc, sfcOutputPath } from '../../../src/compiler/sfc/compile.js';
import { lineIndex } from '../../../src/compiler/sfc/line-index.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { nameTable } from '../../../src/compiler/sfc/name-resolver.js';
import { editShadow } from '../../../src/compiler/sfc/segments.js';
import { CORPUS_RESOLVER, SFC_CORPUS } from './corpus.js';

function lower(source: string, file = 'ui/probe.jsails'): SfcLowering {
  const lowering = lowerSfc(source, file, {
    resolver: nameTable({
      Card: { source: { path: 'ui/card.jsails' }, export: 'default' },
      Badge: { source: { path: 'ui/badge.jsails' }, export: 'default' },
    }),
  });
  assert.deepEqual(lowering.diagnostics, []);
  return lowering;
}

/** The `.jsails` line and column (1-based) that generated `needle` maps to. */
function mappedPosition(
  js: string,
  mappings: string,
  needle: string,
  source: string,
): { line: number; column: number } {
  const at = js.indexOf(needle);
  assert.ok(at >= 0, needle);
  const position = lineIndex(js).positionAt(at);
  const point = lookupMapping(decodeMappings(mappings), position);
  assert.ok(point !== undefined && point.length !== 1);
  const [, , line, column] = point;
  assert.ok(lineIndex(source).offsetAt({ line, column }) !== undefined);
  return { line: line + 1, column: column + 1 };
}

describe('compileSfc', () => {
  it('compiles every corpus file to JavaScript on the automatic jsails runtime', () => {
    for (const file of SFC_CORPUS) {
      const lowering = lowerSfc(file.source, file.path, { resolver: CORPUS_RESOLVER });
      const compiled = compileSfc(lowering);
      assert.ok(compiled.js !== null, file.path);
      assert.deepEqual(compiled.diagnostics, []);
      assert.equal(compiled.outputFile, sfcOutputPath(file.path));
      assert.match(compiled.js, /from "jsails\/jsx-runtime"/);
      assert.doesNotMatch(compiled.js, /__props: |: __ComponentChild/, 'types are stripped');
    }
  });

  it('names the output after the source, with .js', () => {
    assert.equal(sfcOutputPath('pages/blog/[slug].jsails'), 'pages/blog/[slug].js');
    assert.equal(sfcOutputPath('ui/card.jsails'), 'ui/card.js');
  });

  it('maps template expressions and script lines to their .jsails positions', () => {
    const source =
      '<script lang="ts">\n/** A probe. */\nexport function shout(text: string): string {\n  return text.toUpperCase();\n}\n</script>\n' +
      '<script setup lang="ts">\ndefineProps<{ name: string; items: string[] }>();\n</script>\n' +
      '<template>\n  <ul>\n    <li js-for="item in items" :key="item">{{ shout(item) + name }}</li>\n  </ul>\n</template>\n';
    const compiled = compileSfc(lower(source));
    assert.ok(compiled.js !== null);
    assert.equal(compiled.map.file, 'probe.js');
    assert.deepEqual(compiled.map.sources, ['probe.jsails']);
    assert.deepEqual(compiled.map.sourcesContent, [source]);
    assert.deepEqual(mappedPosition(compiled.js, compiled.map.mappings, 'toUpperCase', source), {
      line: 4,
      column: 15,
    });
    assert.deepEqual(mappedPosition(compiled.js, compiled.map.mappings, 'shout(item)', source), {
      line: 12,
      column: 47,
    });
  });

  it('writes sources relative to the output directory, URL-escaped', () => {
    const compiled = compileSfc(
      lower('<template><p>x</p></template>\n', 'pages/a #b/[slug] 100%.jsails'),
    );
    assert.ok(compiled.js !== null);
    assert.deepEqual(compiled.map.sources, ['[slug]%20100%25.jsails']);
    assert.equal(compiled.map.file, '[slug] 100%.js');
  });

  it('never requests declarations: an untyped author export compiles', () => {
    const compiled = compileSfc(
      lower(
        '<script lang="ts">\n/** Untyped helper. */\nexport function twice(n: number) {\n  return n * 2;\n}\n</script>\n<template><p>{{ twice(2) }}</p></template>\n',
      ),
    );
    assert.ok(compiled.js !== null);
    assert.match(compiled.js, /export function twice\(n\)/);
  });

  it('compiles the checked shadow unchanged unless asked to rewrite specifiers', () => {
    const source =
      '<script lang="ts">\n/** Imports. */\nimport type { Row } from "./card.jsails";\nexport { default as Again } from \'./badge.jsails\';\nexport const lazy = (): Promise<unknown> => import("../ui/card.jsails");\nexport const rows: Row[] = [];\n</script>\n' +
      '<template><Badge /></template>\n';
    const lowering = lower(source);
    const bundled = compileSfc(lowering);
    assert.ok(bundled.js !== null);
    assert.match(bundled.js, /from "\.\/badge\.jsails"/);
    assert.match(bundled.js, /import\("\.\.\/ui\/card\.jsails"\)/);

    const node = compileSfc(lowering, { specifiers: 'node' });
    assert.ok(node.js !== null);
    assert.doesNotMatch(node.js, /\.jsails/);
    assert.match(node.js, /from "\.\/badge\.js"/);
    assert.match(node.js, /import\("\.\.\/ui\/card\.js"\)/);
    // The generated import of the catalog name is rewritten like an author's.
    assert.match(lowering.tsx, /import Badge from "\.\/badge\.jsails";/);
  });

  it('maps a rewritten specifier to the original literal', () => {
    const source =
      '<script lang="ts">\n/** Import. */\nimport Card from \'./card.jsails\';\n</script>\n<template><Card :rows="[]" /></template>\n';
    const compiled = compileSfc(lower(source), { specifiers: 'node' });
    assert.ok(compiled.js !== null);
    assert.deepEqual(mappedPosition(compiled.js, compiled.map.mappings, '"./card.js"', source), {
      line: 3,
      column: 18,
    });
  });

  it('reports a transform refusal in author code at its position, value-free', () => {
    const source =
      '<script lang="ts">\n/** A redeclaration the parser accepts and the transformer refuses. */\nlet secret = 1;\nlet secret = 2;\n</script>\n<template><p>{{ secret }}</p></template>\n';
    const lowering = lowerSfc(source, 'ui/probe.jsails');
    assert.deepEqual(lowering.diagnostics, []);
    const compiled = compileSfc(lowering);
    assert.equal(compiled.js, null);
    assert.equal(compiled.map, null);
    const [diagnostic, ...rest] = compiled.diagnostics;
    assert.deepEqual(rest, []);
    assert.equal(diagnostic?.code, 'sfc.compile_error');
    assert.equal(diagnostic.file, 'ui/probe.jsails');
    assert.equal(source.slice(diagnostic.start, diagnostic.start + 'secret'.length), 'secret');
    assert.doesNotMatch(diagnostic.message, /secret|\u001b/);
  });

  it('reports a transform refusal in a folder x.ts in that file', () => {
    const script =
      '/** A redeclaration the parser accepts and the transformer refuses. */\nlet secret = 1;\nlet secret = 2;\n';
    const lowering = lowerSfc(
      { template: '<template><p>{{ secret }}</p></template>\n', script },
      'ui/probe.jsails',
    );
    assert.deepEqual(lowering.diagnostics, []);
    const compiled = compileSfc(lowering);
    assert.equal(compiled.js, null);
    const [diagnostic, ...rest] = compiled.diagnostics;
    assert.deepEqual(rest, []);
    assert.equal(diagnostic?.code, 'sfc.compile_error');
    assert.equal(diagnostic.file, 'ui/probe/probe.ts');
    assert.equal(script.slice(diagnostic.start, diagnostic.start + 'secret'.length), 'secret');
  });

  it('reports a refusal inside generated code as internal', () => {
    const lowering = lower('<template><p>x</p></template>\n');
    const shadow = lowering.shadow;
    assert.ok(shadow !== null);
    const at = shadow.text.indexOf('return (');
    const broken = editShadow(shadow, [
      { start: at, end: at + 'return ('.length, text: 'return ((' },
    ]);
    const compiled = compileSfc({ ...lowering, shadow: broken, tsx: broken.text });
    assert.equal(compiled.js, null);
    assert.deepEqual(
      compiled.diagnostics.map((entry) => entry.code),
      ['sfc.internal'],
    );
  });

  it('passes a failed lowering through without compiling', () => {
    const lowering = lowerSfc('<template><p>{{ }}</p></template>\n', 'ui/probe.jsails');
    assert.equal(lowering.shadow, null);
    const compiled = compileSfc(lowering);
    assert.equal(compiled.js, null);
    assert.equal(compiled.map, null);
    assert.deepEqual(compiled.diagnostics, lowering.diagnostics);
  });
});
