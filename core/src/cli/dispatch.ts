/**
 * The dispatcher: from argv to a command's exit code.
 *
 * `jsails [--env <name>] <command> [options]`. `--env` is the one option
 * before the command; `--version` and `--help` stand alone. The command is
 * looked up in the built-in manifest, then among the dependencies'
 * `jsails.commands`, then under `dist/commands/` (`command-lookup.ts`); a name
 * two sources claim is refused rather than guessed, and so is a built-in's
 * name that a dependency or the app claims (`cli.reserved_command`), once its
 * argv parses. Then, in order:
 *
 * 1. its argv is parsed against its own options (`command-args.ts`): `--help`
 *    prints its generated help, an unknown flag is a usage error (exit 2);
 * 2. its environment is resolved and applied, unless it needs nothing;
 * 3. its module is loaded and its `preflight` runs;
 * 4. the stages its `needs` asks for are opened (`stages.ts`);
 * 5. it runs; the stages are closed whatever happens, and a failed close is
 *    reported alongside the run's own failure, never in its place; a failure
 *    is reported value-free.
 *
 * A dependency or app command is app code: its environment is resolved with
 * the sealed credentials before its module is imported, because what it
 * needs is only known once it is. Its help imports it without resolving
 * anything. Listing commands (`jsails --help`) imports nothing from the
 * project.
 *
 * This module's static imports are the manifest, the argument parser and the
 * usage line, so a usage error loads nothing else: help, the lookup of
 * commands that are not built in, the error registry and everything a
 * command needs are imported once the path that uses them is taken.
 */

import { DEBUG_OUTPUT_ENV } from '../environment/names.js';
import type { ResolvedEnvironment } from '../environment/resolve.js';
import { parseCommandArgs } from './command-args.js';
import type { ExternalCommand } from './command-lookup.js';
import type { DefinedCommand } from './define-command.js';
import type { CommandDescriptor, CommandInvocation, CommandNeeds, Prompter } from './descriptor.js';
import { BUILTIN_COMMANDS } from './manifest.js';
import type { OpenedStages } from './stages.js';
import { usageError } from './usage-error.js';

/** Where the dispatcher writes, and the directory it runs in. */
export interface DispatchIo {
  /** Write text to standard output as is. */
  stdout(text: string): void;
  /** Write one line to standard error. */
  stderr(line: string): void;
  readonly cwd: string;
}

/** The process's own streams and working directory. */
export function processIo(): DispatchIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (line) => process.stderr.write(`${line}\n`),
    cwd: process.cwd(),
  };
}

const BUILTINS: ReadonlyMap<string, CommandDescriptor> = new Map(
  BUILTIN_COMMANDS.map((command) => [command.name, command]),
);

const GLOBAL_HINT = 'Run "jsails --help" for usage.';

function globalUsage(io: DispatchIo, message: string): number {
  return usageError((line) => io.stderr(line), GLOBAL_HINT, message);
}

function commandUsage(io: DispatchIo, name: string, message: string): number {
  return usageError((line) => io.stderr(line), `Run "jsails ${name} --help" for usage.`, message);
}

