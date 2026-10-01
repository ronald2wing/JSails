/**
 * The cause chain of a command-line failure: the lines under the top message
 * that say why it happened, one `caused by:` line per link, and the whole
 * report (top line and chain) for a bin that prints it in one piece.
 *
 * A wrapper error (`failed to load config <path>`) is value-free and keeps
 * the underlying failure on `cause`: a SyntaxError in the user's module, an
 * errno error, a nested registry error, or whatever the user's code threw. The
 * renderer walks `cause` and an AggregateError's `errors`, bounded in depth
 * and breadth and safe against cycles, and prints each link value-free:
 *
 * - a registry error prints its message and hint, rendered again from its
 *   code's definition and checked context (`registryErrorText`), never read
 *   off the object, whose `message` any code may have appended to;
 * - a hand-written framework error that is no registry's prints its class
 *   name and code, because its message is free text;
 * - any other error prints only facts that cannot carry a value: its class
 *   name when that is a built-in name or reads `<Name>Error`, a Node errno or
 *   `ERR_*` code (or a database driver's error code), the failed system call,
 *   and where it was thrown as `path:line:column`, read from the stack only
 *   when the stack has exactly the shape V8 or Node writes and the file
 *   exists (the path relative to the working directory, a placeholder outside
 *   it);
 * - a thrown non-error value prints its type.
 *
 * Never the message, the stack or a source-line excerpt: a message is where a
 * user's `throw new Error('bad key ' + key)`, a driver's connection string or
 * a parser's offending token ends up. With `JSAILS_DEBUG=1` in the
 * environment each such link also prints its message and stack; without it,
 * a report that summarised anything ends with a line saying so. The CLI
 * passes the environment the process was started with: `JSAILS_DEBUG` is a
 * reserved key no project file may set (`environment/names.ts`), so a
 * committed `.env` cannot turn full detail on for every run.
 *
 * Every read of a thrown value is guarded and the walk as a whole is too:
 * explaining a failure never fails, and a value built to break the walk ends
 * it with a fixed line.
 *
 * Loaded only when a failure has something to explain (`cli/report.ts`), and
 * reached by first-party bins through `jsails/internal`.
 */

import { statSync } from 'node:fs';
import { getSystemErrorMap, inspect } from 'node:util';

import { isJsailsError } from './jsails-error.js';
import {
  failureHead,
  isRegistryError,
  registryErrorText,
  type FailureHeadOptions,
} from './registry.js';
import { OUTSIDE_PATH_SLOT, realPathSlot } from '../support/project-paths.server.js';
import { decoratedSyntaxLocation, locationFile } from '../support/syntax-location.server.js';

/** The environment variable that turns on full detail. */
export const DEBUG_ENV = 'JSAILS_DEBUG';

/** The last line of a report that summarised a link, without `JSAILS_DEBUG=1`. */
export const DEBUG_NOTE =
  '  (set JSAILS_DEBUG=1 to print the underlying error messages; they may contain values from your code or environment)';

/** Links followed from the top error along one path. */
const MAX_DEPTH = 8;
/** Links printed in all, so a wide tree of aggregates stays a few lines. */
const MAX_LINKS = 32;
/** An AggregateError's members printed before the rest are counted. */
const MAX_MEMBERS = 3;

const BUILTIN_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SuppressedError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
/** `<Name>Error`, at most 40 characters: room for a class name, little for a token. */
const ERROR_CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,34}Error$/;
/** Node's own error codes. */
const NODE_ERR_CODE = /^ERR_[A-Z][A-Z0-9_]{1,60}$/;
/** mysql2's server error names (`ER_ACCESS_DENIED_ERROR`): letters and underscores only. */
const MYSQL_CODE = /^ER_[A-Z_]{2,60}$/;
/** A PostgreSQL SQLSTATE (`28P01`): five characters, too short to hold a value. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A framework error's code: snake_case segments, dot-separated. */
const FRAMEWORK_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
/** A system call name (`connect`, `open`, `getaddrinfo`); `spawn <file>` has a space and fails. */
const SYSCALL = /^[a-z][a-z0-9_]{0,31}$/;
/**
 * The resolver codes `node:dns` reports, which are no system errno names.
 * Listed here rather than read from `node:dns`, which a report would
 * otherwise load for nothing.
 */
