/**
 * Where a command that is not built in comes from, found without importing
 * anything from the project (the readers of the first two are in
 * `command-sources.ts`):
 *
 * - **Dependency manifests.** The `jsails.commands` list (`{ name, summary,
 *   module }`) of each direct dependency (`dependencies` and
 *   `devDependencies` of the project's `package.json`), whose `package.json`
 *   is found by walking `node_modules` up from the project root, as Node
 *   does. `module` is the package itself or one of its subpaths; its default
 *   export is a `defineCommand` value. The reader is structural, so listing
 *   commands loads no schema library.
 * - **The app convention.** `jsails a:b` runs `dist/commands/a/b.js` (or
 *   `.mjs`): a colon is a directory, since a colon is no portable file name.
 *   Help lists the built files, a source under `commands/` that has none
 *   as not built, and each file's summary from `.jsails/commands.json`, a
 *   cache the dispatcher writes when it imports a command anyway. A cache
 *   entry counts only while the file's SHA-256 digest matches, so an edited
 *   command shows no stale summary.
 *
 * Help reads these files and imports none of them, so a command module that
 * throws at import is still listed ({@link listExternalCommands}); running
 * one starts from {@link locateExternal}, which refuses a name two sources
 * claim rather than guess. Running a built-in starts from `builtinClaimant`
 * of `command-sources.ts`, which names a source that claims its name.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse as parsePath, relative } from 'node:path';

import { walkSortedFiles } from '../compiler/sorted-file-walk.js';
import { toPosixId } from '../support/project-paths.server.js';
import {
  APP_COMMANDS_DIR,
  BUILT_EXTENSIONS,
  COMMAND_NAME_PATTERN,
  isRecord,
  readDependencyCommands,
  readJson,
  resolveAppCommand,
  type DependencyCommand,
} from './command-sources.js';
import type { GlobalHelpSections, ListedAppCommand } from './help.js';
import { PACKAGE_COMMANDS } from './manifest.js';

// ---------------------------------------------------------------------------
// The app convention
// ---------------------------------------------------------------------------

/** The directory app command sources live in. */
const APP_SOURCES_DIR = 'commands';
const SOURCES = new Set(['.ts', '.mts']);

/** The command a path under `dist/commands/` (`a/b.js`) runs as (`a:b`). */
export function commandNameOf(relative: string): string {
  const { dir, name } = parsePath(relative);
  return dir === '' ? name : `${dir.split('/').join(':')}:${name}`;
}

/** The summary cache's file, relative to the project root. */
export const SUMMARY_CACHE = '.jsails/commands.json';

interface CacheEntry {
  readonly sha256: string;
  readonly summary: string;
}

function readCache(root: string): Readonly<Record<string, CacheEntry>> {
  const cache = readJson(join(root, ...SUMMARY_CACHE.split('/')));
  if (!isRecord(cache) || cache['version'] !== 1 || !isRecord(cache['entries'])) return {};
  const entries: Record<string, CacheEntry> = {};
  for (const [file, entry] of Object.entries(cache['entries'])) {
    if (
      isRecord(entry) &&
      typeof entry['sha256'] === 'string' &&
      typeof entry['summary'] === 'string'
    ) {
      entries[file] = { sha256: entry['sha256'], summary: entry['summary'] };
    }
  }
  return entries;
}

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Record app command `relative`'s summary (a path under `dist/commands/`)
 * against the digest of its built file.
 */
