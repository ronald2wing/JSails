/**
 * Where a JavaScript syntax error is: the file, line and column Node reports
 * for it, read without the source-line excerpt that comes with them.
 *
 * Node prints a syntax error's location as a block ahead of the error's
 * header: `<file>:<line>`, the source line, a caret line under the offending
 * token, and (usually) a blank line. A CommonJS module or a `vm.Script` puts
 * that block at the start of the error's `stack`, and so does an ES module
 * whose import names an export its dependency lacks (a link error). An ES
 * module that does not parse does not: on Node 26 its location lives only in
 * a V8-private "arrow message" that the uncaught-exception printer reads, so
 * the error's `stack` names Node's own loader frames, its `message` names the
 * token, and nothing on the object says which file or line failed (it may not
 * even be the imported file, but one that file imports). `node --check
 * <file>` parses the file the same way and prints the same block.
 *
 * - {@link decoratedSyntaxLocation}: the location in such a block, accepted
 *   only when the block is exactly that shape and is followed by the header of
 *   the error in hand, so it is that error's location.
 * - {@link explainModuleImportFailure}: for a `SyntaxError` from importing a
 *   module file, finds the file that does not parse (the imported file, or
 *   one it imports), runs `node --check` on it, and when that reports the
 *   same error, wraps the error in a value-free `module_syntax.*` error that
 *   names the place. The search runs only on that failure path.
 *
 * Finding the file in the import graph needs a parser that reports a
 * module's static imports without running it: a child process parses each
 * relative import with `vm.SourceTextModule` (flagged, so it gets
 * `--experimental-vm-modules`), never links or evaluates one, and names the
 * first file whose parse fails with the same message. A `SyntaxError` the
 * module's code threw while running (`JSON.parse`) names no such file, and
 * comes back unchanged.
 *
 * Server-only (Node `child_process` and `path`).
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { OUTSIDE_PATH_SLOT, realPathSlot, sameRealPath } from './project-paths.server.js';

const MODULE_SYNTAX_ERRORS = {
  syntax_error: {
    kind: 'internal',
    message: 'syntax error at {path}:{line}:{column}',
    context: { path: 'relative-path', line: 'count', column: 'count' },
  },
  syntax_error_at_line: {
    kind: 'internal',
    message: 'syntax error at {path}:{line}',
    context: { path: 'relative-path', line: 'count' },
  },
} as const;

/**
 * The syntax-location codes, `module_syntax.*`: where a module that failed to
 * parse failed, as a path relative to the working directory, a line and (when
 * it can be read reliably) a column. The parser's own message names the
 * offending token, which can be a value from the source, so it stays on the
 * `cause`.
 */
export const ModuleSyntaxErrors: ErrorRegistry<'module_syntax', typeof MODULE_SYNTAX_ERRORS> =
  defineErrors('module_syntax', MODULE_SYNTAX_ERRORS);

/** A syntax error's place in a file. */
export interface SyntaxLocation {
  /** The absolute path of the file. */
  readonly file: string;
  /** The 1-based line. */
  readonly line: number;
  /** The 1-based column, or `undefined` when the caret line cannot be read reliably. */
  readonly column: number | undefined;
}

const LOCATION_LINE = /^(.+):([1-9][0-9]{0,8})$/;
const CARET_LINE = /^([ \t]*)\^+$/;
const ASCII = /^[\x20-\x7e\t]*$/;

/**
 * The absolute path a location names, as an absolute path or a `file:` URL
 * (V8 writes ES module locations as URLs), or `undefined` for anything else.
 */
export function locationFile(text: string): string | undefined {
  if (text.startsWith('file:')) {
    if (!URL.canParse(text)) return undefined;
    const url = new URL(text);
    return url.protocol === 'file:' && url.host === '' ? fileURLToPath(url) : undefined;
  }
  return path.isAbsolute(text) ? text : undefined;
}

/**
 * The column a caret line points at. Node writes the caret line by copying
 * each tab of the source line before the token and turning every other
 * character into a space, counting in bytes; the column is read only when
 * that prefix is plain ASCII and the tabs line up, where bytes, characters and
 * V8's columns agree.
 */
function caretColumn(source: string, caret: string): number | undefined {
  const match = CARET_LINE.exec(caret);
  if (match === null) return undefined;
  const prefix = match[1] as string;
  const sourcePrefix = source.slice(0, prefix.length);
  if (sourcePrefix.length !== prefix.length || !ASCII.test(sourcePrefix)) return undefined;
  for (let index = 0; index < prefix.length; index += 1) {
    if ((sourcePrefix[index] === '\t') !== (prefix[index] === '\t')) return undefined;
  }
  return prefix.length + 1;
}

/**
 * The location in a Node-decorated syntax error text (the `stack` of a
 * CommonJS SyntaxError or an ES module link error, or `node --check` output):
 * `<file>:<line>`, the source line, a caret line, a blank line or none, and
 * then exactly `header` (the error's `Name: message`) on its own line or
 * lines. Anything else, a warning printed ahead of the block included, gives
 * `undefined`.
 */
