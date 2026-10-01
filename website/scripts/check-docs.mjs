#!/usr/bin/env node
/**
 * The docs compile gate. Every `ts`/`tsx`/`js` fence in
 * `website/content/docs`, `core/AGENTS.md`, and the starter guide text that
 * `core/src/app/starter/guides.ts` renders into each generated app becomes a
 * module in a temporary project that depends on the built workspaces, and the
 * project is compiled with `tsc --noEmit` under the web starter's compiler
 * options (read from `core/templates/starter-web/tsconfig.json.template`) with
 * the `.jsails/` declarations the real `jsails build:meta` step generates, so a
 * bare framework global type-checks exactly as it does in an app.
 *
 * Fence attributes (see `docs-extract.mjs`): a fence is a whole module by
 * default; `fragment` compiles it in a second program that also has
 * `website/content/docs/_fixtures.d.ts` in scope; `run` also executes it under
 * `node --test` and requires an assertion; `no-check reason="…"` skips it, and
 * at most `NO_CHECK_BUDGET` fences may do so.
 *
 * Fences that share a program cannot see each other's declarations: every
 * fence is a module (`moduleDetection: "force"`), and a fence that declares
 * into the program's shared scope (`declare global`, `declare module '…'`, a
 * triple-slash reference; see `docs-syntax.mjs`) compiles in a program of its
 * own, so it can neither satisfy nor break another sample.
 *
 * Marked code references (`jsails/database#ApplicationRecord`) are resolved
 * against the committed API report (`api/<package>/<entry>.api.md`): the entry
 * must exist, list the name, and not tier it `internal`. Unmarked prose is not
 * scanned.
 *
 * Every published entry (a `{ types, default }` pair in a public workspace's
 * `exports`) must be imported, by an import the parser sees (not one in a
 * comment), from at least one docs-page fence that compiles cleanly;
 * `UNDOCUMENTED_SUBPATHS` exempts tooling seams.
 *
 * The gate runs in report-only mode: today's findings are listed in
 * `scripts/expected-failures/docs.json` (gate `docs`, `scripts/gates/docs.mjs`)
 * and tolerated; a finding not listed fails, and a listed finding that no
 * longer occurs fails until its entry is removed, so the ledger only shrinks.
 * Ledger ids name a fence by page, heading anchor, and ordinal under that
 * heading, never by line, so edits elsewhere do not re-key them, and carry the
 * diagnostic without TypeScript's spelling suggestion, which depends on every
 * name in scope rather than on the sample. Problems the
 * ledger cannot excuse (an invalid fence attribute, the no-check budget, a
 * project that cannot be set up) always fail.
 *
 * Usage: node website/scripts/check-docs.mjs            check (needs a build)
 *        node website/scripts/check-docs.mjs --verbose  also print listed findings
 *        node website/scripts/check-docs.mjs --record   rewrite the ledger to today's findings
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LEDGER_DIR, readGateLedger, ratchet } from '../../scripts/expected-failures.mjs';
import { exitStatus, run } from '../../scripts/subprocess.mjs';
import {
  readManifest,
  repoRoot as defaultRepoRoot,
  workspaceDirs,
} from '../../scripts/workspaces.mjs';
import { extractDocument, fenceKey } from './docs-extract.mjs';
import { fenceSyntax } from './docs-syntax.mjs';

/** The gate's name, and the name of its ledger in `scripts/expected-failures/`. */
export const GATE = 'docs';

/** The most `no-check` fences the docs may carry. */
export const NO_CHECK_BUDGET = 10;

/** The work package that empties the ledger and switches the gate to failing. */
export const LEDGER_FIXED_BY = 'KRN-24';

/**
 * Published entries no docs sample has to import. Each one is a tooling seam,
 * not an API an app author imports.
 */
export const UNDOCUMENTED_SUBPATHS = new Map([
  ['jsails/jsx-runtime', 'the compiler target of `jsxImportSource: "jsails"`; never imported'],
]);

/** The starter whose compiler options the samples compile under. */
const STARTER_TSCONFIG = join('core', 'templates', 'starter-web', 'tsconfig.json.template');

/** The `.jsails/` declarations a starter's tsconfig includes. */
const META_DECLARATIONS = Object.freeze([
  '.jsails/project-symbols.app.d.ts',
  '.jsails/project-symbols.server.d.ts',
  '.jsails/framework-symbols.d.ts',
  '.jsails/auto-imports.d.ts',
]);

