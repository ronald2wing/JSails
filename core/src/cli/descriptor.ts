/**
 * The command descriptor: the one shape every `jsails` command has, whichever
 * of the three sources it comes from (the built-in manifest, a dependency's
 * `jsails.commands`, an app module under `dist/commands/`).
 *
 * A descriptor says what the dispatcher must know before it imports the
 * command: its options and positionals (the dispatcher parses argv against
 * them with `node:util` `parseArgs`, so an unknown flag is a usage error, and
 * generates the command's `--help` from them), what it needs set up first
 * (`needs`, the stages the dispatcher runs and disposes), and whether it opens
 * the sealed credentials. `load` imports the implementation, a module whose
 * `run` receives a {@link CommandContext}.
 *
 * Types only: the built-in manifest imports this module and must load nothing.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { SecretsRequirement } from '../environment/resolve.js';
import type { LoadedApp } from '../kernel/load-app.js';
import type { Services } from '../kernel/open-services.js';
import type { PluginGraph } from '../kernel/resolve-plugins.js';
import type { Kernel } from '../kernel/start.js';
import type { PluginRole } from '../plugins/contract/lifecycle.js';

/**
 * One option of a command: the `node:util` `parseArgs` option shape plus the
 * line its help prints.
 *
 * @public
 */
export interface CommandOption {
  readonly type: 'string' | 'boolean';
  /** One line for the command's help. */
  readonly summary: string;
  /** A one-letter alias (`-c`). */
  readonly short?: string;
  /** Whether the option may repeat; its value is then an array. */
  readonly multiple?: boolean;
  /** The placeholder help prints for a string option's value (`<path>`); defaults to `value`. */
  readonly value?: string;
}

/**
 * A command's options, by flag name (`'dry-run'` is `--dry-run`).
 *
 * @public
 */
export type CommandOptions = Readonly<Record<string, CommandOption>>;

/**
 * One positional argument of a command, in order.
 *
 * @public
 */
export interface CommandPositional {
  /** The name help prints (`<dir>`). */
  readonly name: string;
  /** One line for the command's help. */
  readonly summary: string;
  /** Whether it must be given; defaults to `true`. */
  readonly required?: boolean;
  /** Whether it takes every remaining token; only the last positional may. */
  readonly variadic?: boolean;
}

/**
 * What a command needs before it runs; each level includes the one before it.
 *
 * - `nothing`: the environment is not resolved (scaffolding, forwarding).
 * - `environment`: the environment is resolved and applied.
 * - `app`: the app config is loaded (`--config`, default `jsails.app.js`).
 * - `plugins`: its plugin graph is resolved.
 * - `{ services: roles }`: the plugins are set up for `roles`; closed after.
 * - `{ kernel: roles }`: their lifecycle units are started; shut down after.
 *
 * @public
 */
export type CommandNeeds =
  | 'nothing'
  | 'environment'
  | 'app'
  | 'plugins'
  | { readonly services: readonly PluginRole[] }
  | { readonly kernel: readonly PluginRole[] };

/** The value type `parseArgs` produces for one option. */
type OptionValue<Option extends CommandOption> = Option['type'] extends 'boolean'
  ? Option['multiple'] extends true
    ? readonly boolean[]
    : boolean
  : Option['multiple'] extends true
    ? readonly string[]
    : string;

/**
 * The parsed values of a command's options; an option not given is absent.
 *
 * @public
 */
export type CommandValues<O extends CommandOptions> = {
  readonly [K in keyof O]?: OptionValue<O[K]>;
};

/**
 * Interactive prompt helpers. A non-interactive invocation
 * (`--no-interaction`, a scheduled command) gets one that refuses.
 *
 * @public
 */
export interface Prompter {
  text(message: string, options?: { readonly default?: string }): Promise<string>;
  confirm(message: string, options?: { readonly default?: boolean }): Promise<boolean>;
  select<T extends string>(message: string, choices: readonly T[]): Promise<T>;
}