const DNS_CODES: readonly string[] = [
  'ENODATA',
  'EFORMERR',
  'ESERVFAIL',
  'ENOTFOUND',
  'ENOTIMP',
  'EREFUSED',
  'EBADQUERY',
  'EBADNAME',
  'EBADFAMILY',
  'EBADRESP',
  'ECONNREFUSED',
  'ETIMEOUT',
  'EOF',
  'EFILE',
  'ENOMEM',
  'EDESTRUCTION',
  'EBADSTR',
  'EBADFLAGS',
  'ENONAME',
  'EBADHINTS',
  'ENOTINITIALIZED',
  'ELOADIPHLPAPI',
  'EADDRGETNETWORKPARAMS',
  'ECANCELLED',
];
const FRAME_PREFIX = '    at ';
const FRAME_LOCATION = /^(.+):([1-9][0-9]{0,8}):([1-9][0-9]{0,8})$/;
/** Frame targets that name no file: Node's own modules, natives, eval, `Promise.all`. */
const NON_FILE_TARGET = /^(?:node:|native$|<anonymous>$|index \d+$|eval at |wasm:)/;

let errnoNames: ReadonlySet<string> | undefined;

/**
 * The errno names this platform's libuv knows, and the resolver's codes. An
 * `E…` code is printed only when it is one of them: the shape alone admits
 * any upper-case token a user's code puts in `code`.
 */
function knownErrnoNames(): ReadonlySet<string> {
  errnoNames ??= new Set([
    ...[...getSystemErrorMap().values()].map(([name]) => name),
    ...DNS_CODES,
  ]);
  return errnoNames;
}

/**
 * Options for {@link renderCauseChain}.
 *
 * @internal
 */
export interface CauseChainOptions {
  /** The environment `JSAILS_DEBUG` is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory paths are shown relative to. Defaults to the working directory. */
  readonly cwd?: string;
  /**
   * Whether the reporter printed the top error's own message (`shown`, the
   * default) or replaced it with a fixed line (`withheld`). A withheld top
   * error gets an `error:` line of its value-free facts, and its message with
   * `JSAILS_DEBUG=1`.
   */
  readonly head?: 'shown' | 'withheld';
}

/**
 * Options for {@link renderFailureReport}.
 *
 * @internal
 */
export interface FailureReportRenderOptions extends FailureHeadOptions {
  /** The program name the top line starts with (`jsails`, `jamal`). */
  readonly program: string;
  /** What the program was doing, printed ahead of the message. */
  readonly label?: string;
  /** The environment `JSAILS_DEBUG` is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory paths are shown relative to. Defaults to the working directory. */
  readonly cwd?: string;
}

/** True when `env` asks for the underlying messages. */
export function isDebugEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DEBUG_ENV] === '1';
}

interface Walk {
  readonly debug: boolean;
  /** `undefined` when the working directory is gone: every path is then outside it. */
  readonly cwd: string | undefined;
  readonly seen: WeakSet<object>;
  readonly lines: string[];
  links: number;
  summarised: boolean;
}

/** What one link prints. */
interface Link {
  /** The `caused by:` text. */
  readonly summary: string;
  /** The registry error's suggestion. */
  readonly hint: string | undefined;
  /** True when the link's message was left out: its detail is debug-only. */
  readonly foreign: boolean;
}

/** A property whose getter threw: distinct from one that is absent. */
const UNREADABLE: unique symbol = Symbol('unreadable');

/**
 * Read `key` of an arbitrary thrown value. A getter that throws (or a revoked
 * proxy) reads as {@link UNREADABLE}: explaining a failure must not fail.
 */