/** The rendered starter guides: one per preset that ships an `AGENTS.md`. */
const GUIDE_SOURCE = 'core/src/app/starter/guides.ts';

const RUN_TIMEOUT_MS = 60_000;

/**
 * Where the fixtures preamble lands in the project: a `.ts` module (it declares
 * its stubs in `declare global`), so `skipLibCheck` does not hide its errors.
 */
const FIXTURES_MODULE = 'fixtures/fixtures.ts';

/** TypeScript's syntax diagnostics are numbered 1000-1999. */
const SYNTAX_CODE = /^1\d{3}$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPosix(path) {
  return sep === '\\' ? path.replaceAll('\\', '/') : path;
}

/** `.md` files under `dir`, recursively, sorted. */
export function docPages(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return docPages(path);
      return entry.endsWith('.md') ? [path] : [];
    });
}

/**
 * A rendered document whose findings are reported against `sourceFile`: each
 * rendered line maps to the first line of the source that contains its text,
 * or line 1 when the text was assembled at runtime.
 */
export function renderedDocument({ source, sourceText, text }) {
  const sourceLines = sourceText.split(/\r?\n/);
  const renderedLines = text.split(/\r?\n/);
  const cache = new Map();
  const mapLine = (line) => {
    const needle = (renderedLines[line - 1] ?? '').trim();
    if (needle === '') return 1;
    if (!cache.has(needle)) {
      const index = sourceLines.findIndex((candidate) => candidate.includes(needle));
      cache.set(needle, index === -1 ? 1 : index + 1);
    }
    return cache.get(needle);
  };
  return { source, text, mapLine };
}

/** The guide text every preset's generated `AGENTS.md` starts with. */
async function guideDocuments(root) {
  const built = join(root, 'core', 'dist', 'src', 'app', 'starter', 'guides.js');
  if (!existsSync(built))
    throw new Error(`${toPosix(relative(root, built))} is missing; run a build first`);
  const guides = await import(pathToFileURL(built).href);
  const sourceText = readFileSync(join(root, GUIDE_SOURCE), 'utf8');
  const rendered = [
    ...['admin', 'blog', 'saas'].map((variant) => guides.renderWebGuide('', { variant })),
    guides.renderCliGuide(''),
    guides.renderStaticGuide(''),
  ];
  return rendered.map((text) => renderedDocument({ source: GUIDE_SOURCE, sourceText, text }));
}

/** Docs pages, `core/AGENTS.md`, and the rendered starter guides. */
export async function defaultDocuments(root, docsDir) {
  const pages = docPages(docsDir).map((page) => ({
    source: toPosix(relative(root, page)),
    text: readFileSync(page, 'utf8'),
    page: true,
  }));
  const agents = {
    source: 'core/AGENTS.md',
    text: readFileSync(join(root, 'core', 'AGENTS.md'), 'utf8'),
  };
  return [...pages, agents, ...(await guideDocuments(root))];
}

/**
 * Extracts every document. Identical fences and references from several
 * renderings of one source (the guide sections presets share) are kept once.
 */
