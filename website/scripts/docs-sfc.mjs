/**
 * The `.jsails` half of the docs compile gate (`check-docs.mjs`): every
 * ` ```jsails ` fence is lowered at the project path its `path=` names (a
 * view at `ui/sample-<n>.jsails` without one), compiled to JavaScript, and
 * type-checked through its sidecars with `tsc`, whose output is remapped to
 * the fence's own lines and columns, as `jsails sync` and `jsails typecheck`
 * do in an app.
 *
 * The jsails fences of one document form one app: each document's fences are
 * a directory of the gate's temporary project that stands as an app root, so
 * `pages/index.jsails` imports `../islands/counter.jsails` from another fence
 * on the same page, and a path may be named once per document. Names a
 * component leaves free resolve through no catalog (the project catalog does
 * not exist yet), so a sample imports what it uses, which stays correct under
 * any resolver.
 *
 * The compiler is the build's (`core/dist/src/compiler/sfc/`); everything
 * here is the shipped lowering, sidecar and remap code, not a copy. Code the
 * compiler cannot account for is a compiler bug and always fails the gate:
 * its own `sfc.internal` diagnostic (it generated code its transformer
 * refuses, or produced no source map) and a `tsc` diagnostic at a position it
 * cannot map to the author's text (`internal`). Everything else is a finding
 * of the fence it lands in, which the ledger may list.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { exitStatus, run } from '../../scripts/subprocess.mjs';
import { fenceSyntax } from './docs-syntax.mjs';

/**
 * Where the built compiler lives, from the checkout root. SFC-10 moves the
 * compiler into `packages/dev`; this is the one place that names it.
 */
export const SFC_COMPILER = Object.freeze(['core', 'dist', 'src', 'compiler', 'sfc']);

/**
 * The compiler's diagnostic for its own bug (`core/src/compiler/sfc/compile.ts`):
 * nothing in a sample can cause it, so no ledger may excuse it.
 */
const SFC_INTERNAL = 'sfc.internal';

/** The view path of the `n`th fence of a document that names no path. */
export function samplePath(n) {
  return `ui/sample-${n}.jsails`;
}

/** TypeScript's syntax diagnostics are numbered 1000-1999. */
function isSyntaxCode(code) {
  return code >= 1000 && code <= 1999;
}

function toPosix(path) {
  return sep === '\\' ? path.replaceAll('\\', '/') : path;
}

/** The compiler functions the gate calls, loaded from the build under `root`. */
export async function loadSfcCompiler(root) {
  const load = async (name) => {
    const file = join(root, ...SFC_COMPILER, `${name}.js`);
    if (!existsSync(file)) {
      throw new Error(`${toPosix(relative(root, file))} is missing; run a build first`);
    }
    return import(pathToFileURL(file).href);
  };
  const [lower, compile, shadow, remap, blocks, names, lines] = await Promise.all(
    ['lower', 'compile', 'shadow', 'remap', 'blocks', 'name-resolver', 'line-index'].map(load),
  );
  return Object.freeze({
    lowerSfc: lower.lowerSfc,
    compileSfc: compile.compileSfc,
    writeSidecars: shadow.writeSidecars,
    shadowPath: shadow.shadowPath,
    sidecarDirectory: shadow.SIDECAR_DIRECTORY,
    remapTscOutput: remap.remapTscOutput,
    parseSfcBlocks: blocks.parseSfcBlocks,
    resolver: names.EMPTY_RESOLVER,
    lineIndex: lines.lineIndex,
  });
}

/**
 * Gives each `jsails` fence of `fences` its project path: its `path=`, or the
 * next sample view path of its document. A fence whose path an earlier fence
 * of the same document already names is left out and reported as a problem
 * (`{ source, line, anchor, message }`, the line already mapped): the
 * document's other fences could import only one of the two. Fences of other
 * languages pass through unchanged, in order.
 */
export function assignComponentPaths(fences) {
  const documents = new Map();
  const kept = [];
  const problems = [];
  for (const fence of fences) {
    if (fence.language !== 'jsails') {
      kept.push(fence);
      continue;
    }
    let document = documents.get(fence.source);
    if (document === undefined) {
      document = { paths: new Map(), pathless: 0 };
      documents.set(fence.source, document);
    }
    let path = fence.path;
    if (path === undefined) {
      document.pathless += 1;
      path = samplePath(document.pathless);
    }
    const earlier = document.paths.get(path);
    const line = fence.mapLine(fence.line);
    if (earlier !== undefined) {
      problems.push({
        source: fence.source,
        line,
        anchor: `${fence.anchor}[${fence.ordinal}]`,
        message: `this jsails fence and the one at line ${earlier.mapLine(earlier.line)} both stand for ${path}`,
      });
      continue;
    }
    const placed = { ...fence, path };
    document.paths.set(path, placed);
    kept.push(placed);
  }
  return { fences: kept, problems };
}

/**
 * The syntax facts of a `jsails` fence, in the shape `fenceSyntax` gives a
 * TypeScript one: the specifiers its `<script>` and `<script setup>` import
 * (never the imports the compiler generates), no shared declarations (each
 * component is a module of its own app), and no assertion.
 */
export function jsailsSyntax(fence, compiler) {
  const parsed = compiler.parseSfcBlocks(`${fence.body}\n`, fence.path);
  const imports = new Set();
  for (const block of [parsed.script, parsed.scriptSetup]) {
    if (block === null) continue;
    for (const specifier of fenceSyntax(block.content, '.ts').imports) imports.add(specifier);
  }
  return { imports, shared: [], asserts: false };
}

