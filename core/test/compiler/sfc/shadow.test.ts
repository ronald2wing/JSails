/**
 * Tests for the sidecar library (docs/design/sfc.md §3.2): the three files of
 * a lowered file and their paths, the script companion of a component
 * folder's `x.ts`, the fixed bridge text, a span table that
 * equals the shadow's, writes that happen only on change and leave no
 * temporary file, pruning of sidecars no source accounts for (a deleted file,
 * a file that stopped lowering) without touching anything else, the refusal
 * to write through a symbolic link or into a file, and a case-only rename on a
 * case-insensitive file system (emulated over the real one, so every leg runs
 * it), which leaves every sidecar present and spelled as its source.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, describe, it } from 'node:test';

import { splitSfc } from '../../../src/compiler/sfc/layout.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import {
  bridgePath,
  scriptCompanionPath,
  shadowPath,
  sidecarFiles,
  SfcSidecarErrors,
  sourceOfBridgePath,
  sourceOfScriptCompanionPath,
  sourceOfShadowPath,
  spanTablePath,
  SPAN_TABLE_VERSION,
  writeSidecars,
  type SidecarFs,
} from '../../../src/compiler/sfc/shadow.js';
import { CORPUS_RESOLVER, SFC_CORPUS } from './corpus.js';
import { LIVE_RESOLVER, liveFile } from './live-corpus.js';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-sfc-sidecars-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function project(): string {
  return mkdtempSync(join(scratch, 'app-'));
}

function lowerCorpus(): readonly SfcLowering[] {
  return SFC_CORPUS.map((file) => lowerSfc(file.source, file.path, { resolver: CORPUS_RESOLVER }));
}

function read(root: string, path: string): string {
  return readFileSync(join(root, ...path.split('/')), 'utf8');
}

/** Every file under `dir`, as sorted `/` paths relative to it. */
function tree(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...tree(join(dir, entry.name), `${path}/`));
    else files.push(path);
  }
  return files.sort();
}

/**
 * A case-insensitive, case-preserving file system over the real directory
 * `root`, as APFS and NTFS are: each path segment names the existing entry
 * that equals it ignoring case, in that entry's spelling, and a new entry
 * keeps the spelling it is created with. A rename over an existing file keeps
 * the existing spelling, as a Linux casefold directory does.
 */
function caseInsensitiveFs(root: string): SidecarFs {
  const onDisk = (path: string): string => {
    const segments = relative(root, path)
      .split(sep)
      .filter((segment) => segment !== '');
    let current = root;
    for (const segment of segments) {
      const names = lstatSync(current, { throwIfNoEntry: false })?.isDirectory()
        ? readdirSync(current)
        : [];
      const stored = names.find((name) => name.toLowerCase() === segment.toLowerCase());
      current = join(current, stored ?? segment);
    }
    return current;
  };
  return {
    lstat: (path) => lstatSync(onDisk(path), { throwIfNoEntry: false }),
    readdir: (path) => readdirSync(onDisk(path), { withFileTypes: true }),
    mkdir: (path) => {
      mkdirSync(onDisk(path));
    },
    rmdir: (path) => rmdirSync(onDisk(path)),
    readFile: (path) => readFileSync(onDisk(path), 'utf8'),
    createFile: (path, text) => writeFileSync(onDisk(path), text, { flag: 'wx' }),
    rename: (from, to) => renameSync(onDisk(from), onDisk(to)),
    unlink: (path) => unlinkSync(onDisk(path)),
    discard: (path) => rmSync(onDisk(path), { force: true }),
  };
}

/** The corpus card lowered as the project file `file`. */
function card(file: string): SfcLowering {
  const source = SFC_CORPUS.find((entry) => entry.path === 'ui/card.jsails')?.source;
  assert.ok(source !== undefined);
  return lowerSfc(source, file, { resolver: CORPUS_RESOLVER });
}