export function extractAll(documents) {
  const fences = [];
  const markers = [];
  const problems = [];
  const seen = new Set();
  for (const document of documents) {
    const mapLine = document.mapLine ?? ((line) => line);
    const extracted = extractDocument(document.text, { source: document.source });
    for (const fence of extracted.fences) {
      const key = `${fenceKey(fence)}\n${fence.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fences.push({
        ...fence,
        page: document.page === true,
        mapLine,
        syntax: fenceSyntax(fence.body, fence.extension),
      });
    }
    for (const marker of extracted.markers) {
      const key = `${marker.source}#${marker.anchor} ${marker.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({ ...marker, line: mapLine(marker.line) });
    }
    for (const problem of extracted.problems) {
      const key = `${problem.source}#${problem.anchor} ${problem.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ ...problem, line: mapLine(problem.line) });
    }
  }
  return { fences, markers, problems };
}

/** Parses a JSON file that may carry comments (a tsconfig). */
function readJsonc(file) {
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(text);
}

/**
 * The compiler options samples compile under: the starter's, made to check
 * only, to treat every fence as a module (so a top-level declaration stays in
 * its fence), and to check `js` fences too.
 */
export function sampleCompilerOptions(starterOptions) {
  const options = { ...starterOptions };
  for (const key of ['outDir', 'sourceMap', 'declaration', 'declarationMap', 'composite']) {
    delete options[key];
  }
  return {
    ...options,
    rootDir: '.',
    noEmit: true,
    moduleDetection: 'force',
    allowJs: true,
    checkJs: true,
  };
}

/** One `tsc --pretty false` diagnostic per entry: `{ file, line, column, code, message }`. */
export function parseDiagnostics(output) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    const located = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (located !== null) {
      const [, file, row, column, code, message] = located;
      diagnostics.push({
        file: toPosix(file),
        line: Number(row),
        column: Number(column),
        code,
        message,
      });
      continue;
    }
    const global = /^error TS(\d+): (.*)$/.exec(line);
    if (global !== null) {
      diagnostics.push({
        file: undefined,
        line: 0,
        column: 0,
        code: global[1],
        message: global[2],
      });
      continue;
    }
    const last = diagnostics.at(-1);
    if (last !== undefined && /^\s+\S/.test(line)) last.message += `\n${line.trimEnd()}`;
  }
  return diagnostics;
}

/** The `tsc` entry of the TypeScript compiler the repo builds with. */
function tscEntry(root) {
  const require = createRequire(join(root, 'package.json'));
  const manifestPath = require.resolve('@typescript/native/package.json');
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return join(manifestPath, '..', typeof bin === 'string' ? bin : bin.tsc);
}

/** Every published entry as an import specifier: `jsails`, `jsails/x`, `@jsails/y/z`. */
export function publishedEntries(dirs = workspaceDirs()) {
  const entries = [];
  for (const dir of dirs) {
    const manifest = readManifest(dir);
    if (manifest.private === true) continue;
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if (value === null || typeof value !== 'object' || !value.types || !value.default) continue;
      entries.push(key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`);
    }
  }
  return entries.sort();
}

/** The API report file of an entry specifier. */
export function apiReportFile(apiDir, specifier) {
  const parts = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength);
  const rest = parts.slice(nameLength);
  return join(apiDir, ...name, `${rest.length === 0 ? 'index' : rest.join('/')}.api.md`);
}

/** The `name -> tier` table of one API report, or `undefined` when it does not exist. */
export function readApiReport(file) {
  if (!existsSync(file)) return undefined;
  const names = new Map();
  let inTable = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('```')) {
      inTable = !inTable;
      continue;
    }
    if (!inTable) continue;
    const [name, , tier] = line.split(' | ');
    if (name !== undefined && tier !== undefined) names.set(name.trim(), tier.trim());
  }
  return names;
}

/** Findings for the marked code references. */
export function resolveMarkers(markers, apiDir) {
  const reports = new Map();
  const findings = [];
  for (const marker of markers) {
    if (!reports.has(marker.specifier)) {
      reports.set(marker.specifier, readApiReport(apiReportFile(apiDir, marker.specifier)));
    }
    const report = reports.get(marker.specifier);
    let problem;
    if (report === undefined) problem = `"${marker.specifier}" is not a published entry`;
    else if (!report.has(marker.name))
      problem = `"${marker.specifier}" does not export ${marker.name}`;
    else if (report.get(marker.name) === 'internal') problem = `${marker.name} is @internal`;
    if (problem === undefined) continue;
    findings.push({
      id: `${marker.source}#${marker.anchor} marker ${marker.token}: ${problem}`,
      where: `${marker.source}:${marker.line}:${marker.column}`,
      message: `marked reference \`${marker.token}\`: ${problem}`,
    });
  }
  return findings;
}

/**
 * Diagnostics that differ from another only by a spelling suggestion, mapped to
 * that other one: `[suggesting code, plain code, rewrite of the message]`.
 * Whether TypeScript suggests (and so which code it reports) depends on every
 * name in scope, not on the sample.
 */
const SUGGESTING_DIAGNOSTICS = Object.freeze([
  ['2552', '2304', (message) => message],
  ['2551', '2339', (message) => message],
  ['2833', '2503', (message) => message],
  [
    '2724',
    '2305',
    (message) =>
      message.replace(/^('.*') has no exported member named /, 'Module $1 has no exported member '),
  ],
  ['2614', '2305', (message) => message],
  [
    '2561',
    '2353',
    (message) =>
      message.replace(
        /^Object literal may only specify known properties, but /,
        'Object literal may only specify known properties, and ',
      ),
  ],
]);

