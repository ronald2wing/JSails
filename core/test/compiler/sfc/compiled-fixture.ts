/**
 * The compiled-fixture harness of the `.jsails` compiler (sfc-plan §3.4):
 * `compileFixtureApp` turns an app given as source files into what an app
 * build would leave on disk, without a bundler or a Node loader.
 *
 * Into a fresh directory under `core/dist/test/compiler/sfc/fixture-app/`
 * it writes, for every `.jsails` file, the source, its module compiled by
 * `compileSfc` (`.js`, with `.jsails` imports rewritten for Node) and the
 * composed source map beside it (`.js.map`, linked by a `sourceMappingURL`
 * comment); for every `.ts`/`.tsx` file the source and its oxc output; any
 * other file as given; the sidecars `jsails sync` writes; a `package.json`
 * marking the directory an ES module app; and a strict `tsconfig.json` with
 * the sidecar layout. The directory sits inside the checkout, so Node and
 * TypeScript reach `jsails` through the workspace link exactly as an
 * installed app does. Route discovery, `renderRoute`, `generateStaticSite`
 * and `createTestApp` then run over it as over any compiled app, and
 * `typecheck()` runs the real `tsc` and remaps its output.
 *
 * A component may be one file or a folder (`layout.ts`): the files are
 * grouped by `sfcComponents`, a folder lowers from its member files under its
 * component path, and its `x.ts` is written for `tsc` to check but compiled
 * only as part of the component, as an app build does.
 *
 * Every component must lower and compile without an error; the harness
 * throws, naming the diagnostic codes, when one does not. REQ-08's outcome
 * tests build their `.jsails` page fixtures with it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { transformSync } from 'rolldown/utils';

import { compileSfc, sfcOutputPath, type SfcCompiled } from '../../../src/compiler/sfc/compile.js';
import { hasSfcErrors } from '../../../src/compiler/sfc/diagnostics.js';
import {
  sfcComponents,
  sfcFolderPaths,
  type SfcFolderSources,
} from '../../../src/compiler/sfc/layout.js';
import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { EMPTY_RESOLVER, type NameResolver } from '../../../src/compiler/sfc/name-resolver.js';
import {
  parseTscOutput,
  remapTscOutput,
  type RemappedDiagnostic,
  type TscDiagnostic,
} from '../../../src/compiler/sfc/remap.js';
import {
  SIDECAR_DIRECTORY,
  writeSidecars,
  type SidecarSource,
} from '../../../src/compiler/sfc/shadow.js';

/** A file of a fixture app: its project path and its text. */
export interface FixtureFile {
  readonly path: string;
  readonly source: string;
}

/** Options of {@link compileFixtureApp}. */
export interface CompileFixtureOptions {
  /** Resolves the names the `.jsails` files leave free; resolves nothing when omitted. */
  readonly resolver?: NameResolver;
}

/** The outcome of `tsc` over a fixture app. */
export interface FixtureTypecheck {
  readonly status: number | null;
  readonly diagnostics: readonly RemappedDiagnostic[];
  /** What `tsc` printed that is not a diagnostic: stderr, then unparsed stdout lines. */
  readonly unparsed: readonly string[];
  /** What `tsc` reported before remapping, at the files it checked. */
  readonly raw: readonly TscDiagnostic[];
}

/** A compiled fixture app on disk. */
export interface CompiledFixtureApp {
  /** The app's absolute directory. */
  readonly root: string;
  readonly lowerings: readonly SfcLowering[];
  readonly compilations: readonly SfcCompiled[];
  /** Import the compiled module of the project file or component `file` (`pages/index.jsails`). */
  load(file: string): Promise<Record<string, unknown>>;
  /**
   * Run `tsc` over the app and its sidecars and remap what it reports.
   * `extra` adds the sidecars of hand-built shadows to the ones the app's
   * `.jsails` files lowered to.
   */
  typecheck(extra?: readonly SidecarSource[]): FixtureTypecheck;
  /** Remove the app's directory; modules already imported stay loaded. */
  dispose(): void;
}

/** Where fixture apps are written: inside the checkout, so `jsails` resolves. */
const FIXTURE_APPS = fileURLToPath(new URL('fixture-app/', import.meta.url));

/** The TypeScript 7 compiler the repository builds with. */
const TSC = join(
  dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json')),
  'bin',
  'tsc',
);

