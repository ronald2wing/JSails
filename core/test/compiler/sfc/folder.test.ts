/**
 * The folder layout's property (sfc-plan SFC-19): every corpus component
 * compiled as one file and as the folder `jsails convert` makes of it emits
 * the same module, the same shadow types and the same diagnostics, each
 * diagnostic positioned in the file that holds its block. Seeded faults
 * planted in templates and scripts keep the property; under the real
 * TypeScript 7 compiler the folder apps check clean, a planted fault is
 * reported once, at its place in `x.jsails` or `x.ts`, exactly where the
 * single file reports it; and `x.ts` checked on its own as the module an
 * editor opens, with its script companion, has no error but an unused
 * binding the template reads, so the catalog's names resolve and
 * `defineLive` is typed by the component's state. A folder's server module
 * stays in the folder, so the folder's module imports it there, the one
 * place the two layouts' modules differ.
 */

import assert from 'node:assert/strict';
import { after, describe, it, type TestContext } from 'node:test';

import { renderSfcTemplate } from '../../../src/cli/commands/make-templates.js';
import { compileSfc } from '../../../src/compiler/sfc/compile.js';
import type { SfcDiagnostic } from '../../../src/compiler/sfc/diagnostics.js';
import {
  sfcFolderPaths,
  splitSfc,
  type SfcFolderPosition,
} from '../../../src/compiler/sfc/layout.js';
import { lineIndex } from '../../../src/compiler/sfc/line-index.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { EMPTY_RESOLVER, type NameResolver } from '../../../src/compiler/sfc/name-resolver.js';
import { bridgePath, sidecarFiles, shadowPath } from '../../../src/compiler/sfc/shadow.js';
import { forEachSeed, type SeededRandom } from '../../../src/testing/seeded-random.js';
import {
  compileFixtureApp,
  type CompiledFixtureApp,
  type FixtureFile,
} from './compiled-fixture.js';
import { CORPUS_APP, CORPUS_RESOLVER } from './corpus.js';
import { LIVE_APP, LIVE_RESOLVER } from './live-corpus.js';

/** A corpus app and its catalog. */
interface Corpus {
  readonly name: string;
  readonly files: readonly FixtureFile[];
  readonly resolver: NameResolver;
}

const CORPORA: readonly Corpus[] = [
  { name: 'function kinds', files: CORPUS_APP, resolver: CORPUS_RESOLVER },
  { name: 'live', files: LIVE_APP, resolver: LIVE_RESOLVER },
];

/** TypeScript's unused-binding codes, which `noUnusedLocals` raises. */
const UNUSED = new Set([6133, 6192, 6196, 6198]);

/** A component of a corpus in both layouts. */
interface Twin {
  readonly file: string;
  readonly source: string;
  readonly folder: FixtureFile[];
  readonly positionOf: (offset: number) => SfcFolderPosition | undefined;
}

/** The component `file` split into its folder's files, or `undefined` when it does not split. */
function twinOf(file: string, source: string): Twin | undefined {
  const split = splitSfc(source, file);
  if (!split.ok) return undefined;
  const paths = sfcFolderPaths(file);
  const folder: FixtureFile[] = [{ path: paths.template, source: split.folder.template }];
  if (split.folder.script !== undefined)
    folder.push({ path: paths.script, source: split.folder.script });
  if (split.folder.style !== undefined)
    folder.push({ path: paths.style, source: split.folder.style });
  if (split.folder.scopedStyle !== undefined) {
    folder.push({ path: paths.scopedStyle, source: split.folder.scopedStyle });
  }
  return { file, source, folder, positionOf: split.positionOf };
}

/** Every `.jsails` file of `files` as its folder; other files as they are. */
function asFolders(files: readonly FixtureFile[]): { files: FixtureFile[]; twins: Twin[] } {
  const twins: Twin[] = [];
  const out: FixtureFile[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.jsails')) {
      out.push(file);
      continue;
    }
    const twin = twinOf(file.path, file.source);
    assert.ok(twin !== undefined, `${file.path} splits`);
    twins.push(twin);
    out.push(...twin.folder);
  }
  return { files: out, twins };
}

