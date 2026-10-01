/**
 * Tests for the .jsails block scanner: tag-aware block boundaries (raw-text script and style, nested templates counted by the template parser), same-line blocks, comments and the header, block attributes with lang="ts" required, removed blocks and config exports, and blocks read from files of their own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkScriptBlock,
  fileBlock,
  parseSfcBlocks,
  type SfcFile,
} from '../../../src/compiler/sfc/blocks.js';
import {
  SfcDiagnostics,
  applySfcFix,
  type SfcDiagnosticCode,
} from '../../../src/compiler/sfc/diagnostics.js';

const FILE = 'components/task-list.jsails';

function scan(source: string): SfcFile {
  return parseSfcBlocks(source, FILE);
}

function codes(file: SfcFile): readonly SfcDiagnosticCode[] {
  return file.diagnostics.map((entry) => entry.code);
}

/** The source after applying the fix of the only diagnostic, which has `code`. */
function fixed(source: string, code: SfcDiagnosticCode): string {
  const file = scan(source);
  assert.deepEqual(codes(file), [code]);
  const fix = file.diagnostics[0]?.fix;
  assert.ok(fix !== undefined);
  return applySfcFix(source, fix);
}

describe('parseSfcBlocks', () => {
  it('finds every block in any order with exact content and offsets', () => {
    const source = [
      '<!-- Task list. -->',
      '<template>',
      '  <p>{{ title }}</p>',
      '</template>',
      '<script setup lang="ts">const title = "x";</script>',
      '<style scoped>.a {}</style>',
      '<script lang="ts">',
      "import { z } from 'zod';",
      '</script>',
      '<template static><p>Static.</p></template>',
      '<style lang="css">.b {}</style>',
    ].join('\n');
    const file = scan(source);
    assert.deepEqual(file.diagnostics, []);
    assert.equal(file.file, FILE);
    assert.equal(file.header?.text, ' Task list. ');
    assert.equal(file.script?.content, "\nimport { z } from 'zod';\n");
    assert.equal(file.scriptSetup?.content, 'const title = "x";');
    assert.equal(file.template?.content, '\n  <p>{{ title }}</p>\n');
    assert.equal(file.templateStatic?.type, 'template-static');
    assert.deepEqual(
      file.styles.map((style) => [style.content, style.scoped]),
      [
        ['.a {}', true],
        ['.b {}', false],
      ],
    );
    for (const block of [
      file.script,
      file.scriptSetup,
      file.template,
      file.templateStatic,
      ...file.styles,
    ]) {
      assert.ok(block !== null);
      assert.equal(block.file, FILE);
      assert.equal(source.slice(block.contentStart, block.contentEnd), block.content);
      assert.equal(source[block.start], '<');
      assert.equal(source[block.end - 1], '>');
    }
  });

  it('accepts one-line files and same-line content', () => {
    const file = scan('<script lang="ts">const a = 1;</script><template><p>{{ a }}</p></template>');
    assert.deepEqual(file.diagnostics, []);
    assert.equal(file.script?.content, 'const a = 1;');
    assert.equal(file.template?.content, '<p>{{ a }}</p>');
  });

  it('ends a script at its first </script>, never at a template inside it', () => {
    const file = scan(
      '<script lang="ts">const t = "<template><p>no</p></template>";</script>\n<template><p>yes</p></template>',
    );
    assert.deepEqual(file.diagnostics, []);
    assert.equal(file.script?.content, 'const t = "<template><p>no</p></template>";');
    assert.equal(file.template?.content, '<p>yes</p>');
  });

  it('counts nested templates and ignores an end tag inside an interpolation', () => {
    const file = scan(
      '<template><template js-if="a"><b>{{ \'</template>\' }}</b></template><i>after</i></template>',
    );
    assert.deepEqual(file.diagnostics, []);
    assert.equal(
      file.template?.content,
      '<template js-if="a"><b>{{ \'</template>\' }}</b></template><i>after</i>',
    );
  });

  it('reads CRLF files and a byte order mark', () => {
    const file = scan('﻿<template>\r\n  <p>a</p>\r\n</template>\r\n');
    assert.deepEqual(file.diagnostics, []);
    assert.equal(file.template?.content, '\r\n  <p>a</p>\r\n');
  });

  it('reports text outside blocks with its range', () => {
    const source = '<template><p>a</p></template>\nstray words\n';
    const file = scan(source);
    assert.deepEqual(codes(file), ['sfc.text_outside_block']);
    const [diagnostic] = file.diagnostics;
    assert.ok(diagnostic !== undefined);
    assert.equal(source.slice(diagnostic.start, diagnostic.end), 'stray words');
    assert.doesNotMatch(diagnostic.message, /stray/);
  });

  it('reports a missing template, unknown and removed blocks', () => {
    assert.deepEqual(codes(scan('<script lang="ts">const a = 1;</script>')), [
      'sfc.missing_template',
    ]);
    assert.deepEqual(codes(scan('<docs>x</docs><template><p>a</p></template>')), [
      'sfc.unknown_block',
    ]);
    const server = scan(
      '<server>export async function save() {}</server>\n<template><p>a</p></template>',
    );
    assert.deepEqual(codes(server), ['sfc.server_block_removed']);
    assert.match(server.diagnostics[0]?.message ?? '', /\.server\.ts/);
  });

  it('reports an unknown or removed block that is never closed', () => {
    assert.deepEqual(codes(scan('<template><p>a</p></template>\n<server>const a = 1;')), [
      'sfc.server_block_removed',
      'sfc.unclosed_block',
    ]);
  });

  it('reports a duplicate block with the first one as related', () => {
    const source = '<template><p>a</p></template><template><p>b</p></template>';
    const file = scan(source);
    assert.deepEqual(codes(file), ['sfc.duplicate_block']);
    const related = file.diagnostics[0]?.related;
    assert.ok(related !== undefined);
    assert.equal(related.start, 0);
    assert.equal(file.template?.content, '<p>a</p>');
  });

  it('reports an unclosed block, with a fix adding its end tag', () => {
    assert.equal(
      fixed('<template><p>a</p></template><style>.a {}', 'sfc.unclosed_block'),
      '<template><p>a</p></template><style>.a {}</style>\n',
    );
  });

  it('reports a self-closing block', () => {
    assert.deepEqual(codes(scan('<style /><template><p>a</p></template>')), [
      'sfc.self_closing_block',
    ]);
  });

  it('requires lang="ts" on every script, with a fix inserting it', () => {
    assert.equal(
      fixed(
        '<script>const a = 1;</script><template><p>a</p></template>',
        'sfc.script_lang_required',
      ),
      '<script lang="ts">const a = 1;</script><template><p>a</p></template>',
    );
    assert.equal(
      fixed(
        '<script setup >const a = 1;</script><template><p>a</p></template>',
        'sfc.script_lang_required',
      ),
      '<script setup lang="ts">const a = 1;</script><template><p>a</p></template>',
    );
  });

  it('rejects other languages and attributes', () => {
    assert.equal(
      fixed(
        '<script lang="js">const a = 1;</script><template><p>a</p></template>',
        'sfc.unsupported_lang',
      ),
      '<script lang="ts">const a = 1;</script><template><p>a</p></template>',
    );
    assert.deepEqual(codes(scan('<template lang="pug"><p>a</p></template>')), [
      'sfc.unsupported_lang',
    ]);
    assert.deepEqual(codes(scan('<template><p>a</p></template><style lang="scss">a {}</style>')), [
      'sfc.unsupported_lang',
    ]);
    assert.deepEqual(codes(scan('<template><p>a</p></template><style src="./a.css"></style>')), [
      'sfc.style_src_unsupported',
    ]);
    assert.equal(
      fixed(
        '<script lang="ts" src="./a.ts"></script><template><p>a</p></template>',
        'sfc.block_attribute',
      ),
      '<script lang="ts"></script><template><p>a</p></template>',
    );
    assert.deepEqual(
      codes(scan('<template static="yes"><p>a</p></template><template><p>b</p></template>')),
      ['sfc.block_attribute'],
    );
  });

  it('reports the removed config exports at their names', () => {
    const source =
      '<script lang="ts">\nexport const stateSchema = 1;\nexport function authorize() { return true; }\nexport { actions };\nconst actions = {};\nexport const load = 1;\n</script><template><p>a</p></template>';
    const file = scan(source);
    assert.deepEqual(codes(file), [
      'sfc.legacy_config_export',
      'sfc.legacy_config_export',
      'sfc.legacy_config_export',
    ]);
    assert.deepEqual(
      file.diagnostics.map((entry) => source.slice(entry.start, entry.end)),
      ['stateSchema', 'authorize', 'actions'],
    );
  });

  it('reports a script syntax error at its position without echoing it', () => {
    const source = '<script lang="ts">\nconst secret = ;\n</script><template><p>a</p></template>';
    const file = scan(source);
    assert.deepEqual(codes(file), ['sfc.script_syntax']);
    const [diagnostic] = file.diagnostics;
    assert.ok(diagnostic !== undefined);
    assert.equal(source.slice(diagnostic.start, diagnostic.end), ';');
    assert.doesNotMatch(diagnostic.message, /secret/);
  });

  it('points a syntax error at the end of a script at its end tag', () => {
    const source = '<script lang="ts">const a = </script><template><p>a</p></template>';
    const [diagnostic] = scan(source).diagnostics;
    assert.equal(diagnostic?.code, 'sfc.script_syntax');
    assert.equal(diagnostic.start, source.indexOf('</script>'));
    assert.ok(diagnostic.end > diagnostic.start);
  });

  it('counts positions in UTF-16 units, as JavaScript strings do', () => {
    const source = '<script lang="ts">const é = "😀"; const b = *;</script><template></template>';
    const [diagnostic] = scan(source).diagnostics;
    assert.equal(diagnostic?.code, 'sfc.script_syntax');
    assert.equal(source.slice(diagnostic.start, diagnostic.end), '*');
  });

  it('collects template diagnostics with offsets in the file', () => {
    const source = '<script lang="ts">const a = 1;</script>\n<template><p>{{ a + }}</p></template>';
    const file = scan(source);
    assert.deepEqual(codes(file), ['sfc.invalid_expression']);
    assert.ok((file.diagnostics[0]?.start ?? 0) > source.indexOf('{{'));
  });

  it('returns frozen results', () => {
    const file = scan('<template><p>a</p></template>');
    assert.ok(Object.isFrozen(file));
    assert.ok(Object.isFrozen(file.template));
    assert.ok(Object.isFrozen(file.diagnostics));
  });
});

