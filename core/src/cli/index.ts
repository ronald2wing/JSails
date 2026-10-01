#!/usr/bin/env node

/**
 * The `jsails` executable (`package.json` `bin`).
 *
 * Resolves the first token against the built-in command table, then either
 * hands the raw arguments to an `argv` command, validates the shared flags of a
 * `flags` command, or falls through to a project-defined command. Command
 * implementations are imported only once one is chosen, so `jsails --help`
 * and discovery stay free of TypeORM, BullMQ, Hono, Preact, Vite, and Jamal.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { AppConfigError, DEFAULT_APP_CONFIG_PATH } from '../app/config/schema.js';
import { formatError } from '../errors/inspect.js';
import {
  defaultConfigPath,
  findBuiltinCommand,
  installGlobals,
  usageFailure,
  type FlagCommand,
} from './builtin-commands.js';
import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
  type CliCommandContext,
  type CliCommandMetadata,
  type CliCommandRegistry,
} from './command-registry.js';
import { SignatureError } from './command-signature.js';
import { CommandDiscoveryError, discoverAppCommands } from './command-discovery.js';
import { GLOBAL_OPTIONS, invalidFlagMessage } from './global-flags.js';
import { renderGlobalHelp } from './global-help.js';

// ---------------------------------------------------------------------------
// Project commands: jsails <name> [--config <path>] [raw arguments]
// ---------------------------------------------------------------------------

interface ProjectInvocation {
  readonly configPath: string | undefined;
  readonly rawArgs: readonly string[];
}

/** Extract `--config` from a project command's arguments, leaving the rest raw. */
function parseProjectInvocation(rest: readonly string[]): ProjectInvocation | number {
  let configPath: string | undefined;
  const rawArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === '--') {
      rawArgs.push(...rest.slice(index));
      break;
    }
    if (token === '--config' || token.startsWith('--config=')) {
      if (configPath !== undefined) {
        return usageFailure('--config specified more than once');
      }
      if (token === '--config') {
        const value = rest[index + 1];
        if (value === undefined) {
          return usageFailure('--config requires a value');
        }
        configPath = value;
        index += 1;
      } else {
        configPath = token.slice('--config='.length);
      }
      continue;
    }
    rawArgs.push(token);
  }
  return { configPath, rawArgs };
}

/** Strip the global `-n` / `--no-interaction` flag before a project command sees it. */
function stripNoInteraction(args: readonly string[]): {
  readonly rawArgs: readonly string[];
  readonly interactive: boolean;
} {
  let interactive = true;
  const rawArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--') {
      rawArgs.push(...args.slice(index));
      break;
    }
    if (token === '--no-interaction' || token === '-n') {
      interactive = false;
      continue;
    }
    rawArgs.push(token);
  }
  return { rawArgs, interactive };
}

function isEchoableError(error: unknown): boolean {
  return (
    error instanceof CliCommandError ||
    error instanceof AppConfigError ||
    error instanceof SignatureError ||
    error instanceof CommandDiscoveryError
  );
}

function reportFailure(error: unknown): number {
  console.error(
    `jsails: ${formatError(error, { allow: isEchoableError, fallback: 'the command failed' })}`,
  );
  return 1;
}

function projectCommandHelp(command: string, metadata: readonly CliCommandMetadata[]): string {
  const entry = metadata.find((candidate) => candidate.name === command);
  const summary = entry?.summary ?? '';
  const usage = entry?.usage ?? entry?.name ?? command;
  const audience = entry?.audience === 'user' ? 'user command' : 'developer command';
  return `${command} - ${summary}\nAudience: ${audience}\n\nUsage:\n  jsails ${usage}\n`;
}

/** Commands discovered under `commands/` and `dist/commands/` of the working directory. */
async function discoverCommandsFromCwd(): Promise<CliCommand[]> {
  const cwd = process.cwd();
  const commands: CliCommand[] = [];
  for (const base of [cwd, join(cwd, 'dist')]) {
    commands.push(...(await discoverAppCommands(base)));
  }
  return commands;
}

