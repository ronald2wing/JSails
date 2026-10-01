/**
 * Tests for the transitional emitSfc: a defineLive component assembled into a defineComponent module from the one front end, its CSS band and line-exact source map, and the defects of the old format fixed (same-line blocks, nested templates, multi-line literals, removed syntax rejected).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { emitSfc } from '../../src/compiler/sfc-emit.js';

const OPTIONS = { name: 'widget', fromDir: '.', rootDir: '.' } as const;

const LIVE = [
  "import { z } from 'zod';",
  'defineLive({',
  '  stateSchema: z.object({ title: z.string() }),',
  "  initialState: () => ({ title: '' }),",
  '  authorize: () => true,',
  '});',
].join('\n');

/** Assert the emitted module parses as valid TSX. */
function assertValidTsx(code: string): void {
  const result = parseSync('widget.tsx', code, { sourceType: 'module' });
  const errors = result.errors.filter((error) => error.severity === 'Error');
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    `emitted module did not parse:\n${code}`,
  );
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function readVlq(segment: string, index: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let cursor = index;
  for (;;) {
    const digit = BASE64.indexOf(segment[cursor] ?? '');
    assert.ok(digit >= 0, `invalid VLQ digit at ${cursor}`);
    cursor += 1;
    result += (digit & 31) << shift;
    if ((digit & 32) === 0) {
      break;
    }
    shift += 5;
  }
  const magnitude = result >> 1;
  return { value: (result & 1) === 1 ? -magnitude : magnitude, next: cursor };
}

/** Decode a `mappings` string into `generatedLine → sourceLine` (0-based). */
function decodeLines(mappings: string): Map<number, number> {
  const result = new Map<number, number>();
  let sourceLine = 0;
  mappings.split(';').forEach((line, generated) => {
    for (const segment of line.split(',')) {
      if (segment === '') {
        continue;
      }
      let cursor = readVlq(segment, 0).next;
      if (cursor >= segment.length) {
        continue;
      }
      cursor = readVlq(segment, cursor).next;
      sourceLine += readVlq(segment, cursor).value;
      result.set(generated, sourceLine);
    }
  });
  return result;
}

