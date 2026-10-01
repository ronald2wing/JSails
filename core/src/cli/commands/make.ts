/**
 * The `make:*` generators: scaffold a single conventional file for one
 * component of a JSails app — a page, an API route, a job, a model, or a CLI
 * command. Each generator writes exactly one file into the conventional
 * directory (`pages/`, `api/`, `jobs/`, `models/`, `commands/`) using
 * exclusive creation, so an existing file is never overwritten.
 *
 * ```sh
 * jsails make:page about-us            # pages/about-us.tsx
 * jsails make:model blog-post          # models/blog-post.ts
 * jsails make:job send-reminder        # jobs/send-reminder.job.ts
 * jsails make:command report           # commands/report.ts
 * jsails make:api health --dir src     # src/api/health.ts
 * jsails make:content blog hello-world # content/blog/hello-world.md
 * ```
 *
 * `make:page` and `make:server-component` take `--mfc`, which writes a
 * `.jsails` component folder instead (`pages/about-us/about-us.jsails` and
 * `about-us.ts`): the `.jsails` template split by the same `splitSfc` that
 * `jsails convert` runs, so the two cannot disagree. It needs a project that
 * syncs `.jsails` sidecars (`.jsails/sfc`), whose companion types the
 * folder's `x.ts`; elsewhere it is refused, `make.no_sidecars`.
 *
 * Names must match `[A-Za-z][A-Za-z0-9_-]*`; the case is normalized (a
 * `blog-post` or `BlogPost` input both yield `pages/blog-post.tsx` with a
 * `BlogPostPage` component). The generated files follow the starter's own
 * conventions (imports through `app/*` shims and `ui/layout.js`), so they
 * compile against a fresh scaffold. The command writes only the files it
 * generates, all or none (`../exclusive-files.ts`), and never imports
 * application code.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { GENERATOR_LAYOUT, kebabCase, type MakeCommandType } from '../../compiler/conventions.js';
import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';
import { relativePathSlot } from '../../support/project-paths.server.js';
import type { CommandModule } from '../descriptor.js';
import type { NewFile } from '../exclusive-files.js';
import type { MAKE_FOLDER_OPTIONS } from '../manifest.js';
import { isSfcMakeType, renderSfcTemplate, renderTemplate } from './make-templates.js';
import { renderTestTemplate, testPathFor } from './make-test-templates.js';

const MAKE_ERRORS = {
  duplicate_file: {
    kind: 'conflict',
    message: 'refusing to overwrite existing file {path}',
    context: { path: 'relative-path' },
  },
  invalid_template: {
    kind: 'internal',
    message: 'a generator template is not a valid .jsails component',
  },
  no_sidecars: {
    kind: 'invalid',
    message:
      'this project does not sync .jsails sidecars (.jsails/sfc), which a component folder needs',
  },
} as const;

/**
 * `make:*`'s codes, `make.*`: a generator target that already exists, a
 * `.jsails` template that does not split into a folder (a framework bug),
 * and a component folder asked of a project that does not sync sidecars.
 */
export const MakeErrors: ErrorRegistry<'make', typeof MAKE_ERRORS> = defineErrors(
  'make',
  MAKE_ERRORS,
);

/** A name must be a leading letter followed by letters, digits, `_` or `-`. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A generator invocation: a name, an optional content collection, and a base directory. */
interface MakeInvocation {
  readonly name: string;
  /** The content collection, present only for `make:content`. */
  readonly collection: string | undefined;
  readonly baseDir: string;
  /** Generate the companion test file. Defaults to true. */
  readonly withTest: boolean;
  /** Write a `.jsails` component folder (`--mfc`). */
  readonly folder: boolean;
}

/** The values a `make:*` generator parses. */
export interface MakeValues {
  readonly dir?: string;
  readonly 'no-test'?: boolean;
  /** `make:page` and `make:server-component` only. */
  readonly mfc?: boolean;
}

/**
 * Check a generator's values and positionals (`[name]`, or `[collection,
 * name]` for `make:content`); a usage message when they do not hold.
 */
export function makeInvocation(
  type: MakeCommandType,
  values: MakeValues,
  positionals: readonly string[],
): MakeInvocation | string {
  const [first, second] = positionals;
  const collection = type === 'content' ? first : undefined;
  const name = type === 'content' ? second : first;
  if (name === undefined) return `make:${type} requires a name`;
  if (!NAME_PATTERN.test(name)) return 'names must match [A-Za-z][A-Za-z0-9_-]*';
  if (collection !== undefined && !NAME_PATTERN.test(collection)) {
    return 'collections must match [A-Za-z][A-Za-z0-9_-]*';
  }
  if (values.dir === '') return '--dir requires a directory';
  return {
    name,
    collection,
    baseDir: values.dir ?? '.',
    withTest: values['no-test'] !== true,
    folder: values.mfc === true,
  };
}

/**
 * Create `files` all or none (`../exclusive-files.ts`); a file that already
 * exists is `make.duplicate_file`, reported, and exit code 1.
 */