function readChecked(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/** {@link readChecked}, with an unreadable property read as absent. */
function read(value: object, key: string): unknown {
  const result = readChecked(value, key);
  return result === UNREADABLE ? undefined : result;
}

function isErrorObject(value: unknown): value is Error {
  if (typeof value !== 'object' || value === null) return false;
  try {
    // An error from another realm (a `vm` context) fails `instanceof` but
    // still carries the native error tag.
    return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
  } catch {
    // A revoked proxy throws on every operation; it is no error object.
    return false;
  }
}

/** The class name a link may print: a built-in name or one that reads `<Name>Error`. */
function className(error: object): string {
  const name = read(error, 'name');
  return typeof name === 'string' && (BUILTIN_ERROR_NAMES.has(name) || ERROR_CLASS_NAME.test(name))
    ? name
    : 'error';
}

/** A code that names a kind of failure and cannot hold a value. */
function failureCode(error: object): string | undefined {
  const code = read(error, 'code');
  if (typeof code !== 'string') return undefined;
  if (NODE_ERR_CODE.test(code) || MYSQL_CODE.test(code) || SQLSTATE.test(code)) return code;
  return knownErrnoNames().has(code) ? code : undefined;
}

/** Node's own code, the one it writes into a stack header as `Name [CODE]`. */
function headerCode(error: object): string | undefined {
  const code = read(error, 'code');
  return typeof code === 'string' && (NODE_ERR_CODE.test(code) || knownErrnoNames().has(code))
    ? code
    : undefined;
}

function syscall(error: object): string | undefined {
  const value = read(error, 'syscall');
  return typeof value === 'string' && SYSCALL.test(value) ? value : undefined;
}

/**
 * The headers a stack of `error` may start with: `Error.prototype.toString`
 * as V8 applies it (for a name and message that are strings or absent), and
 * Node's `Name [CODE]: message` for its own errors. Empty for anything else,
 * which matches no stack.
 */
function stackHeaders(error: object): readonly string[] {
  const name = read(error, 'name') ?? 'Error';
  const message = read(error, 'message') ?? '';
  if (typeof name !== 'string' || typeof message !== 'string') return [];
  if (name === '') return [message];
  const headers = [message === '' ? name : `${name}: ${message}`];
  const code = headerCode(error);
  if (code !== undefined) {
    headers.push(message === '' ? `${name} [${code}]` : `${name} [${code}]: ${message}`);
  }
  return headers;
}

/** The frames of `stack` after the header it starts with, or `undefined` when none matches. */
function framesAfterHeader(stack: string, headers: readonly string[]): string | undefined {
  for (const header of headers) {
    if (stack === header) return '';
    if (stack.startsWith(`${header}\n`)) return stack.slice(header.length + 1);
  }
  return undefined;
}

function isExistingFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Missing or unreadable: a frame that names it is not printed.
    return false;
  }
}

/**
 * A file location as the report prints it, relative to `cwd`, or `undefined`
 * when no such file exists: a frame's text is only printed when it names a
 * real file, so a function name shaped like a path prints nothing.
 */
function formatLocation(
  file: string,
  line: number,
  column: number | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!isExistingFile(file)) return undefined;
  const slot = cwd === undefined ? OUTSIDE_PATH_SLOT : realPathSlot(file, cwd);
  if (slot === OUTSIDE_PATH_SLOT) return slot;
  return column === undefined ? `${slot}:${line}` : `${slot}:${line}:${column}`;
}

/**
 * The location target of one frame line's body: the text inside the last
 * ` (` … `)`, where V8 puts it after any function name, or the whole body of
 * an anonymous frame (less an `async ` prefix). A function name can hold
 * ` (` and a path, but the location always comes last.
 */
function frameTarget(body: string): string {
  if (body.endsWith(')')) {
    const open = body.lastIndexOf(' (');
    if (open !== -1) return body.slice(open + 2, -1);
  }
  return body.startsWith('async ') ? body.slice('async '.length) : body;
}

/**
 * The first file frame of the stack's frame lines: frames that name no file
 * (Node's own modules, natives, eval) are passed over, and a line that is no
 * frame of a known shape ends the search with nothing, so a function name or
 * a path V8 printed oddly never yields a wrong place.
 */
function firstFileFrame(frames: readonly string[], cwd: string | undefined): string | undefined {
  for (const frame of frames) {
    if (!frame.startsWith(FRAME_PREFIX)) return undefined;
    const target = frameTarget(frame.slice(FRAME_PREFIX.length));
    if (NON_FILE_TARGET.test(target)) continue;
    const match = FRAME_LOCATION.exec(target);
    if (match === null) return undefined;
    const file = locationFile(match[1] as string);
    if (file === undefined) return undefined;
    return formatLocation(file, Number(match[2]), Number(match[3]), cwd);
  }
  return undefined;
}

/**
 * Where `error` was thrown, from its stack: the location block Node puts ahead
 * of a CommonJS SyntaxError's header, or else the first file frame after the
 * header. The stack must start with the error's own header, so text a
 * message brings along is never read as a frame.
 */