/** A trailing `Did you mean …?` clause, the part of a message that is a suggestion. */
const SUGGESTION = /\s+Did you mean\b.*\?$/;

/**
 * A diagnostic's code and message as a ledger id carries them: the first line,
 * without a spelling suggestion and under the code TypeScript reports when it
 * has none, with the temporary project and the checkout replaced by
 * placeholders, so an id is the same on every machine and whatever else is in
 * scope.
 */
export function idDiagnostic({ code, message }, { projectDir, root }) {
  const first = (message.split('\n')[0] ?? '').replace(SUGGESTION, '');
  const suggesting = SUGGESTING_DIAGNOSTICS.find(([from]) => from === code);
  if (suggesting === undefined) return { code, message: idMessage(first, { projectDir, root }) };
  const [, plain, rewrite] = suggesting;
  return { code: plain, message: idMessage(rewrite(first), { projectDir, root }) };
}

/** A message line with machine-specific paths replaced by placeholders. */
function idMessage(line, { projectDir, root }) {
  let first = line;
  // tsc may print a path as given or resolved (macOS's /var is /private/var).
  // The longest path goes first, so a checkout inside the temporary directory
  // (or the reverse) is replaced by its own placeholder, not by its parent's.
  const paths = [
    [realpathSync(projectDir), '<project>'],
    [projectDir, '<project>'],
    [realpathSync(root), '<repo>'],
    [root, '<repo>'],
  ].sort(([a], [b]) => b.length - a.length);
  // The rest of a replaced path is written with `/`, so a recorded message is
  // the same whichever platform tsc ran on.
  for (const [path, placeholder] of paths) {
    for (const form of new Set([path, toPosix(path)])) {
      const tail = new RegExp(`${escapeRegExp(form)}((?:[\\\\/][^\\s'"\\\\/]+)*)`, 'g');
      first = first.replace(tail, (_match, rest) => placeholder + rest.replaceAll('\\', '/'));
    }
  }
  return first.replace(/\s+/g, ' ').trim();
}

/** Writes the temporary project; returns its directory and the file of each fence. */
function writeProject({ fences, modulesDir, fixturesFile, parent }) {
  const dir = mkdtempSync(join(parent ?? tmpdir(), 'jsails-docs-'));
  writeFileSync(join(dir, 'package.json'), '{ "private": true, "type": "module" }\n');
  symlinkSync(modulesDir, join(dir, 'node_modules'), 'junction');
  mkdirSync(join(dir, 'fences'));
  const files = new Map();
  fences.forEach((fence, index) => {
    const file = `fences/f${String(index + 1).padStart(4, '0')}${fence.extension}`;
    writeFileSync(join(dir, file), `${fence.body}\n`);
    files.set(file, fence);
  });
  const checked = [...files].filter(([, fence]) => !fence.flags.has('no-check'));
  const hasFixtures = existsSync(fixturesFile);
  if (!hasFixtures && checked.some(([, fence]) => fence.flags.has('fragment'))) {
    throw new Error(`fragment fences need ${fixturesFile}`);
  }
  const supportOf = (fence) =>
    fence.flags.has('fragment') ? [...META_DECLARATIONS, FIXTURES_MODULE] : META_DECLARATIONS;
  const isolated = checked.filter(([, fence]) => fence.syntax.shared.length > 0);
  const shared = checked.filter(([, fence]) => fence.syntax.shared.length === 0);
  const programs = [];
  const wholeModules = shared.filter(([, fence]) => !fence.flags.has('fragment'));
  if (wholeModules.length > 0) {
    programs.push({
      name: 'modules',
      support: META_DECLARATIONS,
      files: wholeModules.map(([file]) => file),
    });
  }
  // The fixtures compile on every run, with or without fragments, so a stub
  // that drifts from the framework fails before a sample relies on it.
  if (hasFixtures) {
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, FIXTURES_MODULE), readFileSync(fixturesFile));
    programs.push({
      name: 'fragments',
      support: [...META_DECLARATIONS, FIXTURES_MODULE],
      files: shared.filter(([, fence]) => fence.flags.has('fragment')).map(([file]) => file),
    });
  }
  for (const [file, fence] of isolated) {
    programs.push({
      name: file.slice('fences/'.length).replace(/\.\w+$/, ''),
      support: supportOf(fence),
      files: [file],
    });
  }
  return { dir, files, programs };
}

