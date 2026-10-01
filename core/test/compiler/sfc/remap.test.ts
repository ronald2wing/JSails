/**
 * Tests for the `tsc` remapper on hand-written `tsc --pretty false` output:
 * parsing (located, global and continuation lines, CRLF, unparsed lines),
 * each origin (an ordinary file, a Verbatim or Alias position, an Atom's
 * owning node, the header, a bridge, a script companion, a shadow this run
 * did not lower), a component folder's `x.ts` (what `tsc` says of it on its
 * own left out, what the shadow maps there reported once), and the same
 * results when `tsc` ran on Windows (`path.win32` injected).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { splitSfc } from '../../../src/compiler/sfc/layout.js';
import { lineIndex } from '../../../src/compiler/sfc/line-index.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { parseTscOutput, remapTscOutput } from '../../../src/compiler/sfc/remap.js';

const SOURCE =
  '<script lang="ts">\n/** A probe page. */\nexport function load(): { title: string; tags: string[] } {\n  return { title: "t", tags: [] };\n}\n</script>\n' +
  '<template>\n  <ul>\n    <li js-for="tag in tags" :key="tag">{{ titel }} {{ tag }}</li>\n  </ul>\n</template>\n';

const lowering: SfcLowering = lowerSfc(SOURCE, 'pages/post.jsails');

/** The shadow's 1-based line and column of the `nth` occurrence of `needle`. */
function shadowAt(needle: string, nth = 0): string {
  const text = lowering.tsx;
  let at = -1;
  for (let count = 0; count <= nth; count += 1) at = text.indexOf(needle, at + 1);
  assert.ok(at >= 0, needle);
  const position = lineIndex(text).positionAt(at);
  return `${position.line + 1},${position.column + 1}`;
}

/** The source's 1-based position of `needle`. */
function sourceAt(needle: string): { line: number; column: number } {
  const position = lineIndex(SOURCE).positionAt(SOURCE.indexOf(needle));
  return { line: position.line + 1, column: position.column + 1 };
}

describe('parseTscOutput', () => {
  it('reads located, global and continuation lines, LF or CRLF', () => {
    const output = [
      "pages/index.ts(5,27): error TS2322: Type 'number' is not assignable to type 'string'.",
      "  The expected type comes from property 'title'.",
      'error TS5083: Cannot read file.',
      'Found 2 errors.',
      '',
    ].join('\r\n');
    const parsed = parseTscOutput(output);
    assert.deepEqual(parsed.diagnostics, [
      {
        file: 'pages/index.ts',
        position: { line: 5, column: 27 },
        category: 'error',
        code: 2322,
        message:
          "Type 'number' is not assignable to type 'string'.\nThe expected type comes from property 'title'.",
      },
      { file: null, position: null, category: 'error', code: 5083, message: 'Cannot read file.' },
    ]);
    assert.deepEqual(parsed.unparsed, ['Found 2 errors.']);
  });

  it('keeps a path with parentheses and spaces', () => {
    const [diagnostic] = parseTscOutput(
      'pages/a (copy)/x y.ts(1,2): warning TS6133: unused.\n',
    ).diagnostics;
    assert.equal(diagnostic?.file, 'pages/a (copy)/x y.ts');
    assert.deepEqual(diagnostic.position, { line: 1, column: 2 });
    assert.equal(diagnostic.category, 'warning');
  });
});

