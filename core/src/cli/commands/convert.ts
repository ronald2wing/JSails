/**
 * `jsails convert <path>`: toggle a `.jsails` component between its two
 * layouts (`compiler/sfc/layout.ts`), one file or a folder named after it.
 *
 * ```sh
 * jsails convert pages/about.jsails     # → pages/about/about.jsails, about.ts, about.css
 * jsails convert pages/about            # → pages/about.jsails (also pages/about/about.jsails)
 * ```
 *
 * Every block body and comment moves byte for byte, and the relative
 * specifiers of the moved TypeScript are rewritten so each still names the
 * same file. The component's server module (`about.server.ts`) moves with it.
 * Importers need no change: a component is imported by its component path
 * (`./about.jsails`) in both layouts. Nothing is lost silently: a component
 * whose blocks do not scan cleanly, whose script does not parse, or whose
 * styles a folder cannot hold is refused with its diagnostics, so is a
 * folder whose script or style file holds a `</script` or `</style` that
 * would end its block in one file, and an existing target is never
 * overwritten. The new files are created first, all or none, and the old ones
 * removed after, so a failure leaves the component as it was.
 *
 * A file becomes a folder only in a project that syncs `.jsails` sidecars
 * (`.jsails/sfc`, the working directory's): the folder's `x.ts` is a module
 * of the project's TypeScript program, typed by its script companion, and
 * without sync the program and route discovery would take it for a module of
 * its own (`convert.no_sidecars`). A folder becomes a file anywhere. The
 * command neither formats nor imports anything; it reads and writes only the
 * component's files.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, rmdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { sfcFolderMember } from '../../routing/component-parts.js';
import type { SfcDiagnostic } from '../../compiler/sfc/diagnostics.js';
import {
  joinSfc,
  sfcFolderPaths,
  sfcServerPath,
  splitSfc,
  toFolderPaths,
  toSinglePaths,
  type SfcFolderSources,
} from '../../compiler/sfc/layout.js';
import { lineIndex } from '../../compiler/sfc/line-index.js';
import { applyTextEdits, relocationEdits } from '../../compiler/sfc/relocate.js';
import { syncsSidecars } from '../../compiler/sfc/shadow.js';
import { isErrno } from '../../errors/inspect.js';
import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import { relativePathSlot, toPosixId } from '../../support/project-paths.server.js';
import { createFilesExclusive } from '../exclusive-files.js';
import type { CommandModule } from '../descriptor.js';
import type { NO_OPTIONS } from '../manifest.js';

const CONVERT_ERRORS = {
  not_a_component: {
    kind: 'invalid',
    message: '{path} is not a .jsails component file or folder',
    context: { path: 'relative-path' },
  },
  target_exists: {
    kind: 'conflict',
    message: 'refusing to overwrite existing file {path}',
    context: { path: 'relative-path' },
  },
  invalid_blocks: {
    kind: 'invalid',
    message: 'the blocks of {path} do not scan cleanly; fix the diagnostics below first',
    context: { path: 'relative-path' },
  },
  script_syntax: {
    kind: 'invalid',
    message: 'a script of {path} is not valid TypeScript, so its imports cannot be moved',
    context: { path: 'relative-path' },
  },
  style_count: {
    kind: 'invalid',
    message: '{path} has more than one <style> or <style scoped>; a folder holds one of each',
    context: { path: 'relative-path' },
    suggestion: 'Merge the style blocks of each kind into one, then convert',
  },
  folder_block: {
    kind: 'invalid',
    message:
      'the template file of {path} holds a <script> or <style>, whose home is a file of its own',
    context: { path: 'relative-path' },
  },
  end_tag: {
    kind: 'invalid',
    message:
      'a script or style file of {path} holds </script or </style, which would end its block in one file',
    context: { path: 'relative-path' },
    suggestion: 'Split each such end tag (<\\/script> in a string), then convert',
  },
  no_sidecars: {
    kind: 'invalid',
    message:
      'this project does not sync .jsails sidecars (.jsails/sfc), which a component folder needs',
  },
} as const;

/** `jsails convert`'s codes, `convert.*`: why a component was not converted. */
export const ConvertErrors: ErrorRegistry<'convert', typeof CONVERT_ERRORS> = defineErrors(
  'convert',
  CONVERT_ERRORS,
);

/** Output sinks, injectable for tests. */
export interface ConvertDeps {
  readonly cwd: string;
  stdout(line: string): void;
  stderr(line: string): void;
}

/** A file to write: its absolute path and text. */
interface Output {
  readonly path: string;
  readonly text: string;
}

/** A conversion ready to apply: what to create, what to remove after. */
interface Plan {
  readonly create: readonly Output[];
  readonly remove: readonly string[];
  /** A directory to remove once it is empty (the old folder). */
  readonly folder: string | null;
  readonly summary: string;
}