/**
 * Compiles one program and returns its diagnostics. `tsc` reports only the
 * syntax errors of a program that has any, so every fence with a syntax error
 * is dropped and the rest compiled again until a pass reports none or only
 * semantic ones; the fences of one program cannot see each other's
 * declarations, so dropping one cannot change another's diagnostics. A syntax
 * error that is in no fence still in the program (a support file's) ends the
 * loop: dropping nothing would repeat the pass forever, and the caller reports
 * it as a project error. Repeats across passes are kept once.
 *
 * A `tsc` ended by a signal (the gate itself being terminated) aborts the gate
 * instead of being read as a compile result.
 */
async function compileProgram({ tsc, dir, options, program, errors }) {
  const seen = new Set();
  const diagnostics = [];
  let files = program.files;
  for (let pass = 1; ; pass += 1) {
    const config = `tsconfig.${program.name}.${pass}.json`;
    writeFileSync(
      join(dir, config),
      `${JSON.stringify({ compilerOptions: options, files: [...program.support, ...files] }, null, 2)}\n`,
    );
    const outcome = await run(process.execPath, [tsc, '-p', config, '--pretty', 'false'], {
      cwd: dir,
      capture: true,
    });
    if (outcome.signal !== null) throw new Error(`tsc was terminated by ${outcome.signal}`);
    const found = parseDiagnostics(outcome.stdout);
    if (exitStatus(outcome) !== 0 && found.length === 0) {
      errors.push(`tsc failed without diagnostics:\n${outcome.output}`);
      return diagnostics;
    }
    for (const diagnostic of found) {
      const key = JSON.stringify(diagnostic);
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(diagnostic);
    }
    const failed = new Set(
      found
        .filter((diagnostic) => SYNTAX_CODE.test(diagnostic.code))
        .map((diagnostic) => diagnostic.file),
    );
    const next = files.filter((file) => !failed.has(file));
    if (next.length === files.length) break;
    files = next;
  }
  return diagnostics;
}

/**
 * The environment of a `run` fence's `node --test`: without the parent test
 * runner's context, which would make the child report to an outer runner
 * instead of exiting with its own status when the gate itself runs under test.
 */
function runEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Stub `.jsails/` declarations, for a project that skips `build:meta`. */
function writeStubMeta(dir, text) {
  mkdirSync(join(dir, '.jsails'), { recursive: true });
  for (const file of META_DECLARATIONS) writeFileSync(join(dir, file), text);
}

/**
 * Runs the gate's checks and returns `{ findings, errors, stats }`. A finding
 * (`{ id, where, message }`) is ratcheted against the ledger; an error always
 * fails.
 *
 * Options exist for tests: `documents` replaces the docs, AGENTS.md, and guide
 * sources; `modulesDir` is the `node_modules` the project resolves packages
 * from; `generateMeta: false` skips `jsails build:meta` and gives every
 * `.jsails/` declaration the text `metaStub`; `entries` replaces the published
 * entries the coverage check requires.
 */
