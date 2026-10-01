/**
 * Parse one command's argv against its descriptor with `node:util`
 * `parseArgs`: strict, so an unknown flag or a missing value is a usage
 * error, with `--help`/`-h` on every command and `--no-interaction`/`-n` on
 * the commands that run app code. Positionals are counted against the
 * descriptor's. A passthrough command's tokens are returned untouched.
 */

import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import type { CommandOptions, CommandPositional, CommandValues } from './descriptor.js';

/** What {@link parseCommandArgs} reads from a descriptor. */
export interface ParsableCommand {
  readonly name: string;
  readonly options: CommandOptions;
  readonly positionals?: readonly CommandPositional[];
  readonly passthrough?: true;
}

/** The outcome of parsing: values, a help request, or a usage message. */
export type ParsedArgs =
  | {
      readonly kind: 'run';
      readonly values: CommandValues<CommandOptions>;
      readonly positionals: readonly string[];
      readonly interactive: boolean;
    }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly message: string };

/** A built-in flag: a boolean with a one-letter alias. */
type BuiltinFlag = { readonly type: 'boolean'; readonly short: string; readonly summary: string };

/** The flag every command takes. */
export const HELP_OPTION: BuiltinFlag = Object.freeze({
  type: 'boolean',
  short: 'h',
  summary: 'Show this help',
} as const);

/** The flag a command that runs app code takes. */
export const NO_INTERACTION_OPTION: BuiltinFlag = Object.freeze({
  type: 'boolean',
  short: 'n',
  summary: 'Never prompt; a question fails the command',
} as const);

/** A flag as typed (`--dry-run`, `-c`), which a usage line may name. */
const FLAG_TOKEN = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * The usage line for one of `parseArgs`' own errors, or `undefined` when
 * `error` is not one. Node's messages quote what was typed, a stray
 * positional included, so only an unknown flag that looks like a flag is
 * named, and an option given the wrong kind of value only when it is one the
 * command declares.
 */
function parseArgsUsage(command: ParsableCommand, error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code } = error as Error & { readonly code?: unknown };
  switch (code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION': {
      const typed = /'([^']*)'/.exec(error.message)?.[1];
      return typed !== undefined && FLAG_TOKEN.test(typed)
        ? `unknown option ${typed}`
        : 'unknown option';
    }
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return `${command.name} takes no arguments`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE': {
      // Node names the option as declared; only a declared flag is repeated.
      const flag = /--([a-z0-9][a-z0-9-]*)/.exec(error.message)?.[1];
      if (flag === undefined || !(flag in command.options)) return 'an option has an invalid value';
      return command.options[flag]?.type === 'boolean'
        ? `--${flag} takes no value`
        : `--${flag} requires a value (write --${flag}=<value> for one that starts with -)`;
    }
    default:
      return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')
        ? 'invalid arguments'
        : undefined;
  }
}

/**
 * Parse `args` (the tokens after the command name) for `command`.
 * `interactiveFlag` adds `--no-interaction`.
 */
export function parseCommandArgs(
  command: ParsableCommand,
  args: readonly string[],
  interactiveFlag = false,
): ParsedArgs {
  if (command.passthrough === true) {
    return { kind: 'run', values: {}, positionals: [...args], interactive: true };
  }
  const options: ParseArgsOptionsConfig = { help: { type: 'boolean', short: 'h' } };
  if (interactiveFlag) options['no-interaction'] = { type: 'boolean', short: 'n' };
  for (const [flag, option] of Object.entries(command.options)) {
    options[flag] = {
      type: option.type,
      ...(option.short === undefined ? {} : { short: option.short }),
      ...(option.multiple === true ? { multiple: true } : {}),
    };
  }
  const declared = command.positionals ?? [];
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options,
      allowPositionals: declared.length > 0,
      strict: true,
    });
  } catch (error) {
    const message = parseArgsUsage(command, error);
    if (message === undefined) throw error;
    return { kind: 'usage', message };
  }
  const { help, 'no-interaction': noInteraction, ...values } = parsed.values;
  if (help === true) return { kind: 'help' };

  const required = declared.filter((positional) => positional.required !== false);
  const variadic = declared.at(-1)?.variadic === true;
  const given = parsed.positionals;
  if (given.length < required.length) {
    const missing = required[given.length] as CommandPositional;
    return { kind: 'usage', message: `${command.name} requires <${missing.name}>` };
  }
  if (!variadic && given.length > declared.length) {
    return {
      kind: 'usage',
      message: `${command.name} takes at most ${declared.length} argument(s)`,
    };
  }
  return {
    kind: 'run',
    values: values as CommandValues<CommandOptions>,
    positionals: given,
    interactive: noInteraction !== true,
  };
}