function sourceLocation(error: object, cwd: string | undefined): string | undefined {
  const stack = read(error, 'stack');
  if (typeof stack !== 'string') return undefined;
  const headers = stackHeaders(error);
  for (const header of headers) {
    const decorated = decoratedSyntaxLocation(stack, header);
    if (decorated !== undefined) {
      return formatLocation(decorated.file, decorated.line, decorated.column, cwd);
    }
  }
  const frames = framesAfterHeader(stack, headers);
  return frames === undefined ? undefined : firstFileFrame(frames.split('\n'), cwd);
}

function thrownValueType(value: unknown): string {
  if (value === null) return 'a thrown null';
  if (Array.isArray(value)) return 'a thrown array';
  return `a thrown ${typeof value}`;
}

/**
 * An AggregateError's members as far as the report prints them (the first
 * {@link MAX_MEMBERS}) and how many there are, read index by index so an
 * array-like proxy runs no more traps than that. Unreadable members read as
 * none.
 */
function members(error: object): { readonly first: readonly unknown[]; readonly count: number } {
  const none = { first: [], count: 0 };
  const value = read(error, 'errors');
  try {
    if (!Array.isArray(value)) return none;
    const count = value.length;
    if (!Number.isSafeInteger(count) || count < 0) return none;
    const first: unknown[] = [];
    for (let index = 0; index < Math.min(count, MAX_MEMBERS); index += 1) {
      first.push(value[index]);
    }
    return { first, count };
  } catch {
    // A revoked or trapping proxy: its members cannot be listed.
    return none;
  }
}

function describeLink(value: unknown, cwd: string | undefined): Link {
  if (isRegistryError(value)) {
    const text = registryErrorText(value);
    if (text !== undefined) return { summary: text.message, hint: text.suggestion, foreign: false };
  }
  if (isJsailsError(value)) {
    const code = read(value, 'code');
    const name = className(value);
    return {
      summary:
        typeof code === 'string' && code.length <= 64 && FRAMEWORK_CODE.test(code)
          ? `${name} (${code})`
          : name,
      hint: undefined,
      foreign: true,
    };
  }
  if (!isErrorObject(value)) {
    return { summary: thrownValueType(value), hint: undefined, foreign: true };
  }
  const parts = [className(value)];
  const code = failureCode(value);
  if (code !== undefined) parts.push(code);
  const call = syscall(value);
  if (call !== undefined) parts.push(`(${call})`);
  const location = sourceLocation(value, cwd);
  if (location !== undefined) parts.push(`at ${location}`);
  const { count } = members(value);
  if (count > 0) parts.push(`(${count} ${count === 1 ? 'error' : 'errors'})`);
  return { summary: parts.join(' '), hint: undefined, foreign: true };
}

/**
 * {@link describeLink}, or a bare `error` for a value whose every probe throws
 * (a proxy whose traps throw): explaining a failure must not fail.
 */
function describeSafely(value: unknown, cwd: string | undefined): Link {
  try {
    return describeLink(value, cwd);
  } catch {
    return { summary: 'error', hint: undefined, foreign: true };
  }
}

function inspectSafely(value: unknown): string {
  try {
    return inspect(value, { depth: 4, breakLength: Infinity });
  } catch {
    // A custom inspector that throws: the value's type is all there is to say.
    return thrownValueType(value);
  }
}