/**
 * The starter's compiler options, made as strict as an app may make them:
 * generated code must not trip an unused-name or indexed-access check.
 */
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noUncheckedIndexedAccess: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      jsxImportSource: 'jsails',
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
      rootDirs: ['.', SIDECAR_DIRECTORY],
      allowArbitraryExtensions: true,
    },
    include: [
      '**/*.ts',
      '**/*.tsx',
      `${SIDECAR_DIRECTORY}/**/*.tsx`,
      `${SIDECAR_DIRECTORY}/**/*.script.ts`,
    ],
  },
  null,
  2,
)}\n`;

function write(root: string, path: string, text: string): void {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function fail(file: string, codes: readonly string[]): never {
  throw new Error(`fixture ${file} does not compile: ${codes.join(', ')}`);
}

/**
 * The member texts of the folder component `file`, recording its `x.ts` in
 * `scripts`: a member module is compiled only as part of its component.
 */
function folderSources(
  file: string,
  byPath: ReadonlyMap<string, string>,
  scripts: Set<string>,
): SfcFolderSources {
  const paths = sfcFolderPaths(file);
  const script = byPath.get(paths.script);
  const style = byPath.get(paths.style);
  const scopedStyle = byPath.get(paths.scopedStyle);
  if (script !== undefined) scripts.add(paths.script);
  return {
    template: byPath.get(paths.template) ?? '',
    ...(script === undefined ? {} : { script }),
    ...(style === undefined ? {} : { style }),
    ...(scopedStyle === undefined ? {} : { scopedStyle }),
  };
}

/** Write and compile the fixture app `files`; see the module comment. */
export function compileFixtureApp(
  files: readonly FixtureFile[],
  options: CompileFixtureOptions = {},
): CompiledFixtureApp {
  mkdirSync(FIXTURE_APPS, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_APPS, 'run-'));
  const lowerings: SfcLowering[] = [];
  const compilations: SfcCompiled[] = [];
  try {
    write(root, 'package.json', '{ "type": "module", "private": true }\n');
    write(root, 'tsconfig.json', TSCONFIG);
    const byPath = new Map(files.map((file) => [file.path, file.source]));
    const index = sfcComponents([...byPath.keys()]);
    if (index.diagnostics.length > 0) {
      fail(
        index.diagnostics[0]?.file ?? '',
        index.diagnostics.map((entry) => entry.code),
      );
    }
    const folderScripts = new Set<string>();
    for (const component of index.components) {
      const lowering = lowerSfc(
        component.layout === 'file'
          ? (byPath.get(component.file) ?? '')
          : folderSources(component.file, byPath, folderScripts),
        component.file,
        { resolver: options.resolver ?? EMPTY_RESOLVER },
      );
      lowerings.push(lowering);
      const compiled = compileSfc(lowering, { specifiers: 'node' });
      if (compiled.js === null || hasSfcErrors(compiled.diagnostics)) {
        fail(
          component.file,
          compiled.diagnostics.map((entry) => entry.code),
        );
      }
      compilations.push(compiled);
      const mapName = `${compiled.outputFile.slice(compiled.outputFile.lastIndexOf('/') + 1)}.map`;
      write(
        root,
        compiled.outputFile,
        `${compiled.js.endsWith('\n') ? compiled.js : `${compiled.js}\n`}` +
          `//# sourceMappingURL=${encodeURIComponent(mapName)}\n`,
      );
      write(root, `${compiled.outputFile}.map`, JSON.stringify(compiled.map));
    }
    for (const file of files) {
      write(root, file.path, file.source);
      if (
        /\.tsx?$/.test(file.path) &&
        !file.path.endsWith('.d.ts') &&
        !folderScripts.has(file.path)
      ) {
        const output = transformSync(file.path, file.source, {
          lang: file.path.endsWith('.tsx') ? 'tsx' : 'ts',
          jsx: { runtime: 'automatic', importSource: 'jsails' },
        });
        if (output.errors.length > 0) fail(file.path, ['typescript_syntax']);
        // What a bundler would resolve: a relative `.jsails` import is the
        // compiled sibling, as `compileSfc` writes it in `.jsails` modules.
        const code = output.code.replace(
          /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']*)\.jsails\2/g,
          (_match, keyword: string, quote: string, stem: string) =>
            `${keyword}${quote}${stem}.js${quote}`,
        );
        write(root, file.path.replace(/\.tsx?$/, '.js'), code);
      }
    }
    writeSidecars(root, lowerings);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    root,
    lowerings: Object.freeze(lowerings),
    compilations: Object.freeze(compilations),
    load: async (file: string): Promise<Record<string, unknown>> => {
      const output = file.endsWith('.jsails')
        ? sfcOutputPath(file)
        : file.replace(/\.tsx?$/, '.js');
      return (await import(pathToFileURL(join(root, ...output.split('/'))).href)) as Record<
        string,
        unknown
      >;
    },
    typecheck: (extra: readonly SidecarSource[] = []): FixtureTypecheck => {
      const sources = [...lowerings, ...extra];
      writeSidecars(root, sources);
      const result = spawnSync(
        process.execPath,
        [TSC, '-p', 'tsconfig.json', '--pretty', 'false'],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );
      const diagnostics = remapTscOutput(result.stdout, { root, cwd: root, sources });
      const parsed = parseTscOutput(result.stdout);
      return Object.freeze({
        status: result.status,
        diagnostics,
        unparsed: Object.freeze([
          ...result.stderr.split(/\r?\n/).filter((line) => line.trim() !== ''),
          ...parsed.unparsed,
        ]),
        raw: parsed.diagnostics,
      });
    },
    dispose: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  });
}