export function decoratedSyntaxLocation(text: string, header: string): SyntaxLocation | undefined {
  // A child's stderr read on Windows can end its lines with CRLF, which would
  // keep every line from matching; the block itself never holds a bare CR.
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const [first, source, caret] = lines;
  if (first === undefined || source === undefined || caret === undefined) return undefined;
  // A CommonJS error and `node --check` put a blank line before the header;
  // an ES module link error ("does not provide an export named") does not.
  const rest = lines.slice(lines[3] === '' ? 4 : 3).join('\n');
  if (rest !== header && !rest.startsWith(`${header}\n`)) return undefined;
  const match = LOCATION_LINE.exec(first);
  if (match === null) return undefined;
  const file = locationFile(match[1] as string);
  if (file === undefined) return undefined;
  return { file, line: Number(match[2]), column: caretColumn(source, caret) };
}

/** The most modules the graph search parses before it gives up. */
const MAX_GRAPH_MODULES = 256;

/**
 * The child that finds the module that does not parse. It reads the entry
 * file and the directory imports may not leave from its arguments and the
 * expected message from its environment (a parser message can quote a token
 * of the source, and another user can read a process's arguments but not its
 * environment), parses breadth first through relative `.js`/`.mjs` imports
 * inside that directory, and prints the path of the first file whose parse
 * fails with that message.
 */
const GRAPH_SEARCH = String.raw`
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SourceTextModule } from 'node:vm';
const [entry, root] = process.argv.slice(1);
const expected = process.env.JSAILS_SYNTAX_MESSAGE;
const inside = (file) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const queue = [entry];
const seen = new Set(queue);
while (queue.length > 0 && seen.size <= ${MAX_GRAPH_MODULES}) {
  const file = queue.shift();
  let source;
  try { source = readFileSync(file, 'utf8'); } catch { continue; }
  let parsed;
  try {
    parsed = new SourceTextModule(source, { identifier: pathToFileURL(file).href });
  } catch (error) {
    if (error instanceof SyntaxError && error.message === expected) {
      process.stdout.write(file);
      break;
    }
    continue;
  }
  for (const { specifier } of parsed.moduleRequests) {
    if (!/^(?:\.{1,2}\/|\/|file:)/.test(specifier)) continue;
    let url;
    try { url = new URL(specifier, pathToFileURL(file)); } catch { continue; }
    if (url.protocol !== 'file:') continue;
    const target = fileURLToPath(url);
    if (!/\.m?js$/.test(target) || !inside(target) || seen.has(target)) continue;
    seen.add(target);
    queue.push(target);
  }
}
`;

/** The environment of a child that only parses: no `--import`/`--require` preload runs. */
function parseOnlyEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  // NODE_OPTIONS is dropped so the child loads no preload of the operator's:
  // it only parses, and a preload would run code.
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * The file under `root` that `entry` imports (or `entry` itself) whose parse
 * fails with `message`, or `undefined` when the search finds none.
 */
function findUnparsableModule(
  entry: string,
  message: string,
  root: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--no-warnings',
        '--input-type=module',
        '-e',
        GRAPH_SEARCH,
        '--',
        entry,
        root,
      ],
      {
        env: parseOnlyEnvironment({ JSAILS_SYNTAX_MESSAGE: message }),
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      // A search that could not run, or found nothing, prints nothing.
      (_error, stdout) => resolve(stdout === '' ? undefined : stdout),
    );
  });
}

/** What `node --check` wrote to stderr; empty when it could not run. */
function checkSyntax(file: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--check', file],
      {
        env: parseOnlyEnvironment(),
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      // The check exits non-zero exactly when it found the error, so the exit
      // status is not a failure here; a check that could not run at all
      // leaves stderr empty, which locates nothing.
      (_error, _stdout, stderr) => resolve(stderr),
    );
  });
}

/** Where `node --check` puts the syntax error `header` in `file`, if it is there. */
async function checkedLocation(file: string, header: string): Promise<SyntaxLocation | undefined> {
  const location = decoratedSyntaxLocation(await checkSyntax(file), header);
  return location !== undefined && sameRealPath(location.file, file) ? location : undefined;
}

/**
 * The error to report for `error`, thrown while importing the module file at
 * `filePath`. A `SyntaxError` whose location `node --check` reports, with the
 * same message, for that file or for a file it imports (found by the graph
 * search the module documentation describes) is wrapped in a
 * `module_syntax.*` error naming the file, line and column, the `SyntaxError`
 * kept as its `cause`. Any other error, a syntax error no search locates, and
 * a file outside `cwd` (default: the working directory) come back unchanged.
 */
export async function explainModuleImportFailure(
  filePath: string,
  error: unknown,
  cwd: string = process.cwd(),
): Promise<unknown> {
  if (!(error instanceof SyntaxError)) return error;
  const absolute = path.resolve(cwd, filePath);
  if (realPathSlot(absolute, cwd) === OUTSIDE_PATH_SLOT) return error;
  const header = `${error.name}: ${error.message}`;
  let location = await checkedLocation(absolute, header);
  if (location === undefined && /\.m?js$/.test(absolute)) {
    const found = await findUnparsableModule(absolute, error.message, cwd);
    if (found !== undefined && path.isAbsolute(found) && !sameRealPath(found, absolute)) {
      location = await checkedLocation(found, header);
    }
  }
  if (location === undefined) return error;
  const slot = realPathSlot(location.file, cwd);
  if (slot === OUTSIDE_PATH_SLOT) return error;
  return location.column === undefined
    ? new ModuleSyntaxErrors.Error(
        'syntax_error_at_line',
        { path: slot, line: location.line },
        { cause: error },
      )
    : new ModuleSyntaxErrors.Error(
        'syntax_error',
        { path: slot, line: location.line, column: location.column },
        { cause: error },
      );
}
