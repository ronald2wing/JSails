/**
 * The command sources that are not built in, as far as finding one command
 * needs, read without importing anything from the project: the
 * `jsails.commands` of the project's direct dependencies and the app's built
 * file for a command name (see `command-lookup.ts`, which lists them for
 * help and locates the one to run). The dispatcher reads these before every
 * built-in it runs, to refuse one whose name the project claims
 * ({@link builtinClaimant}), so this module stays as light as reading files
 * allows: no directory walk and no summary cache.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { isErrno } from '../errors/inspect.js';
import type { ListedDependencyCommand } from './help.js';

/** A command name: lowercase words, colon-separated (the manifest schema's tool name). */
export const COMMAND_NAME_PATTERN: RegExp = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;

/** A command a dependency declares. */
export interface DependencyCommand extends ListedDependencyCommand {
  /** The specifier whose default export implements it. */
  readonly module: string;
}

/** The commands the dependencies declare, and the declarations help could not use. */
export interface DependencyCommands {
  readonly commands: readonly DependencyCommand[];
  readonly problems: readonly string[];
}

/** The JSON in the file at `path`; `undefined` when there is none, or it is no JSON. */
export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A file that is not JSON declares nothing; listing commands is no place
    // to diagnose a broken package.json, and nothing in it may be echoed.
    return undefined;
  }
}

/** Whether `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The direct dependency names of the project at `root`, sorted. */
function directDependencies(root: string): readonly string[] {
  const manifest = readJson(join(root, 'package.json'));
  if (!isRecord(manifest)) return [];
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const group = manifest[field];
    if (isRecord(group)) for (const name of Object.keys(group)) names.add(name);
  }
  return [...names].sort();
}

/** The `package.json` of `name` as Node resolves it from `root`, or `undefined`. */
function findPackageManifest(root: string, name: string): unknown {
  let dir = root;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    const manifest = readJson(candidate);
    if (manifest !== undefined) return manifest;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether `module` is `packageName` or one of its subpaths. */
function isOwnModule(packageName: string, module: unknown): module is string {
  return (
    typeof module === 'string' &&
    (module === packageName || module.startsWith(`${packageName}/`)) &&
    !module.includes('..')
  );
}

/**
 * Read the `jsails.commands` of every direct dependency of the project at
 * `root`. A malformed declaration is a value-free problem line and is not
 * used; a dependency that is not installed declares nothing.
 */
export function readDependencyCommands(root: string): DependencyCommands {
  const commands: DependencyCommand[] = [];
  const problems: string[] = [];
  for (const packageName of directDependencies(root)) {
    const manifest = findPackageManifest(root, packageName);
    if (!isRecord(manifest)) continue;
    const field = manifest['jsails'];
    if (!isRecord(field) || field['commands'] === undefined) continue;
    const declared = field['commands'];
    if (!Array.isArray(declared)) {
      problems.push(`${packageName}: jsails.commands is not a list`);
      continue;
    }
    declared.forEach((entry: unknown, index) => {
      if (
        isRecord(entry) &&
        typeof entry['name'] === 'string' &&
        COMMAND_NAME_PATTERN.test(entry['name']) &&
        typeof entry['summary'] === 'string' &&
        entry['summary'].trim() !== '' &&
        isOwnModule(packageName, entry['module'])
      ) {
        commands.push({
          name: entry['name'],
          summary: entry['summary'],
          packageName,
          module: entry['module'],
        });
      } else {
        problems.push(`${packageName}: jsails.commands[${index}] is invalid`);
      }
    });
  }
  return { commands, problems };
}

/** The directory app commands are built into, relative to the project root. */
export const APP_COMMANDS_DIR = 'dist/commands';
/** The extensions of a built app command. */
export const BUILT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs']);

/** The built module of app command `name`, absolute, or `undefined` when none exists. */
export function resolveAppCommand(root: string, name: string): string | undefined {
  if (!COMMAND_NAME_PATTERN.test(name)) return undefined;
  const base = join(root, ...APP_COMMANDS_DIR.split('/'), ...name.split(':'));
  for (const extension of BUILT_EXTENSIONS) {
    if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
  }
  return undefined;
}

/**
 * The source that declares built-in command `name` as its own, which the
 * dispatcher refuses (`cli.reserved_command`) rather than let the built-in
 * run in its place unannounced: the first dependency that declares it, or
 * the app's built file (as a path from `root`); `undefined` when none does.
 */
export function builtinClaimant(name: string, root: string): string | undefined {
  const claimed = readDependencyCommands(root).commands.find((command) => command.name === name);
  if (claimed !== undefined) return claimed.packageName;
  const file = resolveAppCommand(root, name);
  // The id is built from the name's own parts, which are posix already: no
  // native path is converted, so `toPosixId` and its module stay unloaded on
  // the path every built-in takes.
  return file === undefined
    ? undefined
    : `${APP_COMMANDS_DIR}/${name.split(':').join('/')}${extname(file)}`;
}