/** The jsails version, read from core's `package.json` (never imported). */
export async function jsailsVersion(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { readonly version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

/**
 * The leading `--env <name>` (or `--env=<name>`): the environment name,
 * outranking `JSAILS_ENV`. Returns the name and the remaining tokens, or a
 * usage message.
 */
function takeEnvironmentFlag(
  argv: readonly string[],
): { readonly name: string | undefined; readonly rest: readonly string[] } | string {
  const [first, second] = argv;
  if (first === '--env') {
    if (second === undefined || second === '' || second.startsWith('-')) {
      return '--env requires an environment name';
    }
    return { name: second, rest: argv.slice(2) };
  }
  if (first?.startsWith('--env=') === true) {
    const name = first.slice('--env='.length);
    if (name === '') return '--env requires an environment name';
    return { name, rest: argv.slice(1) };
  }
  return { name: undefined, rest: argv };
}

/** The global help for the project at `cwd`; reads its files, imports none. */
async function globalHelp(cwd: string): Promise<string> {
  const [{ listExternalCommands }, { renderGlobalHelp }] = await Promise.all([
    import('./command-lookup.js'),
    import('./help.js'),
  ]);
  const builtins = new Set(BUILTINS.keys());
  return renderGlobalHelp(BUILTIN_COMMANDS, listExternalCommands(cwd, builtins));
}

/** Whether `args` ask for help before any `--`. */
function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  return options.includes('--help') || options.includes('-h');
}

/**
 * A prompter that opens the terminal on its first question, so a command that
 * never asks holds no stdin handle, and the handle it opened is released
 * when the command ends.
 */
async function lazyPrompter(): Promise<{ readonly prompter: Prompter; close(): void }> {
  let opened: (Prompter & { close(): void }) | undefined;
  const open = async (): Promise<Prompter> => {
    if (opened === undefined) {
      const { createPrompter } = await import('./prompter.js');
      opened = createPrompter();
    }
    return opened;
  };
  return {
    prompter: {
      text: async (message, options) => (await open()).text(message, options),
      confirm: async (message, options) => (await open()).confirm(message, options),
      select: async (message, choices) => (await open()).select(message, choices),
    },
    close: () => opened?.close(),
  };
}

/**
 * The variables of a command that needs no environment: only whether debug
 * output is asked for, which a failure report reads. Nothing is resolved for
 * such a command, so it is handed nothing it could mistake for resolved.
 */
function unresolvedVariables(): Readonly<Record<string, string | undefined>> {
  const debug = process.env[DEBUG_OUTPUT_ENV];
  return Object.freeze(debug === undefined ? {} : { [DEBUG_OUTPUT_ENV]: debug });
}

/** Where a command came from, which decides how its failures are reported. */
type CommandSource = 'builtin' | 'dependency' | 'app';

function isAppStage(needs: CommandNeeds): boolean {
  return needs !== 'nothing' && needs !== 'environment';
}

/** Report a failure the way its source calls for; resolves with the exit code. */
async function reportCommandFailure(
  error: unknown,
  io: DispatchIo,
  source: CommandSource,
  needs: CommandNeeds,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const write = (line: string): void => io.stderr(line);
  try {
    if (source !== 'builtin') {
      const [{ writeFailure }, { AppConfigError }, { isRegistryError }] = await Promise.all([
        import('./report.js'),
        import('../app/config/errors.js'),
        import('../errors/registry.js'),
      ]);
      // A dependency's or app's command may put anything in its own error's
      // message, so only framework errors, value-free by construction, are
      // echoed; the cause chain still says what it threw and where.
      await writeFailure(error, write, {
        env,
        cwd: io.cwd,
        allow: (thrown) => isRegistryError(thrown) || thrown instanceof AppConfigError,
        fallback: 'the command failed',
      });
      return 1;
    }
    if (isAppStage(needs)) {
      const { reportAppFailure } = await import('./commands/app.js');
      return await reportAppFailure(error, write, { env, cwd: io.cwd });
    }
    const { reportFailure } = await import('./report.js');
    return await reportFailure(error, write, { env, cwd: io.cwd });
  } catch {
    // The reporter itself could not load (a broken install): a fixed line
    // still says the command failed, without the message the reporter was
    // there to vet.
    io.stderr('jsails: the command failed, and its failure report could not be loaded');
    return 1;
  }
}

/** Resolve the environment, or print why it cannot be and return 1. */
async function resolveFor(
  io: DispatchIo,
  request: {
    readonly name: string | undefined;
    readonly defaultName: string | undefined;
    readonly secrets: 'required' | 'unused';
  },
): Promise<ResolvedEnvironment | number> {
  const { resolveCommandEnvironment } = await import('./stages.js');
  try {
    return await resolveCommandEnvironment({ rootDir: io.cwd, ...request });
  } catch (error) {
    const { environmentFailureLines } = await import('../environment/errors.js');
    const lines = environmentFailureLines(error);
    if (lines === undefined) throw error;
    for (const line of lines) io.stderr(line.startsWith('  ') ? line : `jsails: ${line}`);
    // An unreadable file keeps its errno error on `cause`: EISDIR and EACCES
    // call for different fixes, and only the chain tells them apart.
    if ((error as { readonly cause?: unknown }).cause !== undefined) {
      const { renderCauseChain } = await import('../errors/cause-chain.server.js');
      for (const line of renderCauseChain(error, { env: unresolvedVariables() })) io.stderr(line);
    }
    return 1;
  }
}

/** Check a command's exit code: nothing is 0, anything but an integer in 0..255 is refused. */
async function exitCodeOf(name: string, source: CommandSource, value: unknown): Promise<number> {
  const { commandExitCode } = await import('./exit-code.js');
  const code = commandExitCode(value);
  if (code !== undefined) return code;
  const { CliErrors } = await import('./errors.js');
  throw new CliErrors.Error('invalid_exit_code', { command: name, source });
}

/**
 * Refuse built-in `name` when a dependency or the app declares a command of
 * that name too: running the built-in in its place would leave the project's
 * command unrun with nothing said. Resolves with the exit code of the
 * refusal, or `undefined` when no source claims the name.
 */
async function refuseClaimedBuiltin(name: string, io: DispatchIo): Promise<number | undefined> {
  try {
    const { builtinClaimant } = await import('./command-sources.js');
    const source = builtinClaimant(name, io.cwd);
    if (source === undefined) return undefined;
    const { CliErrors } = await import('./errors.js');
    throw new CliErrors.Error('reserved_command', { command: name, source });
  } catch (error) {
    return reportCommandFailure(error, io, 'builtin', 'nothing', unresolvedVariables());
  }
}

/** What running a command came to, before its stages are closed. */
type RunOutcome = { readonly code: number } | { readonly error: unknown };

/**
 * Close `stages` after a run that came to `outcome`, then settle it: its exit
 * code, or its error. A failed close is thrown, never swallowed; when the run
 * failed too, both are thrown together, the run's own failure first and as
 * the cause, so a teardown failure cannot hide what the command hit.
 */
async function closeAfter(stages: OpenedStages, outcome: RunOutcome): Promise<number> {
  try {
    await stages.close();
  } catch (closeError) {
    if ('code' in outcome) throw closeError;
    throw new AggregateError([outcome.error, closeError], 'the command and its teardown failed', {
      cause: outcome.error,
    });
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.code;
}

interface RunOptions {
  readonly source: CommandSource;
  /** The name `--env` chose. */
  readonly environmentName: string | undefined;
  /** The environment already resolved for an external command, before its import. */
  readonly resolved?: ResolvedEnvironment;
}

/** Steps 1 to 5 for one descriptor. */
async function runDescriptor(
  descriptor: CommandDescriptor,
  args: readonly string[],
  io: DispatchIo,
  options: RunOptions,
): Promise<number> {
  const external = options.source !== 'builtin';
  const parsed = parseCommandArgs(descriptor, args, external);
  if (parsed.kind === 'help') {
    const { renderCommandHelp } = await import('./help.js');
    io.stdout(renderCommandHelp(descriptor, external));
    return 0;
  }
  if (parsed.kind === 'usage') return commandUsage(io, descriptor.name, parsed.message);
  if (!external) {
    const refused = await refuseClaimedBuiltin(descriptor.name, io);
    if (refused !== undefined) return refused;
  }

  let resolved = options.resolved;
  if (resolved === undefined && descriptor.needs !== 'nothing') {
    const outcome = await resolveFor(io, {
      name: options.environmentName,
      defaultName: descriptor.defaultEnvironment?.(parsed.values),
      secrets: descriptor.secrets,
    });
    if (typeof outcome === 'number') return outcome;
    resolved = outcome;
  }
  let env: Readonly<Record<string, string | undefined>> = unresolvedVariables();
  if (descriptor.needs === 'nothing' && options.environmentName !== undefined) {
    // Nothing is resolved here, but a program this command starts (jamal)
    // resolves its own environment: a leading --env names it through the
    // variable that program reads, outranking an inherited JSAILS_ENV.
    process.env['JSAILS_ENV'] = options.environmentName;
  }
  if (resolved !== undefined) {
    const { commandVariables } = await import('./stages.js');
    env = await commandVariables(resolved);
  }

  const prompts = await lazyPrompter();
  const prompter = parsed.interactive
    ? prompts.prompter
    : (await import('./prompter.js')).NON_INTERACTIVE_PROMPTER;
  const invocation: CommandInvocation = {
    name: descriptor.name,
    values: parsed.values,
    positionals: parsed.positionals,
    cwd: io.cwd,
    env,
    environment: resolved?.name,
    interactive: parsed.interactive,
    prompter,
    stdout: (text) => io.stdout(`${text}\n`),
    stderr: (text) => io.stderr(text),
    usage: (message) => commandUsage(io, descriptor.name, message),
  };
  try {
    const module = await descriptor.load();
    const refused = module.preflight?.(invocation);
    if (refused !== undefined) return refused;
    const [{ openStages }, { DEFAULT_APP_CONFIG_PATH }] = await Promise.all([
      import('./stages.js'),
      import('../app/config/defaults.js'),
    ]);
    const configValue = parsed.values['config'];
    const stages = await openStages(descriptor.needs, {
      cwd: io.cwd,
      configPath: typeof configValue === 'string' ? configValue : DEFAULT_APP_CONFIG_PATH,
      env,
    });
    let outcome: RunOutcome;
    try {
      outcome = {
        code: await exitCodeOf(
          descriptor.name,
          options.source,
          await module.run({ ...invocation, ...stages }),
        ),
      };
    } catch (error) {
      outcome = { error };
    }
    return await closeAfter(stages, outcome);
  } catch (error) {
    return reportCommandFailure(error, io, options.source, descriptor.needs, env);
  } finally {
    prompts.close();
  }
}

/** The descriptor of a dependency's or app's defined command. */
function definedDescriptor(name: string, defined: DefinedCommand): CommandDescriptor {
  return {
    name,
    summary: defined.summary,
    details: defined.details,
    options: defined.options,
    positionals: defined.positionals,
    needs: defined.needs,
    secrets: 'required',
    load: () => Promise.resolve({ run: (context) => defined.run(context as never) }),
  };
}

/**
 * Import an external command's module and check its default export. An app
 * command is app code, which may name the framework's and the project's
 * globals bare, so those are installed first; a package imports explicitly.
 */
async function importExternal(
  name: string,
  located: ExternalCommand,
  cwd: string,
): Promise<DefinedCommand> {
  if (located.kind === 'app') {
    const { installGlobals } = await import('./stages.js');
    await installGlobals(cwd);
  }
  const [{ importFile }, { createRequire }, { join }, { CliErrors }, { isDefinedCommand }] =
    await Promise.all([
      import('../support/project-paths.server.js'),
      import('node:module'),
      import('node:path'),
      import('./errors.js'),
      import('./define-command.js'),
    ]);
  const source = located.kind === 'dependency' ? located.command.packageName : located.relative;
  let module: { readonly default?: unknown };
  try {
    const file =
      located.kind === 'dependency'
        ? createRequire(join(cwd, 'package.json')).resolve(located.command.module)
        : located.file;
    module = await importFile(file);
  } catch (error) {
    throw new CliErrors.Error('load_failed', { command: name, source }, { cause: error });
  }
  if (!isDefinedCommand(module.default)) {
    throw new CliErrors.Error('invalid_command', { command: name, source, problem: 'not_defined' });
  }
  return module.default;
}

/** Run a dependency's or the app's command. */
async function runExternal(
  name: string,
  located: ExternalCommand,
  args: readonly string[],
  io: DispatchIo,
  environmentName: string | undefined,
): Promise<number> {
  const source: CommandSource = located.kind;
  const empty = unresolvedVariables();
  if (asksForHelp(args)) {
    try {
      const defined = await importExternal(name, located, io.cwd);
      const { renderCommandHelp } = await import('./help.js');
      io.stdout(renderCommandHelp(definedDescriptor(name, defined), true));
      return 0;
    } catch (error) {
      return reportCommandFailure(error, io, source, 'environment', empty);
    }
  }
  const resolved = await resolveFor(io, {
    name: environmentName,
    defaultName: undefined,
    secrets: 'required',
  });
  if (typeof resolved === 'number') return resolved;
  let defined: DefinedCommand;
  try {
    defined = await importExternal(name, located, io.cwd);
  } catch (error) {
    return reportCommandFailure(error, io, source, 'environment', empty);
  }
  if (located.kind === 'app') {
    const { recordAppCommandSummary } = await import('./command-lookup.js');
    try {
      recordAppCommandSummary(io.cwd, located.relative, defined.summary);
    } catch {
      // The summary cache only feeds help; a project whose `.jsails/` cannot
      // be written still runs its commands, and help shows no summary.
    }
  }
  return runDescriptor(definedDescriptor(name, defined), args, io, {
    source,
    environmentName,
    resolved,
  });
}

/** Run `jsails` with `argv` (the tokens after the bin) and resolve with its exit code. */
export async function dispatch(
  argv: readonly string[],
  io: DispatchIo = processIo(),
): Promise<number> {
  const taken = takeEnvironmentFlag(argv);
  if (typeof taken === 'string') return globalUsage(io, taken);
  const [first, ...rest] = taken.rest;
  if (first === undefined || first === '--help' || first === '-h') {
    if (rest.length > 0) return globalUsage(io, '--help takes no arguments');
    io.stdout(await globalHelp(io.cwd));
    return 0;
  }
  if (first === '--version') {
    if (rest.length > 0) return globalUsage(io, '--version takes no arguments');
    io.stdout(`${await jsailsVersion()}\n`);
    return 0;
  }
  if (first.startsWith('-')) {
    return globalUsage(io, 'only --env, --version and --help come before the command');
  }

  const builtin = BUILTINS.get(first);
  if (builtin !== undefined) {
    return runDescriptor(builtin, rest, io, { source: 'builtin', environmentName: taken.name });
  }
  const { locateExternal } = await import('./command-lookup.js');
  let located: ExternalCommand | undefined;
  try {
    located = await locateExternal(first, io.cwd);
  } catch (error) {
    return reportCommandFailure(error, io, 'builtin', 'nothing', unresolvedVariables());
  }
  if (located === undefined) {
    return globalUsage(
      io,
      /^[a-z][a-z0-9:-]{0,63}$/.test(first) ? `unknown command ${first}` : 'unknown command',
    );
  }
  return runExternal(first, located, rest, io, taken.name);
}