export function recordAppCommandSummary(root: string, relative: string, summary: string): void {
  const file = join(root, ...APP_COMMANDS_DIR.split('/'), ...relative.split('/'));
  const entries = { ...readCache(root), [relative]: { sha256: digest(file), summary } };
  const path = join(root, ...SUMMARY_CACHE.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

/** The app commands help lists, and the files whose names are no command name. */
export function listAppCommands(root: string): {
  readonly commands: readonly ListedAppCommand[];
  readonly problems: readonly string[];
} {
  const cache = readCache(root);
  const commands: ListedAppCommand[] = [];
  const problems: string[] = [];
  const built = new Set<string>();
  const builtDir = join(root, ...APP_COMMANDS_DIR.split('/'));
  for (const relative of walkSortedFiles(builtDir, {
    extensions: BUILT_EXTENSIONS,
    skipDotEntries: true,
  })) {
    const name = commandNameOf(relative);
    if (!COMMAND_NAME_PATTERN.test(name)) {
      problems.push(`${APP_COMMANDS_DIR}/${relative}: not a command name`);
      continue;
    }
    built.add(name);
    const cached = cache[relative];
    const summary =
      cached !== undefined && cached.sha256 === digest(join(builtDir, ...relative.split('/')))
        ? cached.summary
        : undefined;
    commands.push({ name, summary, unbuilt: false });
  }
  const sources = walkSortedFiles(join(root, APP_SOURCES_DIR), {
    extensions: SOURCES,
    skipDotEntries: true,
    include: (file) => !file.endsWith('.d.ts') && !/\.test\.m?ts$/.test(file),
  });
  for (const relative of sources) {
    const name = commandNameOf(relative);
    if (COMMAND_NAME_PATTERN.test(name) && !built.has(name)) {
      built.add(name);
      commands.push({ name, summary: undefined, unbuilt: true });
    }
  }
  commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { commands, problems };
}

// ---------------------------------------------------------------------------
// Both sources together
// ---------------------------------------------------------------------------

/**
 * What the global help lists besides the built-ins (named by `builtins`): a
 * command that takes a name already listed is left out, with a problem line.
 */
export function listExternalCommands(
  root: string,
  builtins: ReadonlySet<string>,
): GlobalHelpSections {
  const dependencies = readDependencyCommands(root);
  const app = listAppCommands(root);
  const problems = [...dependencies.problems, ...app.problems];
  const owners = new Map<string, string>();
  const ownerOf = (name: string): string | undefined =>
    builtins.has(name) ? 'jsails' : owners.get(name);
  const listedDependencies = dependencies.commands.filter((command) => {
    const owner = ownerOf(command.name);
    if (owner !== undefined) {
      problems.push(`${command.packageName}: command ${command.name} is also declared by ${owner}`);
      return false;
    }
    owners.set(command.name, command.packageName);
    return true;
  });
  const listedApp = app.commands.filter((command) => {
    const owner = ownerOf(command.name);
    if (owner !== undefined) {
      problems.push(`${APP_COMMANDS_DIR}: command ${command.name} is also declared by ${owner}`);
      return false;
    }
    return true;
  });
  return { dependencies: listedDependencies, app: listedApp, problems };
}

/** A command that is not built in, located. */
export type ExternalCommand =
  | { readonly kind: 'dependency'; readonly command: DependencyCommand }
  | {
      readonly kind: 'app';
      /** Its built module, absolute. */
      readonly file: string;
      /** Its path under `dist/commands/`. */
      readonly relative: string;
    };

/**
 * Locate command `name` among the dependencies and the app, or `undefined`
 * when neither declares it. Throws `cli.ambiguous_command` for a name two
 * sources declare, and `cli.missing_dependency` for a first-party command
 * whose package the project does not install.
 */
export async function locateExternal(
  name: string,
  root: string,
): Promise<ExternalCommand | undefined> {
  const matches = readDependencyCommands(root).commands.filter((command) => command.name === name);
  const file = resolveAppCommand(root, name);
  const [first, second] = matches;
  if (first !== undefined && (second !== undefined || file !== undefined)) {
    const { CliErrors } = await import('./errors.js');
    throw new CliErrors.Error('ambiguous_command', {
      command: name,
      first: first.packageName,
      second: second !== undefined ? second.packageName : toPosixId(relative(root, file as string)),
    });
  }
  if (first !== undefined) return { kind: 'dependency', command: first };
  if (file !== undefined) {
    const builtDir = join(root, ...APP_COMMANDS_DIR.split('/'));
    return { kind: 'app', file, relative: toPosixId(relative(builtDir, file)) };
  }
  const owner = PACKAGE_COMMANDS.get(name);
  if (owner !== undefined) {
    const { CliErrors } = await import('./errors.js');
    throw new CliErrors.Error('missing_dependency', { command: name, package: owner });
  }
  return undefined;
}