describe('remapTscOutput', () => {
  const root = path.resolve('/app');
  const remap = (output: string) =>
    remapTscOutput(output, { root, cwd: root, sources: [lowering] });

  it('maps an implicit prop (Alias) and a template expression (Verbatim) exactly', () => {
    assert.deepEqual(lowering.diagnostics, []);
    const [alias, verbatim] = remap(
      `.jsails/sfc/pages/post.jsails.tsx(${shadowAt('titel', 1)}): error TS2339: Property 'titel' does not exist.\n` +
        `.jsails/sfc/pages/post.jsails.tsx(${shadowAt('titel', 2)}): error TS2304: x.\n`,
    );
    assert.deepEqual(alias, {
      origin: 'source',
      file: 'pages/post.jsails',
      position: sourceAt('titel'),
      category: 'error',
      code: 2339,
      message: "Property 'titel' does not exist.",
    });
    assert.equal(verbatim?.origin, 'source');
    assert.deepEqual(verbatim.position, sourceAt('titel'));
  });

  it('maps generated code to the template node that owns it', () => {
    const [generated] = remap(
      `.jsails/sfc/pages/post.jsails.tsx(${shadowAt('__renderList(')}): error TS2345: cascade.\n`,
    );
    assert.equal(generated?.origin, 'generated');
    assert.equal(generated.file, 'pages/post.jsails');
    assert.deepEqual(generated.position, sourceAt('<li js-for'));
    assert.equal(generated.generatedFor, '<li>');
  });

  it('reports the header, a bridge and an unknown shadow as internal', () => {
    const diagnostics = remap(
      [
        '.jsails/sfc/pages/post.jsails.tsx(1,10): error TS2305: header.',
        '.jsails/sfc/pages/post.d.jsails.ts(1,15): error TS2307: bridge.',
        '.jsails/sfc/ui/gone.jsails.tsx(3,1): error TS2304: stale.',
        '.jsails/sfc/pages/post.jsails.script.ts(3,20): error TS2307: companion.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      diagnostics.map((entry) => [entry.origin, entry.file, entry.position]),
      [
        ['internal', 'pages/post.jsails', null],
        ['internal', 'pages/post.jsails', null],
        ['internal', 'ui/gone.jsails', null],
        ['internal', 'pages/post.jsails', null],
      ],
    );
  });

  it('leaves out what tsc says of a folder x.ts on its own, and reports what the shadow maps there once', () => {
    const split = splitSfc(SOURCE, 'pages/post.jsails');
    assert.ok(split.ok);
    const folder = lowerSfc(split.folder, 'pages/post.jsails');
    const script = split.folder.script ?? '';
    const at = lineIndex(script).positionAt(script.indexOf('title: "t"'));
    const shadowOffset = folder.tsx.indexOf('title: "t"');
    const shadow = lineIndex(folder.tsx).positionAt(shadowOffset);
    const diagnostics = remapTscOutput(
      [
        `pages/post/post.ts(${at.line + 1},${at.column + 1}): error TS2322: same.`,
        `.jsails/sfc/pages/post.jsails.tsx(${shadow.line + 1},${shadow.column + 1}): error TS2322: same.`,
        `pages/post/post.ts(1,1): error TS6133: 'x' is declared but its value is never read.`,
        'shared/x.ts(1,1): error TS2322: elsewhere.',
        '',
      ].join('\n'),
      { root, cwd: root, sources: [folder] },
    );
    assert.deepEqual(
      diagnostics.map((entry) => [entry.origin, entry.file, entry.position, entry.message]),
      [
        ['source', 'pages/post/post.ts', { line: at.line + 1, column: at.column + 1 }, 'same.'],
        ['file', 'shared/x.ts', { line: 1, column: 1 }, 'elsewhere.'],
      ],
    );
  });

  it('passes ordinary files, files outside the project and global diagnostics through', () => {
    const diagnostics = remapTscOutput(
      'shared/x.ts(2,3): error TS2322: a.\n../lib/y.d.ts(1,1): error TS1005: b.\nerror TS5023: c.\n',
      { root, cwd: path.join(root, 'shared', '..'), sources: [lowering] },
    );
    assert.deepEqual(
      diagnostics.map((entry) => [entry.origin, entry.file, entry.position]),
      [
        ['file', 'shared/x.ts', { line: 2, column: 3 }],
        ['file', '../lib/y.d.ts', { line: 1, column: 1 }],
        ['file', null, null],
      ],
    );
  });

  it('gives the same result for output from a Windows tsc', () => {
    const output =
      `.jsails/sfc/pages/post.jsails.tsx(${shadowAt('titel', 1)}): error TS2339: p.\n` +
      `C:/app/.jsails/sfc/pages/post.jsails.tsx(${shadowAt('__renderList(')}): error TS2345: q.\n` +
      'shared/x.ts(2,3): error TS2322: r.\n' +
      'D:/elsewhere/y.d.ts(1,1): error TS1005: s.\n';
    const windows = remapTscOutput(output, {
      root: 'C:\\app',
      cwd: 'C:\\app',
      sources: [lowering],
      pathApi: path.win32,
    });
    const posix = remapTscOutput(
      output.replace('C:/app/', '/app/').replace('D:/elsewhere/', '/elsewhere/'),
      {
        root: '/app',
        cwd: '/app',
        sources: [lowering],
        pathApi: path.posix,
      },
    );
    assert.deepEqual(windows.slice(0, 3), posix.slice(0, 3));
    assert.equal(windows[3]?.origin, 'file');
    assert.equal(windows[3].file, 'D:/elsewhere/y.d.ts');
  });
});
