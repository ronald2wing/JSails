/**
 * Project commands: `jsails <name> [--config <path>] [raw arguments]` for a
 * name the built-in table does not own.
 *
 * The command is found among the project's discovered commands and those its
 * app config declares. A user-audience command found on disk runs without
 * loading the app config; any other loads it, and with it the config schema.
 * The dispatcher imports this module only once the first token names no
 * built-in command, so built-in commands never pay for discovery.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DEFAULT_APP_CONFIG_PATH } from '../app/config/defaults.js';
import { AppConfigError } from '../app/config/errors.js';
import { formatError } from '../errors/inspect.js';
import { installGlobals, usageFailure } from './builtin-commands.js';
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
import { CommandDiscoveryError, discoverProjectCommands } from './command-discovery.js';

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

/**
 * Run a command the project defines: one discovered on disk or declared by
 * the app config (or a plugin it uses).
 */
export async function runProjectCommand(command: string, rest: readonly string[]): Promise<number> {
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
    discovered = await discoverProjectCommands();
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
      const { loadAppConfig } = await import('../app/config/load.js');
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
