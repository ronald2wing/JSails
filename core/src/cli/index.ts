#!/usr/bin/env node

/**
 * The `jsails` executable (`package.json` `bin`).
 *
 * Resolves the first token against the built-in command table, then either
 * hands the raw arguments to an `argv` command, validates the shared flags of a
 * `flags` command, or falls through to a project-defined command. This module
 * and the table load nothing but argument parsing and the environment loader:
 * the global help, project-command discovery, and every command
 * implementation are imported only once they are chosen, so a start costs
 * what the chosen command needs and a usage error costs almost nothing.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { formatError } from '../errors/inspect.js';
import {
  defaultConfigPath,
  findBuiltinCommand,
  installGlobals,
  usageFailure,
  type FlagCommand,
} from './builtin-commands.js';
import { GLOBAL_OPTIONS, invalidFlagMessage } from './global-flags.js';

// ---------------------------------------------------------------------------
// Built-in `flags` commands
// ---------------------------------------------------------------------------

async function runFlagCommand(
  command: FlagCommand,
  configPath: string,
  values: Readonly<Record<string, unknown>>,
  positionals: readonly string[],
): Promise<number> {
  // The config module and everything it imports may reference
  // `ApplicationRecord`, `defineJob`, etc. by bare name.
  if (command.config !== 'none') {
    await installGlobals(dirname(resolve(configPath)));
  }
  try {
    const run = await command.load();
    return await run(configPath, values, positionals);
  } catch (error) {
    if (command.appErrors === true) {
      const { formatAppError } = await import('./commands/app.js');
      console.error(`jsails: ${await formatAppError(error)}`);
    } else {
      console.error(`jsails: ${formatError(error)}`);
    }
    return 1;
  }
}

async function parseAndRunFlagCommand(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: GLOBAL_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(formatError(error));
  }
  const { values, positionals } = parsed;

  if (values.help) {
    const { globalHelp } = await import('./global-help.js');
    process.stdout.write(await globalHelp());
    return 0;
  }

  const [name, ...rest] = positionals;
  if (name === undefined) {
    return usageFailure('a command is required');
  }
  const command = findBuiltinCommand(name);
  if (command?.kind !== 'flags') {
    return usageFailure(`unknown command ${JSON.stringify(name)}`);
  }
  if (command.positional === true && rest.length !== 1) {
    return usageFailure(`${name} requires a target directory: jsails ${command.usage ?? name}`);
  }
  if (command.positional !== true && rest.length > 0) {
    return usageFailure(`unexpected argument: ${rest.join(' ')}`);
  }
  const invalid = invalidFlagMessage(name, values);
  if (invalid !== undefined) {
    return usageFailure(invalid);
  }

  const configPath = values.config ?? defaultConfigPath(command.config) ?? '';
  return runFlagCommand(command, configPath, values, rest);
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

/** The steps of a production build, which run without the app's sealed secrets. */
const BUILD_COMMANDS: ReadonlySet<string> = new Set(['build', 'build:meta', 'inject:auto-imports']);

/**
 * The command `argv` names: the first token, or, when global flags come first
 * (`jsails --config app.js build`), the first positional, as
 * {@link parseAndRunFlagCommand} reads it. Unknown flags are tolerated here so
 * a malformed invocation still reaches the parser that reports it.
 */
function invokedCommandName(argv: readonly string[]): string | undefined {
  const [first] = argv;
  if (first === undefined || !first.startsWith('-')) return first;
  try {
    const { positionals } = parseArgs({
      args: [...argv],
      options: GLOBAL_OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    return positionals[0];
  } catch {
    return undefined;
  }
}

export async function runCli(argv: string[]): Promise<number> {
  // Assemble `process.env` from the developer's `.env` files before any command
  // logic runs, so validators and app code read one consistent environment.
  // `jsails test` defaults `NODE_ENV=test`, which selects `.env.testing`
  // instead of `.env.local`.
  const { assembleEnvironment, DotenvError } = await import('../dotenv.js');
  const commandName = invokedCommandName(argv);
  if (commandName === 'test' && process.env.NODE_ENV === undefined) {
    process.env.NODE_ENV = 'test';
  }
  // Help, project creation, and the credentials command itself never need the
  // app's secrets, so a missing key or a broken file must not stop them.
  const { CredentialsError } = await import('../credentials.js');
  const optionsEnd = argv.indexOf('--');
  const options = optionsEnd === -1 ? argv : argv.slice(0, optionsEnd);
  const isHelp = argv.length === 0 || options.includes('--help') || options.includes('-h');
  const needsCredentials = !isHelp && commandName !== 'create' && commandName !== 'credentials';
  try {
    const credentials = assembleEnvironment({ credentials: needsCredentials });
    if (credentials.status === 'missing_key') {
      const message =
        `config/credentials/${credentials.environment}.enc is present but no key was found; ` +
        `set JSAILS_CREDENTIALS_KEY or add config/credentials/${credentials.environment}.key`;
      // Outside development and test a command that runs without its sealed
      // secrets would serve, migrate, or work jobs half-configured, so it stops.
      // The build steps are exempt: they compile the app and never need its
      // secrets, and a CI build usually has no production key.
      if (
        !BUILD_COMMANDS.has(commandName ?? '') &&
        credentials.environment !== 'development' &&
        credentials.environment !== 'test'
      ) {
        console.error(`jsails: missing_key: ${message}`);
        return 1;
      }
      console.error(`jsails: ${message}. Continuing without credentials.`);
    }
  } catch (error) {
    if (!(error instanceof CredentialsError) && !(error instanceof DotenvError)) throw error;
    // A rejected `.env` file is refused before any value is applied, so the
    // commands that never read the app's environment run on the untouched
    // real environment; `credentials regenerate` reads the files itself and
    // refuses there.
    if (error instanceof DotenvError && !needsCredentials) {
      console.error(`jsails: warning: the .env files were not loaded: ${formatError(error)}`);
    } else {
      console.error(`jsails: ${formatError(error)}`);
      return 1;
    }
  }

  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith('-')) {
    return parseAndRunFlagCommand(argv);
  }
  const command = findBuiltinCommand(first);
  if (command === undefined) {
    const { runProjectCommand } = await import('./project-commands.js');
    return runProjectCommand(first, rest);
  }
  if (command.kind === 'argv') {
    return command.run(rest, first);
  }
  return parseAndRunFlagCommand(argv);
}

// ---------------------------------------------------------------------------
// Entry-point guard
// ---------------------------------------------------------------------------

function isMainModule(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return metaUrl === pathToFileURL(argv1).href;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`jsails: ${formatError(error)}`);
      process.exitCode = 1;
    });
}