async function globalHelp(): Promise<string> {
  let discovered: readonly CliCommand[] = [];
  try {
    discovered = await discoverCommandsFromCwd();
  } catch {
    // Help must print even when a command module is broken; the section then
    // reports that no user command was discovered.
  }
  return renderGlobalHelp(
    discovered
      .filter((command) => command.audience === 'user')
      .map((command) => `  ${command.name} - ${command.summary}`),
  );
}

async function runProjectCommand(command: string, rest: readonly string[]): Promise<number> {
  const invocation = parseProjectInvocation(rest);
  if (typeof invocation === 'number') {
    return invocation;
  }
  const configPath = invocation.configPath ?? DEFAULT_APP_CONFIG_PATH;
  const hasExplicitConfig = invocation.configPath !== undefined;
  const hasConfig = hasExplicitConfig || existsSync(resolve(configPath));

  // A discovered command or the app config may reference `defineCommand`,
  // `ApplicationRecord`, etc. by bare name, so globals precede any app import.
  await installGlobals(dirname(resolve(configPath)));

  let discovered: readonly CliCommand[];
  try {
    discovered = await discoverCommandsFromCwd();
  } catch (error) {
    return reportFailure(error);
  }

  // A user-audience command found on disk runs without loading the app config,
  // unless the caller asked for a specific config.
  const isDiscoveredUser =
    !hasExplicitConfig &&
    discovered.some((candidate) => candidate.name === command && candidate.audience === 'user');

  let config: unknown;
  let configCommands: readonly CliCommand[] = [];
  if (!isDiscoveredUser && hasConfig) {
    try {
      const { loadAppConfig } = await import('../app/config/index.js');
      config = await loadAppConfig(configPath);
      configCommands = collectConfigCommands(config);
    } catch (error) {
      return reportFailure(error);
    }
  }

  let registry: CliCommandRegistry;
  try {
    registry = createCliCommandRegistry(
      isDiscoveredUser ? discovered : [...configCommands, ...discovered],
    );
  } catch (error) {
    return reportFailure(error);
  }

  if (!registry.has(command)) {
    return usageFailure(`unknown command ${JSON.stringify(command)}`);
  }
  const { rawArgs, interactive } = stripNoInteraction(invocation.rawArgs);
  if (rawArgs.length === 1 && (rawArgs[0] === '--help' || rawArgs[0] === '-h')) {
    process.stdout.write(projectCommandHelp(command, registry.list()));
    return 0;
  }

  const context: CliCommandContext = {
    configPath: config
      ? (((config as Record<string, unknown>).configPath as string) ?? resolve(configPath))
      : resolve(configPath),
    cwd: process.cwd(),
    interactive,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
  try {
    return await registry.run(command, rawArgs, context);
  } catch (error) {
    return reportFailure(error);
  }
}

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
      console.error(`jsails: ${formatAppError(error)}`);
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

export async function runCli(argv: string[]): Promise<number> {
  // Assemble `process.env` from the developer's `.env` files before any command
  // logic runs, so validators and app code read one consistent environment.
  // `jsails test` defaults `NODE_ENV=test`, which selects `.env.testing`
  // instead of `.env.local`.
  const { assembleEnvironment } = await import('../dotenv.js');
  if (argv[0] === 'test' && process.env.NODE_ENV === undefined) {
    process.env.NODE_ENV = 'test';
  }
  // Help, project creation, and the credentials command itself never need the
  // app's secrets, so a missing key or a broken file must not stop them.
  const { CredentialsError } = await import('../credentials.js');
  const optionsEnd = argv.indexOf('--');
  const options = optionsEnd === -1 ? argv : argv.slice(0, optionsEnd);
  const needsCredentials =
    argv.length > 0 &&
    !options.includes('--help') &&
    !options.includes('-h') &&
    argv[0] !== 'create' &&
    argv[0] !== 'credentials';
  try {
    const credentials = assembleEnvironment({ credentials: needsCredentials });
    if (credentials.status === 'missing_key') {
      console.error(
        `jsails: config/credentials/${credentials.environment}.enc is present but no key was ` +
          'found; set JSAILS_CREDENTIALS_KEY or add the key file. Continuing without credentials.',
      );
    }
  } catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    console.error(`jsails: ${formatError(error)}`);
    return 1;
  }

  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith('-')) {
    return parseAndRunFlagCommand(argv);
  }
  const command = findBuiltinCommand(first);
  if (command === undefined) {
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