export async function checkDocs({
  repoRoot = defaultRepoRoot,
  docsDir = join(repoRoot, 'website', 'content', 'docs'),
  documents,
  modulesDir = join(repoRoot, 'node_modules'),
  apiDir = join(repoRoot, 'api'),
  fixturesFile = join(docsDir, '_fixtures.d.ts'),
  generateMeta = true,
  metaStub = 'export {};\n',
  entries,
  exemptions = UNDOCUMENTED_SUBPATHS,
  tempDir,
} = {}) {
  const sources = documents ?? (await defaultDocuments(repoRoot, docsDir));
  const { fences, markers, problems } = extractAll(sources);
  const errors = problems.map((problem) => `${problem.source}:${problem.line}: ${problem.message}`);
  const findings = [];

  const noCheck = fences.filter((fence) => fence.flags.has('no-check'));
  if (noCheck.length > NO_CHECK_BUDGET) {
    errors.push(
      `${noCheck.length} no-check fences exceed the budget of ${NO_CHECK_BUDGET}: ` +
        noCheck.map((fence) => `${fence.source}:${fence.mapLine(fence.line)}`).join(', '),
    );
  }

  const starterOptions = readJsonc(join(repoRoot, STARTER_TSCONFIG)).compilerOptions;
  const project = writeProject({ fences, modulesDir, fixturesFile, parent: tempDir });
  const clean = new Set(fences.filter((fence) => !fence.flags.has('no-check')));
  try {
    if (generateMeta) {
      const cli = join(repoRoot, 'core', 'dist', 'src', 'cli', 'index.js');
      if (!existsSync(cli)) throw new Error('core/dist is missing; run a build first');
      const meta = await run(process.execPath, [cli, 'build:meta', '--dir', project.dir], {
        cwd: project.dir,
        capture: true,
      });
      if (exitStatus(meta) !== 0) throw new Error(`jsails build:meta failed:\n${meta.output}`);
    } else {
      writeStubMeta(project.dir, metaStub);
    }

    const options = sampleCompilerOptions(starterOptions);
    const tsc = tscEntry(repoRoot);
    const diagnostics = (
      await Promise.all(
        project.programs.map((program) =>
          compileProgram({ tsc, dir: project.dir, options, program, errors }),
        ),
      )
    ).flat();
    const counts = new Map();
    for (const diagnostic of diagnostics) {
      const fence = diagnostic.file === undefined ? undefined : project.files.get(diagnostic.file);
      if (fence === undefined) {
        errors.push(
          `the sample project does not compile outside the samples: ` +
            `${diagnostic.file ?? '(global)'}(${diagnostic.line},${diagnostic.column}): ` +
            `TS${diagnostic.code}: ${diagnostic.message}`,
        );
        continue;
      }
      clean.delete(fence);
      const keyed = idDiagnostic(diagnostic, { projectDir: project.dir, root: repoRoot });
      const base = `${fenceKey(fence)} TS${keyed.code}: ${keyed.message}`;
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      findings.push({
        id: count === 1 ? base : `${base} (${count})`,
        where: `${fence.source}:${fence.mapLine(fence.line + diagnostic.line)}:${diagnostic.column}`,
        message: `TS${diagnostic.code}: ${diagnostic.message}`,
      });
    }

    for (const [file, fence] of project.files) {
      if (!fence.flags.has('run')) continue;
      const where = `${fence.source}:${fence.mapLine(fence.line)}`;
      if (!fence.syntax.asserts) {
        clean.delete(fence);
        findings.push({
          id: `${fenceKey(fence)} run: no assertion`,
          where,
          message: 'a run fence must assert (import node:assert, or use t.assert)',
        });
        continue;
      }
      const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
      const outcome = await run(process.execPath, ['--test', '--test-reporter=spec', file], {
        cwd: project.dir,
        env: runEnvironment(),
        capture: true,
        signal: timeout,
      });
      if (outcome.signal !== null && !timeout.aborted) {
        throw new Error(`node --test was terminated by ${outcome.signal}`);
      }
      if (exitStatus(outcome) !== 0) {
        clean.delete(fence);
        findings.push({
          id: `${fenceKey(fence)} run: fails under node --test`,
          where,
          message: `fails under node --test:\n${outcome.output.trim().split('\n').slice(-20).join('\n')}`,
        });
      }
    }
  } finally {
    rmSync(project.dir, { recursive: true, force: true });
  }

  findings.push(...resolveMarkers(markers, apiDir));

  const published = entries ?? publishedEntries();
  const covered = new Set();
  for (const fence of clean) {
    if (!fence.page) continue;
    for (const specifier of fence.syntax.imports) covered.add(specifier);
  }
  for (const entry of published) {
    if (exemptions.has(entry) || covered.has(entry)) continue;
    findings.push({
      id: `entry ${entry}: no compiled docs sample imports it`,
      where: entry,
      message: 'no docs-page fence that compiles cleanly imports this entry',
    });
  }
  for (const entry of exemptions.keys()) {
    if (!published.includes(entry)) {
      errors.push(`UNDOCUMENTED_SUBPATHS lists "${entry}", which is not a published entry`);
    }
  }

  findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    findings,
    errors,
    stats: {
      fences: fences.length,
      checked: fences.length - noCheck.length,
      fragments: fences.filter((fence) => fence.flags.has('fragment')).length,
      runs: fences.filter((fence) => fence.flags.has('run')).length,
      noCheck: noCheck.length,
      markers: markers.length,
      entries: published.length,
    },
  };
}