function lowerFolder(twin: Twin, resolver: NameResolver): SfcLowering {
  const text = (suffix: string): string | undefined =>
    twin.folder.find((file) => file.path.endsWith(suffix))?.source;
  const paths = sfcFolderPaths(twin.file);
  const script = text(paths.script.slice(paths.script.lastIndexOf('/')));
  const style = text(paths.style.slice(paths.style.lastIndexOf('/')));
  const scopedStyle = text(paths.scopedStyle.slice(paths.scopedStyle.lastIndexOf('/')));
  return lowerSfc(
    {
      template: text(paths.template.slice(paths.template.lastIndexOf('/'))) ?? '',
      ...(script === undefined ? {} : { script }),
      ...(style === undefined ? {} : { style }),
      ...(scopedStyle === undefined ? {} : { scopedStyle }),
    },
    twin.file,
    { resolver },
  );
}

/** A single-file diagnostic moved to the folder through the split's position map. */
function moved(twin: Twin, entry: SfcDiagnostic): readonly unknown[] {
  const start = twin.positionOf(entry.start);
  const last = entry.end > entry.start ? twin.positionOf(entry.end - 1) : start;
  assert.ok(start !== undefined && last !== undefined, `${entry.code} lies in a copied range`);
  const end = entry.end > entry.start ? last.offset + 1 : start.offset;
  return [entry.severity, entry.code, entry.message, start.file, start.offset, end];
}

function placed(entry: SfcDiagnostic): readonly unknown[] {
  return [entry.severity, entry.code, entry.message, entry.file, entry.start, entry.end];
}

/**
 * The sidecars a lowering's types come from: the shadow and the bridge, not
 * the span table (whose sources differ) or a folder's script companion.
 */
function typeSidecars(lowering: SfcLowering): readonly unknown[] {
  const typed = new Set([shadowPath(lowering.file), bridgePath(lowering.file)]);
  return sidecarFiles(lowering)
    .filter((file) => typed.has(file.path))
    .map((file) => [file.path, file.text]);
}

/**
 * Assert that both layouts of `twin` lower and compile to the same artifacts;
 * returns the files of the folder that its diagnostics name.
 */
function assertSameOutput(twin: Twin, resolver: NameResolver): readonly string[] {
  const single = lowerSfc(twin.source, twin.file, { resolver });
  const folder = lowerFolder(twin, resolver);
  assert.equal(folder.layout, 'folder');
  assert.equal(folder.kind, single.kind, twin.file);
  assert.equal(folder.tsx, single.tsx, twin.file);
  assert.equal(folder.scopeId, single.scopeId, twin.file);
  assert.deepEqual(folder.styles, single.styles, twin.file);
  assert.deepEqual(folder.exports, single.exports, twin.file);
  assert.deepEqual(folder.imports, single.imports, twin.file);
  assert.deepEqual(typeSidecars(folder), typeSidecars(single), twin.file);
  assert.deepEqual(
    folder.diagnostics.map(placed),
    single.diagnostics.map((entry) => moved(twin, entry)),
    twin.file,
  );
  const singleCompiled = compileSfc(single);
  const folderCompiled = compileSfc(folder);
  assert.equal(folderCompiled.js, singleCompiled.js, twin.file);
  assert.equal(folderCompiled.outputFile, singleCompiled.outputFile);
  assert.deepEqual(
    folderCompiled.diagnostics.map(placed),
    singleCompiled.diagnostics.map((entry) => moved(twin, entry)),
    twin.file,
  );
  return [...folder.diagnostics, ...folderCompiled.diagnostics].map((entry) => entry.file);
}

/** Template faults: each is reported by the lowering, or lowers to code tsc rejects. */
const TEMPLATE_FAULTS = [
  '<p js-unknown="x"></p>',
  '<p>{{ }}</p>',
  '<p>{{ a + }}</p>',
  '<li js-for="x of"></li>',
  '<p>&bogus;</p>',
  '<p js-else></p>',
  '<p>{{ missingName }}</p>',
  '<p :title="1 +"></p>',
  '<Unknown />',
];

/** Script statements: two the lowering reports, one it copies as written. */
const SCRIPT_FAULTS = [
  'export default 1;',
  'defineProps<{ a: string }>();',
  "export const leak = 'x';",
];

/**
 * `source` with a seeded fault at a line start of its template content, or
 * last in its script body: the lowering stops at a template error before it
 * analyses the script, so each round plants one kind.
 */