describe('sidecar paths and text', () => {
  it('names the shadow, span table and bridge after the project path', () => {
    assert.equal(shadowPath('ui/card.jsails'), '.jsails/sfc/ui/card.jsails.tsx');
    assert.equal(spanTablePath('ui/card.jsails'), '.jsails/sfc/ui/card.jsails.map.json');
    assert.equal(bridgePath('ui/card.jsails'), '.jsails/sfc/ui/card.d.jsails.ts');
    assert.equal(bridgePath('card.jsails'), '.jsails/sfc/card.d.jsails.ts');
    assert.equal(
      sourceOfShadowPath('.jsails/sfc/pages/blog/[slug].jsails.tsx'),
      'pages/blog/[slug].jsails',
    );
    assert.equal(
      sourceOfBridgePath('.jsails/sfc/pages/blog/[slug].d.jsails.ts'),
      'pages/blog/[slug].jsails',
    );
    assert.equal(sourceOfShadowPath('pages/x.tsx'), undefined);
    assert.equal(sourceOfBridgePath('shared/x.d.ts'), undefined);
  });

  it('writes the shadow text, a fixed bridge, and the span table of the shadow', () => {
    const lowering = lowerCorpus().find((entry) => entry.file === 'pages/blog/[slug].jsails');
    assert.ok(lowering?.shadow !== null && lowering !== undefined);
    const shadow = lowering.shadow;
    assert.ok(shadow !== null);
    const files = sidecarFiles(lowering);
    assert.deepEqual(
      files.map((file) => file.path),
      [
        '.jsails/sfc/pages/blog/[slug].jsails.tsx',
        '.jsails/sfc/pages/blog/[slug].jsails.map.json',
        '.jsails/sfc/pages/blog/[slug].d.jsails.ts',
      ],
    );
    assert.equal(files[0]?.text, lowering.tsx);
    assert.equal(
      files[2]?.text,
      'export * from "./[slug].jsails.js";\nexport { default } from "./[slug].jsails.js";\n',
    );
    const table = JSON.parse(files[1]?.text ?? '') as {
      version: number;
      file: string;
      sources: string[];
      bodyStart: number;
      bodyEnd: number;
      spans: number[][];
    };
    assert.equal(table.version, SPAN_TABLE_VERSION);
    assert.equal(table.file, 'pages/blog/[slug].jsails');
    assert.deepEqual(table.sources, ['pages/blog/[slug].jsails']);
    assert.equal(table.bodyStart, shadow.bodyStart);
    assert.equal(table.bodyEnd, shadow.bodyEnd);
    assert.deepEqual(
      table.spans,
      shadow.spans.map((span) => [
        span.generatedStart,
        span.generatedEnd - span.generatedStart,
        span.originalStart,
        span.originalEnd - span.originalStart,
        span.kind,
        span.features,
        span.source,
      ]),
    );
  });

  it('names the script companion after the component path', () => {
    assert.equal(scriptCompanionPath('ui/card.jsails'), '.jsails/sfc/ui/card.jsails.script.ts');
    assert.equal(
      sourceOfScriptCompanionPath('.jsails/sfc/pages/blog/[slug].jsails.script.ts'),
      'pages/blog/[slug].jsails',
    );
    assert.equal(sourceOfScriptCompanionPath('.jsails/sfc/ui/card.ts'), undefined);
  });

  it('gives a folder with an x.ts a script companion: the catalog names, and defineLive by the state', () => {
    const { path, source } = liveFile('components/task-list.jsails');
    const split = splitSfc(source, path);
    assert.ok(split.ok);
    const folder = lowerSfc(split.folder, path, { resolver: LIVE_RESOLVER });
    const single = lowerSfc(source, path, { resolver: LIVE_RESOLVER });
    assert.deepEqual(
      sidecarFiles(single).map((file) => file.path),
      [shadowPath(path), spanTablePath(path), bridgePath(path)],
    );
    const companion = sidecarFiles(folder).find((file) => file.path === scriptCompanionPath(path));
    assert.equal(
      companion?.text,
      [
        '// Written by jsails sync: what task-list/task-list.ts reads without importing it.',
        'type __State = typeof import("./task-list.jsails.js").default extends',
        "  import('jsails/server-components').ServerComponentDefinition<",
        "    infer State extends import('jsails/server-components').ServerComponentState",
        '  >',
        '  ? State',
        '  : never;',
        'declare module "./task-list/task-list.js" {',
        '  export const serverAction: typeof import("jsails/server-components").serverAction;',
        '  export function defineLive<Actions = Record<never, never>, Derived = Record<never, never>>(',
        '    options: {',
        "      readonly stateSchema: import('jsails/server-components').DefineComponentOptions<__State>['stateSchema'];",
        '    } & Omit<',
        "      import('jsails/server-components').LiveComponentOptions<__State, Actions, Derived>,",
        "      'render' | 'staticFallback'",
        '    >,',
        '  ): void;',
        '}',
        'export {};',
        '',
      ].join('\n'),
    );
    // A hand-built source says nothing of its catalog, so it gets no companion.
    assert.equal(
      sidecarFiles({ file: path, shadow: folder.shadow }).some(
        (file) => file.path === scriptCompanionPath(path),
      ),
      false,
    );
  });

  it('gives a file that did not lower no sidecars', () => {
    const lowering = lowerSfc('<template><p>{{ }}</p></template>\n', 'ui/broken.jsails');
    assert.deepEqual(sidecarFiles(lowering), []);
  });
});

