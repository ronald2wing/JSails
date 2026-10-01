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
 * Names must match `[A-Za-z][A-Za-z0-9_-]*`; the case is normalized (a
 * `blog-post` or `BlogPost` input both yield `pages/blog-post.tsx` with a
 * `BlogPostPage` component). The generated files follow the starter's own
 * conventions (imports through `app/*` shims and `ui/layout.js`), so they
 * compile against a fresh scaffold. The command performs no writes beyond the
 * single generated file and never imports application code.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  GENERATOR_LAYOUT,
  MAKE_COMMAND_TYPES,
  kebabCase,
  type MakeCommandType,
} from '../../compiler/conventions.js';
import { isErrno } from '../../errors/inspect.js';
import { JsailsError } from '../../errors/jsails-error.js';
import { usageError } from '../usage-error.js';
import { renderTemplate, serverComponentMfcTemplate } from './make-templates.js';
import { renderTestTemplate, testPathFor } from './make-test-templates.js';

/** Raised when a generator target already exists; the message is safe to echo. */
class MakeCommandError extends JsailsError {
  readonly code = 'duplicate_file';
}

/** Whether a token after `make:` names a supported generator. */
export function isMakeCommandType(value: string): value is MakeCommandType {
  return (MAKE_COMMAND_TYPES as readonly string[]).includes(value);
}

/** A name must be a leading letter followed by letters, digits, `_` or `-`. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Render the one-line `jsails make:<type> --help` summary. */
function makeHelp(type: MakeCommandType): string {
  if (type === 'content') {
    return `content - generate a content entry\n\nUsage:\n  jsails make:content <collection> <name> [--dir <path>]\n`;
  }
  if (type === 'server-component') {
    return `server-component - generate a server component\n\nUsage:\n  jsails make:server-component <name> [--dir <path>] [--mfc] [--no-test]\n`;
  }
  return `${type} - generate a ${type} file\n\nUsage:\n  jsails make:${type} <name> [--dir <path>] [--no-test]\n`;
}

export const GLOBAL_MAKE_HELP = `make - generate a single conventional file

Usage:
  jsails make:page <name>    Generate pages/<name>.tsx
  jsails make:api <name>     Generate api/<name>.ts
  jsails make:job <name>     Generate jobs/<name>.job.ts
  jsails make:model <name>   Generate models/<name>.ts
  jsails make:command <name>            Generate commands/<name>.ts
  jsails make:server-component <name>   Generate components/<name>.tsx [--mfc]
  jsails make:serializer <name>         Generate serializers/<name>.ts
  jsails make:middleware <name>         Generate middleware/<name>.ts
  jsails make:content <collection> <name>  Generate content/<collection>/<name>.md

Options:
  --dir <path>    Base directory (default: the current working directory)
  --mfc           Generate a multi-file component directory (server-component only)
  --no-test       Skip the companion test file
  -h, --help      Show this help
`;

/** Parse the tokens after `make:<type>` into a name and a base directory. */
interface MakeInvocation {
  readonly name: string;
  /** The content collection, present only for `make:content`. */
  readonly collection: string | undefined;
  readonly baseDir: string;
  /** Generate a multi-file component directory. Server-component only. */
  readonly mfc: boolean;
  /** Generate the companion test file. Defaults to true. */
  readonly withTest: boolean;
}