function withFault(random: SeededRandom, source: string, where: 'template' | 'script'): string {
  const pick = <T>(list: readonly T[]): T => list[random.int(0, list.length - 1)] as T;
  if (where === 'script') {
    const end = source.indexOf('</script>', source.indexOf('<script lang="ts">'));
    return `${source.slice(0, end)}${pick(SCRIPT_FAULTS)}\n${source.slice(end)}`;
  }
  const open = source.indexOf('<template>');
  const close = source.indexOf('</template>', open);
  const lineStarts = [...source.slice(open, close).matchAll(/\n/g)].map(
    (match) => open + (match.index ?? 0) + 1,
  );
  const at = lineStarts.length > 0 ? pick(lineStarts) : close;
  return `${source.slice(0, at)}${pick(TEMPLATE_FAULTS)}\n${source.slice(at)}`;
}

describe('a component as one file and as a folder', () => {
  it('lowers and compiles every corpus component to the same artifacts', () => {
    for (const corpus of CORPORA) {
      for (const twin of asFolders(corpus.files).twins) assertSameOutput(twin, corpus.resolver);
    }
  });

  it('keeps the artifacts and the diagnostics equal with seeded faults planted', async (t: TestContext) => {
    const components = CORPORA.flatMap((corpus) =>
      corpus.files
        .filter((file) => file.path.endsWith('.jsails'))
        .map((file) => ({ file, resolver: corpus.resolver })),
    );
    await forEachSeed(t, (random) => {
      const named = new Set<string>();
      for (let round = 0; round < 24; round += 1) {
        const where = round % 2 === 0 ? 'template' : 'script';
        const pool =
          where === 'script'
            ? components.filter((entry) => entry.file.source.includes('<script lang="ts">'))
            : components;
        const { file, resolver } = pool[random.int(0, pool.length - 1)] ?? {};
        assert.ok(file !== undefined && resolver !== undefined);
        const twin = twinOf(file.path, withFault(random, file.source, where));
        if (twin === undefined) continue;
        for (const path of assertSameOutput(twin, resolver)) {
          named.add(path.endsWith('.jsails') ? 'template' : 'script');
        }
      }
      // The faults reach the lowering, in the template file and in x.ts.
      assert.deepEqual([...named].sort(), ['script', 'template']);
    });
  });
});

const apps: CompiledFixtureApp[] = [];

after(() => {
  for (const app of apps) app.dispose();
});

function compile(files: readonly FixtureFile[], resolver: NameResolver): CompiledFixtureApp {
  const app = compileFixtureApp(files, { resolver });
  apps.push(app);
  return app;
}

/** The fault planted in every template, and the one planted in every script. */
const TYPE_FAULT = '<i>{{ (1 as number).toFixd() }}</i>';
const SCRIPT_TYPE_FAULT = "export const misTyped: number = 'x' as string;\n";

/** `source` with a type fault last in its template and, when it has one, last in its script. */
function planted(source: string): string {
  const end = source.lastIndexOf('</template>');
  let text = `${source.slice(0, end)}${TYPE_FAULT}\n${source.slice(end)}`;
  const script = text.indexOf('<script lang="ts">');
  if (script >= 0) {
    const scriptEnd = text.indexOf('</script>', script);
    text = `${text.slice(0, scriptEnd)}${SCRIPT_TYPE_FAULT}${text.slice(scriptEnd)}`;
  }
  return text;
}

/** The 1-based `line:column` of `offset` in `text`. */
function lineColumn(text: string, offset: number): string {
  const position = lineIndex(text).positionAt(offset);
  return `${position.line + 1}:${position.column + 1}`;
}