/**
 * The gate's failures: every error, every finding the ledger does not list,
 * and every listed id that no longer occurs.
 */
export function judge({ findings, errors }, ledger) {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const { unlisted, fixed } = ratchet(
    ledger,
    findings.map((finding) => finding.id),
  );
  return [
    ...errors,
    ...unlisted.map((id) => {
      const { where, message } = byId.get(id);
      return `${where}: ${message}\n    ledger id: ${id}`;
    }),
    ...fixed.map((id) => `fixed: "${id}" no longer occurs; remove it from ${GATE}.json`),
  ];
}

/** The reason `--record` gives a new id, by what kind of finding it is. */
const DEFAULT_REASONS = Object.freeze([
  [/ TS1\d{3}: /, 'The sample is not valid TypeScript on its own: an elided or partial snippet.'],
  [
    / TS(?:2304|2552|18004|2593): /,
    'The sample uses a name it neither imports nor declares: it assumes an app around it (fragment) or a global that does not exist.',
  ],
  [/ TS(?:2307|2834|2835): /, 'The sample imports a module that does not exist outside an app.'],
  [/ TS(?:2305|2724|2614|2694): /, 'The sample imports a name the package does not export.'],
  [/ TS7\d{3}: /, "The sample has an implicit any under the starter's strict compiler options."],
  [/ TS2554: /, 'The sample calls a function with the wrong number of arguments.'],
  [/ TS(?:2353|2561): /, 'The sample passes an option the shipped type does not have.'],
  [/ TS\d+: /, 'The sample does not match the shipped types.'],
  [/ run: /, 'The run sample fails or does not assert.'],
  [/ marker /, 'The marked reference does not resolve against the API report.'],
  [/^entry /, 'No docs sample that compiles imports this entry.'],
]);

/**
 * Today's findings as the ledger: reasons of ids still present are kept, new
 * ids get the default reason of their kind.
 */
export function recordLedger({ findings }, ledger) {
  const previous = new Map(ledger.entries.map((entry) => [entry.id, entry]));
  return {
    description:
      'Docs samples, marked references, and published entries that fail the docs compile gate ' +
      '(website/scripts/check-docs.mjs) today. Report-only (KRN-05): the gate tolerates these ids and ' +
      'fails on a new one or on a listed one that is gone. KRN-24 empties it and switches the gate to failing.',
    kind: 'gate',
    gate: GATE,
    entries: findings.map(({ id }) => {
      const kept = previous.get(id);
      if (kept !== undefined) return { id, reason: kept.reason, fixedBy: kept.fixedBy };
      const reason =
        DEFAULT_REASONS.find(([pattern]) => pattern.test(id))?.[1] ?? 'Docs gate finding.';
      return { id, reason, fixedBy: LEDGER_FIXED_BY };
    }),
  };
}

async function main(argv) {
  const verbose = argv.includes('--verbose');
  const record = argv.includes('--record');
  const result = await checkDocs();
  const ledger = readGateLedger(GATE);
  const { stats } = result;
  const summary =
    `check-docs: ${stats.fences} fences (${stats.checked} compiled, ${stats.fragments} fragment, ` +
    `${stats.runs} run, ${stats.noCheck}/${NO_CHECK_BUDGET} no-check), ${stats.markers} marked ` +
    `reference(s), ${stats.entries} published entries; ${result.findings.length} finding(s), ` +
    `${ledger.entries.length} listed in scripts/expected-failures/${GATE}.json.`;

  if (record) {
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`  - ${error}`);
      console.error('Fix these first; they cannot be recorded.');
      return 1;
    }
    const next = recordLedger(result, ledger);
    writeFileSync(join(LEDGER_DIR, `${GATE}.json`), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`${summary}\nRecorded ${next.entries.length} entries.`);
    return 0;
  }

  if (verbose) {
    const listed = new Set(ledger.entries.map((entry) => entry.id));
    for (const finding of result.findings) {
      if (listed.has(finding.id))
        console.log(`  listed: ${finding.where}: ${finding.message.split('\n')[0]}`);
    }
  }
  const failures = judge(result, ledger);
  console.log(summary);
  if (failures.length > 0) {
    console.error('\nThe docs gate failed:\n');
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      `\n${failures.length} failure(s). Fix the sample, or (for a fixed one) remove its ledger entry.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