function indented(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}${line}`);
}

/**
 * The debug detail of a foreign link: its message, then its stack. A stack
 * that starts with the error's own header (Node's `Name [CODE]:` form
 * included) loses that header, which only repeats the message; any other
 * stack (a CommonJS SyntaxError's location block, a rewritten one) prints
 * whole.
 */
function debugDetail(value: unknown, indent: string, withMessage: boolean): string[] {
  if (!isErrorObject(value)) return indented(inspectSafely(value), indent);
  const lines: string[] = [];
  const message = read(value, 'message');
  if (withMessage && typeof message === 'string' && message !== '') {
    lines.push(...indented(message, indent));
  }
  const stack = read(value, 'stack');
  if (typeof stack === 'string') {
    const frames = framesAfterHeader(stack, stackHeaders(value)) ?? stack;
    if (frames.trim() !== '') lines.push(...indented(frames.replace(/\n+$/, ''), indent));
  }
  return lines;
}

/** Print what `value` holds below it: its aggregate members, then its cause. */
function walkBelow(walk: Walk, value: unknown, indent: string, depth: number): void {
  if (!isErrorObject(value)) return;
  const { first, count } = members(value);
  first.forEach((member, index) => {
    visit(walk, member, `${indent}  `, `${index + 1}. `, depth + 1);
  });
  if (count > MAX_MEMBERS) {
    walk.lines.push(`${indent}  … and ${count - MAX_MEMBERS} more`);
  }
  const cause = readChecked(value, 'cause');
  if (cause === UNREADABLE) {
    walk.lines.push(`${indent}caused by: (a cause that could not be read)`);
  } else if (cause !== undefined) {
    visit(walk, cause, indent, 'caused by: ', depth + 1);
  }
}

function visit(walk: Walk, value: unknown, indent: string, label: string, depth: number): void {
  if (depth > MAX_DEPTH || walk.links >= MAX_LINKS) {
    walk.lines.push(`${indent}${label}(further causes not shown)`);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    if (walk.seen.has(value)) {
      walk.lines.push(`${indent}${label}(an error shown above: the chain loops)`);
      return;
    }
    walk.seen.add(value);
  }
  walk.links += 1;
  const link = describeSafely(value, walk.cwd);
  walk.lines.push(`${indent}${label}${link.summary}`);
  if (link.hint !== undefined) walk.lines.push(`${indent}  hint: ${link.hint}`);
  if (link.foreign) {
    if (walk.debug) walk.lines.push(...debugDetail(value, `${indent}    `, true));
    else walk.summarised = true;
  }
  walkBelow(walk, value, indent, depth);
}

function currentDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // The working directory was removed: no path can be shown relative to it.
    return undefined;
  }
}

/**
 * The lines that follow a failure's top message: the cause chain of `thrown`,
 * each line indented, then the `JSAILS_DEBUG` note when a link was summarised
 * and debug is off. Empty when there is nothing to add.
 */
export function renderCauseChain(thrown: unknown, options: CauseChainOptions): string[] {
  const walk: Walk = {
    debug: isDebugEnabled(options.env),
    cwd: options.cwd ?? currentDirectory(),
    seen: new WeakSet(),
    lines: [],
    links: 0,
    summarised: false,
  };
  try {
    if (typeof thrown === 'object' && thrown !== null) walk.seen.add(thrown);
    const head = describeSafely(thrown, walk.cwd);
    if (options.head === 'withheld') {
      // The reporter printed a fixed line instead of this error's message.
      walk.lines.push(`  error: ${head.summary}`);
      if (head.hint !== undefined) walk.lines.push(`    hint: ${head.hint}`);
      if (head.foreign) {
        if (walk.debug) walk.lines.push(...debugDetail(thrown, '      ', true));
        else walk.summarised = true;
      }
    } else if (walk.debug && head.foreign && isErrorObject(thrown) && !isJsailsError(thrown)) {
      // The message is on the top line already; debug adds where it came from.
      // A framework error's stack only names the framework, so it is left out.
      walk.lines.push(...debugDetail(thrown, '    ', false));
    }
    walkBelow(walk, thrown, '  ', 0);
  } catch {
    // Every read is guarded, so only a value built to break the walk gets
    // here; what was gathered stands, and the rest is named, not guessed.
    walk.lines.push('  (the rest of the chain could not be read)');
    walk.summarised = true;
  }
  if (walk.summarised && !walk.debug) walk.lines.push(DEBUG_NOTE);
  return walk.lines;
}

/**
 * A whole failure report for a bin: `<program>: [<label>: ]<message>` (or the
 * fallback, by the policy of `failureHead` in `errors/registry.ts`), its `hint:` line, and
 * the cause chain.
 */
export function renderFailureReport(
  thrown: unknown,
  options: FailureReportRenderOptions,
): string[] {
  const head = failureHead(thrown, options);
  const [first = '', ...rest] = head.lines;
  return [
    `${options.program}: ${options.label === undefined ? first : `${options.label}: ${first}`}`,
    ...rest,
    ...renderCauseChain(thrown, {
      env: options.env,
      head: head.shown ? 'shown' : 'withheld',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }),
  ];
}