describe('writeSidecars', () => {
  it('writes every sidecar once, then leaves unchanged files alone', () => {
    const root = project();
    const lowerings = lowerCorpus();
    const first = writeSidecars(root, lowerings);
    assert.equal(first.written.length, lowerings.length * 3);
    assert.deepEqual(first.unchanged, []);
    assert.deepEqual(first.removed, []);
    assert.deepEqual(
      tree(join(root, '.jsails', 'sfc')),
      first.written.map((path) => path.slice('.jsails/sfc/'.length)),
      'no temporary file is left behind',
    );
    const second = writeSidecars(root, lowerings);
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.unchanged, first.written);
    for (const lowering of lowerings) {
      assert.equal(read(root, shadowPath(lowering.file)), lowering.tsx);
    }
  });

  it('rewrites a changed shadow and prunes the sidecars of a deleted or failing file', () => {
    const root = project();
    const lowerings = lowerCorpus();
    writeSidecars(root, lowerings);
    const owned = join(root, '.jsails', 'sfc', 'ui', 'notes.txt');
    writeFileSync(owned, 'not a sidecar');
    mkdirSync(join(root, '.jsails', 'sfc', 'old', 'deep'), { recursive: true });
    writeFileSync(join(root, '.jsails', 'sfc', 'old', 'deep', 'gone.jsails.tsx'), 'stale');
    writeFileSync(join(root, '.jsails', 'other.txt'), 'outside the sidecar directory');

    const changed = lowerSfc('<template><p>Changed</p></template>\n', 'pages/index.jsails');
    const failing = lowerSfc('<template><p>{{ }}</p></template>\n', 'ui/shell.jsails');
    const next = lowerings
      .filter((entry) => entry.file !== 'ui/card.jsails')
      .map((entry) =>
        entry.file === 'pages/index.jsails'
          ? changed
          : entry.file === 'ui/shell.jsails'
            ? failing
            : entry,
      );
    const result = writeSidecars(root, next);
    assert.deepEqual(result.written, [
      spanTablePath('pages/index.jsails'),
      shadowPath('pages/index.jsails'),
    ]);
    assert.deepEqual(
      result.removed,
      [
        '.jsails/sfc/old/deep/gone.jsails.tsx',
        bridgePath('ui/card.jsails'),
        shadowPath('ui/card.jsails'),
        spanTablePath('ui/card.jsails'),
        bridgePath('ui/shell.jsails'),
        shadowPath('ui/shell.jsails'),
        spanTablePath('ui/shell.jsails'),
      ].sort(),
    );
    assert.equal(read(root, shadowPath('pages/index.jsails')), changed.tsx);
    assert.equal(readFileSync(owned, 'utf8'), 'not a sidecar');
    assert.equal(existsSync(join(root, '.jsails', 'sfc', 'old')), false, 'emptied directories go');
    assert.equal(existsSync(join(root, '.jsails', 'other.txt')), true);
  });

  it('writes a folder script companion, and removes it when the component becomes one file', () => {
    const root = project();
    const { path, source } = liveFile('components/gate.jsails');
    const split = splitSfc(source, path);
    assert.ok(split.ok);
    const folder = lowerSfc(split.folder, path, { resolver: LIVE_RESOLVER });
    assert.ok(writeSidecars(root, [folder]).written.includes(scriptCompanionPath(path)));
    const single = lowerSfc(source, path, { resolver: LIVE_RESOLVER });
    assert.deepEqual(writeSidecars(root, [single]).removed, [scriptCompanionPath(path)]);
    assert.equal(existsSync(join(root, ...scriptCompanionPath(path).split('/'))), false);
  });

  it(
    'refuses a symbolic link on the way to a sidecar, naming only the project path',
    {
      skip:
        process.platform === 'win32'
          ? 'creating a symbolic link needs a privilege on Windows'
          : false,
    },
    () => {
      const root = project();
      const elsewhere = mkdtempSync(join(scratch, 'elsewhere-'));
      mkdirSync(join(root, '.jsails'));
      symlinkSync(elsewhere, join(root, '.jsails', 'sfc'));
      assert.throws(
        () => writeSidecars(root, lowerCorpus()),
        (error: unknown) => {
          assert.ok(SfcSidecarErrors.is(error, 'symlinked_directory'));
          assert.deepEqual(error.context, { path: '.jsails/sfc' });
          assert.ok(!error.message.includes(root));
          return true;
        },
      );
      assert.deepEqual(readdirSync(elsewhere), []);

      const nested = project();
      const target = mkdtempSync(join(scratch, 'target-'));
      mkdirSync(join(nested, '.jsails', 'sfc'), { recursive: true });
      symlinkSync(target, join(nested, '.jsails', 'sfc', 'ui'));
      assert.throws(
        () => writeSidecars(nested, lowerCorpus()),
        (error: unknown) => SfcSidecarErrors.is(error, 'symlinked_directory'),
      );
      assert.deepEqual(readdirSync(target), []);
    },
  );

  it('removes the temporary file when a write fails, and rethrows', () => {
    const root = project();
    const refused = new Error('rename refused');
    const fs: SidecarFs = {
      ...caseInsensitiveFs(root),
      rename: () => {
        throw refused;
      },
    };
    assert.throws(() => writeSidecars(root, [card('ui/card.jsails')], { fs }), refused);
    assert.deepEqual(tree(join(root, '.jsails', 'sfc')), []);
  });

  it('refuses a file where a sidecar directory goes, naming it as a file', () => {
    for (const blocked of ['.jsails', '.jsails/sfc', '.jsails/sfc/ui']) {
      const root = project();
      const segments = blocked.split('/');
      mkdirSync(join(root, ...segments.slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...segments), 'in the way');
      assert.throws(
        () => writeSidecars(root, lowerCorpus()),
        (error: unknown) => {
          assert.ok(SfcSidecarErrors.is(error, 'not_a_directory'), blocked);
          assert.deepEqual(error.context, { path: blocked });
          assert.ok(!error.message.includes(root));
          assert.ok(!error.message.includes('symbolic link'));
          return true;
        },
      );
      assert.equal(read(root, blocked), 'in the way');
    }
  });
});

