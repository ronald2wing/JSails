/**
 * The offset space of a component (`source-space.ts`): files laid end to end
 * one code unit apart, an offset resolved to its file, a range that crosses
 * files refused, and diagnostics and segments positioned in the file that
 * holds them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SfcDiagnostics } from '../../../src/compiler/sfc/diagnostics.js';
import { SegmentWriter } from '../../../src/compiler/sfc/segment-writer.js';
import { assembleShadow } from '../../../src/compiler/sfc/segments.js';
import { SegmentMapError } from '../../../src/compiler/sfc/segments-error.js';
import { SourceSpace } from '../../../src/compiler/sfc/source-space.js';

const SPACE = new SourceSpace([
  { file: 'pages/x/x.jsails', text: '<template>a</template>' },
  { file: 'pages/x/x.ts', text: 'const a = 1;' },
  { file: 'pages/x/x.css', text: '' },
]);

describe('SourceSpace', () => {
  it('lays files out one code unit apart, the first at 0', () => {
    assert.deepEqual(
      SPACE.files.map((file) => [file.file, file.base]),
      [
        ['pages/x/x.jsails', 0],
        ['pages/x/x.ts', 23],
        ['pages/x/x.css', 36],
      ],
    );
  });

  it('resolves an offset to its file, the file end included', () => {
    assert.equal(SPACE.fileAt(0).file, 'pages/x/x.jsails');
    assert.equal(SPACE.fileAt(22).file, 'pages/x/x.jsails');
    assert.equal(SPACE.fileAt(23).file, 'pages/x/x.ts');
    assert.equal(SPACE.fileAt(36).file, 'pages/x/x.css');
    assert.equal(SPACE.slice(23, 28), 'const');
    assert.equal(SPACE.offsetIn('pages/x/x.ts', 6), 29);
    assert.equal(SPACE.offsetIn('pages/other.ts', 0), undefined);
    assert.deepEqual(SPACE.locate(30), { file: 'pages/x/x.ts', base: 23 });
    assert.equal(SPACE.baseOf('pages/x/x.css'), 36);
  });

  it('refuses an offset outside every file and a range that crosses files', () => {
    assert.throws(() => SPACE.fileAt(37), SegmentMapError);
    assert.throws(() => SPACE.fileOf(20, 25), SegmentMapError);
    assert.throws(() => new SourceSpace([]), SegmentMapError);
  });

  it('positions diagnostics, their fix and their related range in the file that holds them', () => {
    const diagnostics = new SfcDiagnostics(SPACE);
    diagnostics.error('sfc.script_syntax', 'm', 29, 30, {
      fix: { message: 'f', edits: [{ start: 29, end: 30, text: '' }] },
      related: { message: 'r', start: 1, end: 9 },
    });
    diagnostics.error('sfc.missing_template', 'm', 0, 0);
    const [first, second] = diagnostics.list();
    assert.equal(first?.file, 'pages/x/x.jsails');
    assert.deepEqual(second, {
      severity: 'error',
      code: 'sfc.script_syntax',
      message: 'm',
      file: 'pages/x/x.ts',
      start: 6,
      end: 7,
      fix: { message: 'f', edits: [{ start: 6, end: 7, text: '' }] },
      related: { message: 'r', file: 'pages/x/x.jsails', start: 1, end: 9 },
    });
  });

  it('orders diagnostics of several files by their place in the space', () => {
    const diagnostics = new SfcDiagnostics(SPACE);
    diagnostics.error('sfc.script_syntax', 'm', 24, 25);
    diagnostics.addAll([
      {
        severity: 'error',
        code: 'sfc.missing_template',
        message: 'm',
        file: 'pages/x/x.jsails',
        start: 3,
        end: 3,
      },
    ]);
    assert.deepEqual(
      diagnostics.list().map((entry) => entry.file),
      ['pages/x/x.jsails', 'pages/x/x.ts'],
    );
  });

  it('writes segments that map to the file each range lies in', () => {
    const writer = new SegmentWriter(SPACE);
    writer.verbatim(23, 35);
    writer.atom('\n', 10, 11);
    writer.alias('a', 29, 30);
    const shadow = assembleShadow({ header: '', body: writer.segments(), footer: '' });
    assert.deepEqual(
      shadow.sources.map((source) => source.name),
      ['pages/x/x.ts', 'pages/x/x.jsails'],
    );
    assert.deepEqual(
      shadow.spans.map((span) => [span.source, span.originalStart, span.originalEnd]),
      [
        [0, 0, 12],
        [1, 10, 11],
        [0, 6, 7],
      ],
    );
    assert.throws(() => writer.verbatim(20, 25), SegmentMapError);
  });
});