/** The stage values a `needs` level puts on the context. */
type StagesOf<N extends CommandNeeds> = N extends 'nothing' | 'environment'
  ? unknown
  : N extends 'app'
    ? { readonly app: LoadedApp }
    : N extends 'plugins'
      ? { readonly app: LoadedApp; readonly graph: PluginGraph }
      : N extends { readonly services: readonly PluginRole[] }
        ? { readonly app: LoadedApp; readonly graph: PluginGraph; readonly services: Services }
        : {
            readonly app: LoadedApp;
            readonly graph: PluginGraph;
            readonly services: Services;
            readonly kernel: Kernel;
          };

/**
 * The part of a {@link CommandContext} every command receives.
 *
 * @public
 */
export interface CommandInvocation<O extends CommandOptions = CommandOptions> {
  /** The command as typed (`make:page`). */
  readonly name: string;
  /** The parsed option values. */
  readonly values: CommandValues<O>;
  /** The positional arguments, in order (every token of a passthrough command). */
  readonly positionals: readonly string[];
  /** The working directory. */
  readonly cwd: string;
  /**
   * The variables of the environment the dispatcher resolved for this
   * command, with its `JSAILS_ENV` and `NODE_ENV`. A command that needs
   * nothing has none resolved and gets only `JSAILS_DEBUG`, when it is set.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The resolved environment's name; `undefined` when none was resolved. */
  readonly environment: string | undefined;
  /** Whether prompts are available (`--no-interaction` turns them off). */
  readonly interactive: boolean;
  /** Prompts; refuses every question when not {@link interactive}. */
  readonly prompter: Prompter;
  /** Write one line to standard output. */
  stdout(text: string): void;
  /** Write one line to standard error. */
  stderr(text: string): void;
  /** Report a usage error with this command's help hint; returns exit code 2. */
  usage(message: string): number;
}

/**
 * What a command's `run` receives: the invocation and the stages its `needs`
 * asked for.
 *
 * @public
 */
export type CommandContext<
  O extends CommandOptions = CommandOptions,
  N extends CommandNeeds = CommandNeeds,
> = CommandInvocation<O> & StagesOf<N>;

/**
 * A command implementation: what a descriptor's `load` resolves to.
 *
 * `preflight` runs after the environment is resolved and before any stage,
 * so a command can refuse before its config loads: it returns an exit code
 * to stop (a usage error through `context.usage`) or throws (a platform it
 * does not serve). `run` returns the exit code; nothing is 0.
 *
 * @internal
 */
export interface CommandModule<
  O extends CommandOptions = CommandOptions,
  N extends CommandNeeds = CommandNeeds,
> {
  preflight?(context: CommandInvocation<O>): number | void;
  run(context: CommandContext<O, N>): Awaitable<number | void>;
}

/**
 * A command the dispatcher can parse, document and run.
 *
 * @internal
 */
export interface CommandDescriptor<
  O extends CommandOptions = CommandOptions,
  N extends CommandNeeds = CommandNeeds,
> {
  /** The token that names it (`db:push`). */
  readonly name: string;
  /** One line for help. */
  readonly summary: string;
  /** Lines help prints under the options. */
  readonly details?: readonly string[];
  readonly options: O;
  readonly positionals?: readonly CommandPositional[];
  readonly needs: N;
  /** Whether it opens the sealed credentials (`credentials.missing_key` without a key). */
  readonly secrets: SecretsRequirement;
  /**
   * The tokens go to another program unparsed, `--help` included (`jamal`);
   * it declares no options or positionals.
   */
  readonly passthrough?: true;
  /**
   * The environment it runs as when neither `--env` nor `JSAILS_ENV` names
   * one, given its parsed values (`test` runs as `test`).
   */
  defaultEnvironment?(values: CommandValues<O>): string | undefined;
  load(): Promise<CommandModule<O, N>>;
}