function sfc(parts: { script?: string; setup?: string; template: string; extra?: string }): string {
  return [
    `<script lang="ts">\n${parts.script ?? LIVE}\n</script>`,
    parts.setup === undefined ? '' : `<script setup lang="ts">\n${parts.setup}\n</script>`,
    `<template>\n${parts.template}\n</template>`,
    parts.extra ?? '',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

describe('emitSfc', () => {
  it('assembles a defineComponent module from defineLive and the template', () => {
    const out = emitSfc(sfc({ template: '<p>{{ state.title }}</p>' }), 'widget.jsails', OPTIONS);
    assert.deepEqual(out.diagnostics, []);
    assert.match(out.code, /^import \{ defineComponent \} from 'jsails\/server-components';/);
    assert.match(out.code, /export const widget = defineComponent\(\{\n {2}name: 'widget',\n/);
    assert.match(out.code, /stateSchema: z\.object/);
    assert.match(out.code, /render\(state, tools\) \{/);
    assert.match(out.code, /\n<p>\{state\.title\}<\/p>\n/);
    assert.doesNotMatch(out.code, /defineLive/);
    assertValidTsx(out.code);
  });

  it('runs <script setup> inside render and lowers <template static> to staticFallback', () => {
    const out = emitSfc(
      sfc({
        setup: 'const upper = state.title.toUpperCase();',
        template: '<p>{{ upper }}</p>',
        extra: '<template static><p>Served only.</p></template>',
      }),
      'widget.jsails',
      OPTIONS,
    );
    assert.deepEqual(out.diagnostics, []);
    assert.match(
      out.code,
      /render\(state, tools\) \{\n+const upper = state\.title\.toUpperCase\(\);/,
    );
    assert.match(
      out.code,
      /staticFallback\(\) \{\n {4}return \(<>\n<p>\{"Served only\."\}<\/p>\n<\/>\);/,
    );
    assertValidTsx(out.code);
  });

  it('returns the <style> bodies in the css band and refuses scoped styles for now', () => {
    const styled = emitSfc(
      sfc({
        template: '<p>x</p>',
        extra: '<style>.a { color: red; }</style>\n<style>.b {}</style>',
      }),
      'widget.jsails',
      OPTIONS,
    );
    assert.equal(styled.css, '.a { color: red; }\n.b {}');
    const scoped = emitSfc(
      sfc({ template: '<p>x</p>', extra: '<style scoped>.a {}</style>' }),
      'widget.jsails',
      OPTIONS,
    );
    assert.deepEqual(
      scoped.diagnostics.map((entry) => entry.code),
      ['sfc.not_lowered'],
    );
    assert.equal(scoped.code, '');
  });

  it('keeps same-line block content and a nested template', () => {
    const source = `<script lang="ts">${LIVE.replace(/\n/g, ' ')}</script><template><template js-if="state.title"><b>{{ state.title }}</b></template></template>`;
    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.deepEqual(out.diagnostics, []);
    assert.match(out.code, /\{\(state\.title\) \? \(<><b>\{state\.title\}<\/b><\/>\) : null\}/);
    assertValidTsx(out.code);
  });

  it('keeps a multi-line template literal byte for byte', () => {
    const literal = '`first\n  second\n    third`';
    const out = emitSfc(sfc({ template: `<pre>{{ ${literal} }}</pre>` }), 'widget.jsails', OPTIONS);
    assert.deepEqual(out.diagnostics, []);
    assert.ok(out.code.includes(literal));
  });

  it('rejects removed syntax with positioned diagnostics and emits nothing', () => {
    const source = sfc({ template: '<p js-visible="open" js-bind:title="t">{x}</p>' });
    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.equal(out.code, '');
    const codes = out.diagnostics.map((entry) => `${entry.severity}:${entry.code}`);
    assert.deepEqual(codes, [
      'error:sfc.legacy_syntax',
      'error:sfc.legacy_syntax',
      'warning:sfc.legacy_syntax',
    ]);
    const first = out.diagnostics[0];
    assert.ok(first !== undefined);
    assert.equal(source.slice(first.start, first.end), 'js-visible');
  });

  it('rejects the old config exports and a missing defineLive', () => {
    const legacy = emitSfc(
      sfc({ script: 'export const authorize = () => true;', template: '<p>x</p>' }),
      'widget.jsails',
      OPTIONS,
    );
    assert.deepEqual(
      legacy.diagnostics.map((entry) => entry.code),
      ['sfc.legacy_config_export'],
    );
    const missing = emitSfc(
      sfc({ script: 'const a = 1;', template: '<p>x</p>' }),
      'widget.jsails',
      OPTIONS,
    );
    assert.deepEqual(
      missing.diagnostics.map((entry) => entry.code),
      ['sfc.not_lowered'],
    );
    assert.equal(missing.code, '');
  });

  it('rejects a file name that cannot form a binding, and escapes the runtime name', () => {
    for (const name of ['1widget', 'class']) {
      const out = emitSfc(sfc({ template: '<p>x</p>' }), `${name}.jsails`, { ...OPTIONS, name });
      assert.deepEqual(
        out.diagnostics.map((entry) => entry.code),
        ['sfc.invalid_component_name'],
      );
    }
    const quoted = emitSfc(sfc({ template: '<p>x</p>' }), 'its.jsails', {
      ...OPTIONS,
      name: "it's",
    });
    assert.match(quoted.code, /name: 'it\\'s',/);
    assertValidTsx(quoted.code);
  });

  it('does not import a template tag the script already binds', () => {
    const out = emitSfc(
      sfc({ script: `import { Badge } from './badge.js';\n${LIVE}`, template: '<Badge />' }),
      'widget.jsails',
      OPTIONS,
    );
    assert.deepEqual(out.diagnostics, []);
    assert.equal(out.code.match(/import \{ Badge \}/g)?.length, 1);
  });

  it('reports a template tag with no module', () => {
    const source = sfc({ template: '<Missing />' });
    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    const [diagnostic] = out.diagnostics;
    assert.equal(diagnostic?.code, 'sfc.unresolved_component');
    assert.equal(source.slice(diagnostic.start, diagnostic.end), 'Missing');
  });

  it('maps every copied line to its source line', () => {
    const source = sfc({ template: '<ul>\n  <li>{{ state.title }}</li>\n</ul>' });
    const out = emitSfc(source, 'widget.jsails', OPTIONS);
    assert.ok(out.map !== null);
    const lines = decodeLines(out.map.mappings);
    const generated = out.code.split('\n');
    const sourceLines = source.split('\n');
    const at = generated.findIndex((line) => line.includes('{state.title}'));
    assert.ok(at >= 0);
    assert.match(sourceLines[lines.get(at) ?? -1] ?? '', /\{\{ state\.title \}\}/);
    const schema = generated.findIndex((line) => line.includes('stateSchema'));
    assert.match(sourceLines[lines.get(schema) ?? -1] ?? '', /stateSchema/);
  });
});