async function createAll(
  type: MakeCommandType,
  files: readonly NewFile[],
): Promise<number | undefined> {
  // Loaded here, as the layout module is below, so `make --help` loads only
  // what printing the help needs.
  const { createFilesExclusive } = await import('../exclusive-files.js');
  const created = await createFilesExclusive(files);
  if (created.ok) return undefined;
  console.error(
    `jsails make:${type}: ${new MakeErrors.Error('duplicate_file', { path: relativePathSlot(created.existing) }).message}`,
  );
  return 1;
}

/**
 * `make:page|server-component --mfc`: the `.jsails` template split into a
 * component folder. Nothing is written unless every file can be created,
 * and no companion test is written (a `.jsails` component's test entry is
 * the build's). A project that does not sync `.jsails` sidecars is refused
 * (`make.no_sidecars`): its TypeScript program and route discovery would
 * take the folder's `x.ts` for a module of its own.
 */
async function makeFolder(
  type: 'page' | 'server-component',
  invocation: MakeInvocation,
): Promise<number> {
  // The layout module parses with oxc; loaded here so `make --help` and the
  // other generators load no third-party package.
  const [{ sfcFolderPaths, splitSfc }, { syncsSidecars }] = await Promise.all([
    import('../../compiler/sfc/layout.js'),
    import('../../compiler/sfc/shadow.js'),
  ]);
  if (!syncsSidecars(resolve(invocation.baseDir))) {
    console.error(`jsails make:${type}: ${new MakeErrors.Error('no_sidecars').message}`);
    return 1;
  }
  const dir = GENERATOR_LAYOUT[type].dir;
  const component = `${dir}/${kebabCase(invocation.name)}.jsails`;
  const split = splitSfc(renderSfcTemplate(type, invocation.name), component);
  if (!split.ok) throw new MakeErrors.Error('invalid_template');
  const paths = sfcFolderPaths(component);
  const files: { readonly path: string; readonly text: string }[] = [
    { path: paths.template, text: split.folder.template },
    ...(split.folder.script === undefined
      ? []
      : [{ path: paths.script, text: split.folder.script }]),
  ];
  const absolute = (path: string): string => resolve(invocation.baseDir, ...path.split('/'));
  const existing = [component, ...files.map((file) => file.path)].find((path) =>
    existsSync(absolute(path)),
  );
  if (existing !== undefined) {
    console.error(
      `jsails make:${type}: ${new MakeErrors.Error('duplicate_file', { path: relativePathSlot(absolute(existing)) }).message}`,
    );
    return 1;
  }
  const created = files.map((file) => ({ path: absolute(file.path), text: file.text }));
  const failed = await createAll(type, created);
  if (failed !== undefined) return failed;
  for (const file of created) console.log(`Created ${file.path}`);
  return 0;
}

/**
 * Run a `make:*` generator: render the conventional file, and write it
 * exclusively. Returns the exit code.
 */
export async function runMakeCommand(
  type: MakeCommandType,
  invocation: MakeInvocation,
): Promise<number> {
  if (invocation.folder && isSfcMakeType(type)) {
    return makeFolder(type, invocation);
  }

  const layout = GENERATOR_LAYOUT[type];
  const kebabName = kebabCase(invocation.name);
  const relativeTestPath = invocation.withTest ? testPathFor(type, kebabName) : undefined;
  const testPath =
    relativeTestPath === undefined ? undefined : resolve(invocation.baseDir, relativeTestPath);
  const testContent = renderTestTemplate(type, invocation.name);

  // Refuse before writing anything when the companion test already exists, so a
  // failed generation never leaves a half-written pair behind.
  if (testPath !== undefined && existsSync(testPath)) {
    console.error(
      `jsails make:${type}: ${new MakeErrors.Error('duplicate_file', { path: relativePathSlot(testPath) }).message}`,
    );
    return 1;
  }

  const segments = [layout.dir];
  // `make:content` nests under `content/<collection>`.
  if (invocation.collection !== undefined) {
    segments.push(kebabCase(invocation.collection));
  }
  const filePath = resolve(
    invocation.baseDir,
    ...segments,
    `${kebabCase(invocation.name)}${layout.extension}`,
  );
  const content = renderTemplate(type, invocation.name);

  const failed = await createAll(type, [
    { path: filePath, text: content },
    ...(testPath !== undefined && testContent !== undefined
      ? [{ path: testPath, text: testContent }]
      : []),
  ]);
  if (failed !== undefined) return failed;

  console.log(`Created ${filePath}`);
  if (testPath !== undefined && testContent !== undefined) {
    console.log(`Created ${testPath}`);
  }
  return 0;
}

/** `jsails make:<type>`: every generator, told apart by the command's name. */
export const makeCommand: CommandModule<typeof MAKE_FOLDER_OPTIONS, 'nothing'> = {
  run: (context) => {
    // The manifest lists `make:<type>` for exactly the generator types.
    const type = context.name.slice('make:'.length) as MakeCommandType;
    const invocation = makeInvocation(type, context.values, context.positionals);
    if (typeof invocation === 'string') return context.usage(invocation);
    return runMakeCommand(type, invocation);
  },
};