describe('fileBlock', () => {
  it('makes a whole file a block with offsets into that file', () => {
    const script = fileBlock('script', "import a from './a.js';\n", 'components/x/x.ts');
    assert.deepEqual(
      [script.type, script.file, script.contentStart, script.contentEnd, script.start, script.end],
      ['script', 'components/x/x.ts', 0, 24, 0, 24],
    );
    const scoped = fileBlock('style', '.a {}', 'components/x/x.scoped.css');
    assert.ok(scoped.type === 'style' && 'scoped' in scoped && scoped.scoped);
    const global = fileBlock('style', '.a {}', 'components/x/x.css');
    assert.ok('scoped' in global && !global.scoped);
  });

  it('checks a script read from its own file with positions in that file', () => {
    const source = 'import a from "./a.js";\nexport const actions = {};\nconst b = ;\n';
    const diagnostics = new SfcDiagnostics('components/x/x.ts');
    checkScriptBlock(fileBlock('script', source, 'components/x/x.ts'), diagnostics);
    assert.deepEqual(
      diagnostics.list().map((entry) => [entry.code, entry.file]),
      [['sfc.script_syntax', 'components/x/x.ts']],
    );
    assert.equal(source.slice(diagnostics.list()[0]?.start, diagnostics.list()[0]?.end), ';');
    const legacy = new SfcDiagnostics('components/x/x.ts');
    checkScriptBlock(
      fileBlock('script', 'export const actions = {};\n', 'components/x/x.ts'),
      legacy,
    );
    const [entry] = legacy.list();
    assert.equal(entry?.code, 'sfc.legacy_config_export');
    assert.equal('export const actions = {};\n'.slice(entry.start, entry.end), 'actions');
  });
});