describe('writeSidecars on a case-insensitive file system', () => {
  it('replaces the sidecars of a source renamed only in case', () => {
    const root = project();
    const fs = caseInsensitiveFs(root);
    assert.equal(card('ui/Card.jsails').tsx, card('ui/card.jsails').tsx, 'the same shadow text');
    writeSidecars(root, [card('ui/Card.jsails')], { fs });

    const renamed = writeSidecars(root, [card('ui/card.jsails')], { fs });
    const expected = sidecarFiles(card('ui/card.jsails')).map((file) => file.path);
    assert.deepEqual(renamed.written, [...expected].sort());
    assert.deepEqual(renamed.unchanged, []);
    assert.deepEqual(
      renamed.removed,
      sidecarFiles(card('ui/Card.jsails'))
        .map((file) => file.path)
        .sort(),
    );
    assert.deepEqual(tree(join(root, '.jsails', 'sfc')), [
      'ui/card.d.jsails.ts',
      'ui/card.jsails.map.json',
      'ui/card.jsails.tsx',
    ]);
    for (const file of sidecarFiles(card('ui/card.jsails'))) {
      assert.equal(read(root, file.path), file.text);
    }

    const again = writeSidecars(root, [card('ui/card.jsails')], { fs });
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.removed, []);
    assert.deepEqual(again.unchanged, [...expected].sort());
  });

  it('respells a directory renamed only in case, keeping a file sync does not own', () => {
    for (const foreign of [false, true]) {
      const root = project();
      const fs = caseInsensitiveFs(root);
      writeSidecars(root, [card('UI/card.jsails')], { fs });
      if (foreign) writeFileSync(join(root, '.jsails', 'sfc', 'UI', 'notes.txt'), 'kept');

      const renamed = writeSidecars(root, [card('ui/card.jsails')], { fs });
      assert.deepEqual(
        renamed.written,
        sidecarFiles(card('ui/card.jsails'))
          .map((file) => file.path)
          .sort(),
      );
      assert.deepEqual(readdirSync(join(root, '.jsails', 'sfc')), ['ui']);
      assert.deepEqual(tree(join(root, '.jsails', 'sfc', 'ui')), [
        'card.d.jsails.ts',
        'card.jsails.map.json',
        'card.jsails.tsx',
        ...(foreign ? ['notes.txt'] : []),
      ]);
      for (const file of sidecarFiles(card('ui/card.jsails'))) {
        assert.equal(read(root, file.path), file.text);
      }

      const again = writeSidecars(root, [card('ui/card.jsails')], { fs });
      assert.deepEqual(again.written, [], 'no churn once respelled');
      assert.deepEqual(again.removed, []);
    }
  });
});