/** The component a path names, in one layout or the other. */
type Target =
  | { readonly layout: 'file'; readonly file: string }
  | { readonly layout: 'folder'; readonly file: string };

/**
 * Work out what `input` names: a single file `D/x.jsails` (not named after
 * its directory), or a folder `D/x/` holding `x.jsails`, given as the
 * directory or as that file. `file` is the component path, absolute.
 */
function targetOf(input: string): Target | undefined {
  const stat = statOf(input);
  if (stat === 'directory') {
    const name = path.basename(input);
    const template = path.join(input, `${name}.jsails`);
    return statOf(template) === 'file'
      ? { layout: 'folder', file: path.join(path.dirname(input), `${name}.jsails`) }
      : undefined;
  }
  if (stat !== 'file' || !input.endsWith('.jsails')) return undefined;
  const member = sfcFolderMember(toPosixId(input));
  if (member?.role === 'template') {
    const folder = path.dirname(input);
    return {
      layout: 'folder',
      file: path.join(path.dirname(folder), `${path.basename(folder)}.jsails`),
    };
  }
  return { layout: 'file', file: input };
}

function statOf(target: string): 'file' | 'directory' | undefined {
  try {
    const stat = statSync(target);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

/** The absolute path of a path the layout module names relative to the component's directory. */
function inDirectory(directory: string, relative: string): string {
  return path.join(directory, ...relative.split('/'));
}

async function readOptional(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * A refusal: its error, and the diagnostics that explain it, whose files are
 * relative to `directory` and whose texts `texts` holds.
 */
class Refusal {
  constructor(
    readonly error: InstanceType<typeof ConvertErrors.Error>,
    readonly directory: string,
    readonly diagnostics: readonly SfcDiagnostic[] = [],
    readonly texts: ReadonlyMap<string, string> = new Map(),
  ) {}
}

/** The server module's text with its own relative specifiers moved from `from` to `to`. */
function movedServer(
  text: string,
  from: string,
  to: string,
  map: (path: string) => string,
): string | undefined {
  const edits = relocationEdits(text, from, to, map);
  return edits === undefined ? undefined : applyTextEdits(text, edits);
}

/**
 * Plan the conversion of the single file `file`. Paths are worked out
 * relative to the component's directory, which is all a relocation needs.
 */
async function planSplit(file: string, slot: string): Promise<Plan | Refusal> {
  const directory = path.dirname(file);
  const name = path.basename(file);
  const source = await readFile(file, 'utf8');
  const split = splitSfc(source, name);
  if (!split.ok) {
    return new Refusal(
      new ConvertErrors.Error(split.refusal, { path: slot }),
      directory,
      split.diagnostics,
      new Map([[name, source]]),
    );
  }
  const paths = sfcFolderPaths(name);
  const create: Output[] = [
    { path: inDirectory(directory, paths.template), text: split.folder.template },
  ];
  const optional: readonly [keyof SfcFolderSources, string][] = [
    ['script', paths.script],
    ['style', paths.style],
    ['scopedStyle', paths.scopedStyle],
  ];
  for (const [role, relative] of optional) {
    const text = split.folder[role];
    if (text !== undefined) create.push({ path: inDirectory(directory, relative), text });
  }
  const remove = [file];
  const serverPath = inDirectory(directory, sfcServerPath(name));
  const server = await readOptional(serverPath);
  if (server !== undefined) {
    const moved = movedServer(server, sfcServerPath(name), paths.server, toFolderPaths(name));
    if (moved === undefined) {
      return new Refusal(new ConvertErrors.Error('script_syntax', { path: slot }), directory);
    }
    create.push({ path: inDirectory(directory, paths.server), text: moved });
    remove.push(serverPath);
  }
  return {
    create,
    remove,
    folder: null,
    summary: `into the folder ${name.replace(/\.jsails$/, '')}/`,
  };
}

/** Plan the conversion of the folder of the component `file` into that single file. */
async function planJoin(file: string, slot: string): Promise<Plan | Refusal> {
  const directory = path.dirname(file);
  const name = path.basename(file);
  const paths = sfcFolderPaths(name);
  const absolute = (relative: string): string => inDirectory(directory, relative);
  const template = await readFile(absolute(paths.template), 'utf8');
  const script = await readOptional(absolute(paths.script));
  const style = await readOptional(absolute(paths.style));
  const scopedStyle = await readOptional(absolute(paths.scopedStyle));
  const folder: SfcFolderSources = {
    template,
    ...(script === undefined ? {} : { script }),
    ...(style === undefined ? {} : { style }),
    ...(scopedStyle === undefined ? {} : { scopedStyle }),
  };
  const joined = joinSfc(folder, name);
  if (!joined.ok) {
    return new Refusal(
      new ConvertErrors.Error(joined.refusal, { path: slot }),
      directory,
      joined.diagnostics,
      new Map([
        [paths.template, template],
        ...(script === undefined ? [] : [[paths.script, script] as const]),
        ...(style === undefined ? [] : [[paths.style, style] as const]),
        ...(scopedStyle === undefined ? [] : [[paths.scopedStyle, scopedStyle] as const]),
      ]),
    );
  }
  const create: Output[] = [{ path: file, text: joined.source }];
  const remove = [
    absolute(paths.template),
    ...(script === undefined ? [] : [absolute(paths.script)]),
    ...(style === undefined ? [] : [absolute(paths.style)]),
    ...(scopedStyle === undefined ? [] : [absolute(paths.scopedStyle)]),
  ];
  const server = await readOptional(absolute(paths.server));
  if (server !== undefined) {
    const moved = movedServer(server, paths.server, sfcServerPath(name), toSinglePaths(name));
    if (moved === undefined) {
      return new Refusal(new ConvertErrors.Error('script_syntax', { path: slot }), directory);
    }
    create.push({ path: absolute(sfcServerPath(name)), text: moved });
    remove.push(absolute(paths.server));
  }
  return {
    create,
    remove,
    folder: path.join(directory, name.replace(/\.jsails$/, '')),
    summary: `into the file ${name}`,
  };
}

/**
 * One diagnostic of `refusal` as a line: the file relative to `cwd`, its
 * line and column, the code and the compiler's message, which names
 * constructs, never the file's text.
 */
function diagnosticLine(refusal: Refusal, entry: SfcDiagnostic, cwd: string): string {
  const text = refusal.texts.get(entry.file);
  const file = relativePathSlot(path.join(refusal.directory, ...entry.file.split('/')), cwd);
  const at = text === undefined ? undefined : lineIndex(text).positionAt(entry.start);
  const where = at === undefined ? file : `${file}:${at.line + 1}:${at.column + 1}`;
  return `  ${where} ${entry.code} ${entry.message}`;
}

/**
 * Create every planned file, or none (`../exclusive-files.ts`), then remove
 * the old files and the old folder once it is empty. Returns the path that
 * already existed when nothing was created.
 */
async function apply(plan: Plan): Promise<string | undefined> {
  const created = await createFilesExclusive(plan.create);
  if (!created.ok) return created.existing;
  for (const old of plan.remove) await unlink(old);
  if (plan.folder !== null && (await readdir(plan.folder)).length === 0) {
    await rmdir(plan.folder);
  }
  return undefined;
}

/** Convert the component at `component` (relative to `deps.cwd`); returns the exit code. */
export async function runConvertCommand(component: string, deps: ConvertDeps): Promise<number> {
  const input = path.resolve(deps.cwd, component);
  const slot = relativePathSlot(input, deps.cwd);
  const target = targetOf(input);
  if (target === undefined) {
    deps.stderr(
      `jsails convert: ${new ConvertErrors.Error('not_a_component', { path: slot }).message}`,
    );
    return 1;
  }
  if (target.layout === 'file' && !syncsSidecars(deps.cwd)) {
    deps.stderr(`jsails convert: ${new ConvertErrors.Error('no_sidecars').message}`);
    return 1;
  }
  const plan =
    target.layout === 'file'
      ? await planSplit(target.file, slot)
      : await planJoin(target.file, slot);
  if (plan instanceof Refusal) {
    deps.stderr(`jsails convert: ${plan.error.message}`);
    if (plan.error.suggestion !== undefined) deps.stderr(plan.error.suggestion);
    for (const entry of plan.diagnostics) deps.stderr(diagnosticLine(plan, entry, deps.cwd));
    return 1;
  }
  const existing = plan.create.find((output) => existsSync(output.path));
  if (existing !== undefined) {
    deps.stderr(
      `jsails convert: ${new ConvertErrors.Error('target_exists', { path: relativePathSlot(existing.path, deps.cwd) }).message}`,
    );
    return 1;
  }
  const raced = await apply(plan);
  if (raced !== undefined) {
    deps.stderr(
      `jsails convert: ${new ConvertErrors.Error('target_exists', { path: relativePathSlot(raced, deps.cwd) }).message}`,
    );
    return 1;
  }
  deps.stdout(`Converted ${slot} ${plan.summary}`);
  for (const output of plan.create)
    deps.stdout(`Created ${relativePathSlot(output.path, deps.cwd)}`);
  for (const old of plan.remove) deps.stdout(`Removed ${relativePathSlot(old, deps.cwd)}`);
  return 0;
}

/** `jsails convert <path>`. */
export const convertCommand: CommandModule<typeof NO_OPTIONS, 'nothing'> = {
  run: (context) =>
    runConvertCommand(context.positionals[0] as string, {
      cwd: context.cwd,
      stdout: (line) => context.stdout(line),
      stderr: (line) => context.stderr(line),
    }),
};