/**
 * The compiler options of a group: the samples' options with the sidecar
 * layout an app that holds `.jsails` files has (`.jsails/sfc` beside the
 * project, and the arbitrary-extension bridges), without `rootDir`, because
 * a group reaches the project's `.jsails/` declarations in its parent
 * directory and nothing is emitted.
 */
export function sfcCompilerOptions(sampleOptions, sidecarDirectory) {
  const options = { ...sampleOptions };
  delete options.rootDir;
  return { ...options, rootDirs: ['.', sidecarDirectory], allowArbitraryExtensions: true };
}

/**
 * The checked `jsails` fences of `fences` grouped by document, in the order
 * their documents first appear.
 */
export function sfcGroups(fences) {
  const groups = new Map();
  for (const fence of fences) {
    if (fence.language !== 'jsails' || fence.flags.has('no-check')) continue;
    const group = groups.get(fence.source) ?? [];
    group.push(fence);
    groups.set(fence.source, group);
  }
  return [...groups.values()];
}

/**
 * Lowers, compiles and type-checks one group in `dir`, an app root inside
 * the temporary project `projectDir`. Returns `{ located, errors }`: a
 * located diagnostic is `{ fence, origin, code, message, severity, line,
 * column, generatedFor? }` with `line` and `column` 1-based in the fence's
 * body, `origin` `'sfc'` for the compiler's own (`code` is its `sfc.*`
 * code) and `'tsc'` for TypeScript's (`code` its number); an error is a
 * message that no ledger can excuse: a fence that cannot be lowered, the
 * compiler's `sfc.internal`, a `tsc` diagnostic the compiler cannot map, and
 * one outside the fences.
 *
 * `tsc` reports only the syntax errors of a program that has any, so a
 * shadow with one is dropped and the group compiled again until a pass has
 * none; the same diagnostic from two passes is kept once.
 */
export async function checkSfcGroup({
  compiler,
  fences,
  dir,
  options,
  support,
  tsc,
  projectError,
}) {
  mkdirSync(dir, { recursive: true });
  const located = [];
  const errors = [];
  const byPath = new Map(fences.map((fence) => [fence.path, fence]));
  const lowerings = [];
  for (const fence of fences) {
    const body = `${fence.body}\n`;
    let lowering;
    try {
      lowering = compiler.lowerSfc(body, fence.path, { resolver: compiler.resolver });
    } catch (error) {
      const code = error?.code ?? 'an exception';
      errors.push(
        `${fence.source}:${fence.mapLine(fence.line)}: path=${fence.path} cannot be lowered (${code})`,
      );
      continue;
    }
    lowerings.push(lowering);
    const lines = compiler.lineIndex(body);
    for (const diagnostic of compiler.compileSfc(lowering).diagnostics) {
      if (diagnostic.code === SFC_INTERNAL) {
        errors.push(
          `${fence.source}:${fence.mapLine(fence.line)}: the compiler failed on ` +
            `path=${fence.path} (a compiler bug): ${diagnostic.code}: ${diagnostic.message}`,
        );
        continue;
      }
      const position = lines.positionAt(diagnostic.start);
      located.push({
        fence,
        origin: 'sfc',
        code: diagnostic.code,
        message: diagnostic.message,
        severity: diagnostic.severity,
        line: position.line + 1,
        column: position.column + 1,
      });
    }
  }
  compiler.writeSidecars(dir, lowerings);

  const seen = new Set();
  let files = lowerings
    .filter((lowering) => lowering.shadow !== null)
    .map((lowering) => lowering.file);
  for (let pass = 1; files.length > 0; pass += 1) {
    const config = `tsconfig.${pass}.json`;
    writeFileSync(
      join(dir, config),
      `${JSON.stringify(
        { compilerOptions: options, files: [...support, ...files.map(compiler.shadowPath)] },
        null,
        2,
      )}\n`,
    );
    const outcome = await run(process.execPath, [tsc, '-p', config, '--pretty', 'false'], {
      cwd: dir,
      capture: true,
    });
    if (outcome.signal !== null) throw new Error(`tsc was terminated by ${outcome.signal}`);
    const remapped = compiler.remapTscOutput(outcome.stdout, {
      root: dir,
      cwd: dir,
      sources: lowerings,
    });
    if (exitStatus(outcome) !== 0 && remapped.length === 0) {
      errors.push(`tsc failed without diagnostics:\n${outcome.output}`);
      break;
    }
    const failed = new Set();
    for (const entry of remapped) {
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      const fence = entry.file === null ? undefined : byPath.get(entry.file);
      if (fence !== undefined && isSyntaxCode(entry.code)) failed.add(fence.path);
      const tsMessage = `TS${entry.code}: ${entry.message}`;
      if (fence === undefined || entry.origin === 'file') {
        errors.push(projectError(entry.file ?? '(global)', entry.position, tsMessage));
      } else if (entry.origin === 'internal' || entry.position === null) {
        errors.push(
          `${fence.source}:${fence.mapLine(fence.line)}: the compiler generated code for ` +
            `path=${fence.path} that does not check (a compiler bug): ${tsMessage}`,
        );
      } else {
        located.push({
          fence,
          origin: 'tsc',
          code: entry.code,
          message: entry.message,
          severity: entry.category,
          line: entry.position.line,
          column: entry.position.column,
          ...(entry.generatedFor === undefined ? {} : { generatedFor: entry.generatedFor }),
        });
      }
    }
    const next = files.filter((file) => !failed.has(file));
    if (next.length === files.length) break;
    files = next;
  }
  return { located, errors };
}