describe('a folder app under TypeScript 7', () => {
  for (const corpus of CORPORA) {
    it(`checks the ${corpus.name} corpus as folders with no diagnostic`, () => {
      const result = compile(asFolders(corpus.files).files, corpus.resolver).typecheck();
      assert.deepEqual(result.unparsed, []);
      assert.deepEqual(result.diagnostics, []);
    });

    it(`reports each planted ${corpus.name} fault once, in the folder file holding it, where the file reports it`, () => {
      const files = corpus.files.map((file) =>
        file.path.endsWith('.jsails') ? { ...file, source: planted(file.source) } : file,
      );
      const { files: folderFiles, twins } = asFolders(files);
      const single = compile(files, corpus.resolver).typecheck();
      const folder = compile(folderFiles, corpus.resolver).typecheck();
      assert.deepEqual(single.unparsed, []);
      assert.deepEqual(folder.unparsed, []);
      const texts = new Map(folderFiles.map((file) => [file.path, file.source]));
      const expected = single.diagnostics.map((entry) => {
        const twin = twins.find((candidate) => candidate.file === entry.file);
        if (twin === undefined || entry.position === null) {
          return `${entry.origin} ${entry.file} TS${entry.code}`;
        }
        const offset = lineIndex(twin.source).offsetAt({
          line: entry.position.line - 1,
          column: entry.position.column - 1,
        });
        assert.ok(offset !== undefined);
        const position = twin.positionOf(offset);
        assert.ok(position !== undefined);
        return `${entry.origin} ${position.file}:${lineColumn(texts.get(position.file) ?? '', position.offset)} TS${entry.code}`;
      });
      const actual = folder.diagnostics.map(
        (entry) =>
          `${entry.origin} ${entry.file}:${entry.position?.line}:${entry.position?.column} TS${entry.code}`,
      );
      assert.deepEqual(actual.sort(), expected.sort());
      const scripts = twins.filter((twin) => twin.folder.some((file) => file.path.endsWith('.ts')));
      assert.ok(scripts.length > 0);
      for (const twin of scripts) {
        const script = sfcFolderPaths(twin.file).script;
        assert.ok(
          actual.some((line) => line.startsWith(`source ${script}:`) && line.endsWith('TS2322')),
          `the script fault of ${twin.file} is reported in ${script}`,
        );
      }
    });

    it(`checks every ${corpus.name} x.ts on its own, as an editor opens it, finding only bindings the template reads unused`, () => {
      const { files, twins } = asFolders(corpus.files);
      const result = compile(files, corpus.resolver).typecheck();
      assert.deepEqual(result.diagnostics, []);
      const texts = new Map(files.map((file) => [file.path, file.source]));
      for (const entry of result.raw) {
        const twin = twins.find(
          (candidate) => sfcFolderPaths(candidate.file).script === entry.file,
        );
        assert.ok(
          twin !== undefined && UNUSED.has(entry.code),
          `${entry.file} TS${entry.code}: ${entry.message}`,
        );
        const name = /'([^']+)'/.exec(entry.message)?.[1] ?? '';
        const template = texts.get(sfcFolderPaths(twin.file).template) ?? '';
        assert.match(template, new RegExp(`\\b${name}\\b`), `the template reads ${name}`);
      }
      assert.equal(result.status, result.raw.length === 0 ? 0 : 1);
    });
  }

  it('checks and runs a folder that imports its own server module, which stays in the folder', async () => {
    const server = "export function greet(): string {\n  return 'hi';\n}\n";
    const script =
      "import { greet } from './card.server.js';\nexport const msg: string = greet();\n";
    const single = compile(
      [
        {
          path: 'ui/card.jsails',
          source: `<script lang="ts">\n${script}</script>\n\n<template><p>{{ msg }}</p></template>\n`,
        },
        { path: 'ui/card.server.ts', source: server },
      ],
      EMPTY_RESOLVER,
    );
    const folder = compile(
      [
        { path: 'ui/card/card.jsails', source: '<template><p>{{ msg }}</p></template>\n' },
        { path: 'ui/card/card.ts', source: script },
        { path: 'ui/card/card.server.ts', source: server },
      ],
      EMPTY_RESOLVER,
    );
    for (const app of [single, folder]) {
      const result = app.typecheck();
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.raw, []);
      assert.equal(result.status, 0);
      assert.equal((await app.load('ui/card.jsails'))['msg'], 'hi');
    }
    const [file] = single.lowerings;
    const [twin] = folder.lowerings;
    assert.ok(file !== undefined && twin !== undefined);
    assert.equal(twin.layout, 'folder');
    assert.equal(
      twin.tsx,
      file.tsx.replace("from './card.server.js'", "from './card/card.server.js'"),
    );
    assert.notEqual(twin.tsx, file.tsx);
  });

  it('checks the folders make --mfc writes with no diagnostic, x.ts on its own included', () => {
    const { files } = asFolders([
      { path: 'pages/about-us.jsails', source: renderSfcTemplate('page', 'about-us') },
      {
        path: 'components/task-box.jsails',
        source: renderSfcTemplate('server-component', 'task-box'),
      },
    ]);
    const result = compile(files, EMPTY_RESOLVER).typecheck();
    assert.deepEqual(result.unparsed, []);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.raw, []);
    assert.equal(result.status, 0);
  });
});