/** Parse the raw tokens: a name, an optional content collection, and one `--dir`. */
function parseMakeArgs(type: MakeCommandType, args: readonly string[]): MakeInvocation | number {
  let collection: string | undefined;
  let name: string | undefined;
  let baseDir: string | undefined;
  let mfc = false;
  let withTest = true;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--dir') {
      const value = args[index + 1];
      if (value === undefined || value === '') {
        return usageFailure(type, '--dir requires a directory');
      }
      if (baseDir !== undefined) {
        return usageFailure(type, '--dir specified more than once');
      }
      baseDir = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--dir=')) {
      const value = token.slice('--dir='.length);
      if (value === '') {
        return usageFailure(type, '--dir requires a directory');
      }
      if (baseDir !== undefined) {
        return usageFailure(type, '--dir specified more than once');
      }
      baseDir = value;
      continue;
    }
    if (token === '--mfc') {
      if (type !== 'server-component') {
        return usageFailure(type, '--mfc is only valid for make:server-component');
      }
      mfc = true;
      continue;
    }
    if (token === '--no-test') {
      withTest = false;
      continue;
    }
    if (token.startsWith('-')) {
      return usageFailure(type, `unknown option ${JSON.stringify(token)}`);
    }
    // `make:content` takes a collection before the name; every other type has
    // only a name, so the collection slot is skipped.
    if (type === 'content' && collection === undefined) {
      collection = token;
      continue;
    }
    if (name !== undefined) {
      return usageFailure(type, `unexpected argument ${JSON.stringify(token)}`);
    }
    name = token;
  }

  if (type === 'content' && collection === undefined) {
    return usageFailure(type, `make:content requires a collection and a name`);
  }
  if (name === undefined) {
    return usageFailure(type, `make:${type} requires a name`);
  }
  if (!NAME_PATTERN.test(name)) {
    return usageFailure(
      type,
      `invalid name ${JSON.stringify(name)}; names must match [A-Za-z][A-Za-z0-9_-]*`,
    );
  }
  if (collection !== undefined && !NAME_PATTERN.test(collection)) {
    return usageFailure(
      type,
      `invalid collection ${JSON.stringify(collection)}; collections must match [A-Za-z][A-Za-z0-9_-]*`,
    );
  }
  return { name, collection, baseDir: baseDir ?? '.', mfc, withTest };
}

function usageFailure(type: MakeCommandType, message: string): number {
  return usageError(
    (line) => console.error(line),
    `Run "jsails make:${type} --help" for usage.`,
    `make:${type}: ${message}`,
  );
}

/** Write `content` to `path`, refusing to overwrite an existing file. */
async function writeFileExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx' });
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new MakeCommandError(`refusing to overwrite existing file ${JSON.stringify(path)}`);
    }
    throw error;
  }
}

/**
 * Dispatch a `make:*` generator: parse the name and `--dir`, render the
 * conventional file, and write it exclusively. Returns the exit code.
 */
export async function runMakeCommand(
  type: MakeCommandType,
  args: readonly string[],
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(makeHelp(type));
    return 0;
  }

  const invocation = parseMakeArgs(type, args);
  if (typeof invocation === 'number') {
    return invocation;
  }

  const layout = GENERATOR_LAYOUT[type];
  const kebabName = kebabCase(invocation.name);
  const relativeTestPath = invocation.withTest ? testPathFor(type, kebabName) : undefined;
  const testPath =
    relativeTestPath === undefined ? undefined : resolve(invocation.baseDir, relativeTestPath);
  const testContent = renderTestTemplate(type, invocation.name, invocation.mfc);

  // Refuse before writing anything when the companion test already exists, so a
  // failed generation never leaves a half-written pair behind.
  if (testPath !== undefined && existsSync(testPath)) {
    console.error(
      `jsails make:${type}: refusing to overwrite existing file ${JSON.stringify(testPath)}`,
    );
    return 1;
  }

  // Multi-file component: render all four files into a directory.
  if (invocation.mfc) {
    const files = serverComponentMfcTemplate(invocation.name);
    const dir = resolve(invocation.baseDir, layout.dir, kebabName);
    for (const [relative, content] of Object.entries(files)) {
      const path = resolve(dir, relative);
      try {
        await writeFileExclusive(path, content);
      } catch (error) {
        if (error instanceof MakeCommandError) {
          console.error(`jsails make:${type}: ${error.message}`);
          return 1;
        }
        throw error;
      }
    }
    console.log(`Created ${dir}/`);
    if (testPath !== undefined && testContent !== undefined) {
      await writeFileExclusive(testPath, testContent);
      console.log(`Created ${testPath}`);
    }
    return 0;
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

  try {
    await writeFileExclusive(filePath, content);
    if (testPath !== undefined && testContent !== undefined) {
      await writeFileExclusive(testPath, testContent);
    }
  } catch (error) {
    if (error instanceof MakeCommandError) {
      console.error(`jsails make:${type}: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log(`Created ${filePath}`);
  if (testPath !== undefined && testContent !== undefined) {
    console.log(`Created ${testPath}`);
  }
  return 0;
}
