/**
 * The built-in command table: every command the `jsails` bin owns, with the
 * help line it prints and a lazy entry point.
 *
 * The table is the single source for command names, help rows, and dispatch,
 * so a command cannot be listed without being reachable (or the reverse).
 * Importing it is cheap: each entry's implementation sits behind a dynamic
 * `import()` that runs only when that command is dispatched, which keeps
 * `jsails --help` and custom-command discovery free of TypeORM, BullMQ, Hono,
 * Preact, Vite, and Jamal.
 *
 * Commands come in two shapes:
 *
 * - `argv` commands own their argument parsing and receive the raw tokens after
 *   the command name (`jamal`, `plugins`, `inspect`, `make:*`, ...).
 * - `flags` commands share the global option set parsed by `runCli`, and read
 *   a config module whose default path follows from {@link CommandConfigType}.
 */

import { DEFAULT_APP_CONFIG_PATH } from '../app/config/schema.js';
import { MAKE_COMMAND_TYPES } from '../compiler/conventions.js';
import {
  DEFAULT_DATABASE_CONFIG_PATH,
  DEFAULT_RUNTIME_CONFIG_PATH,
  DEFAULT_SEED_CONFIG_PATH,
} from '../config-modules.js';
import type { CommandConfigType } from '../extensions/plugin-contract.js';
import { usageError } from './usage-error.js';
import { flagValue } from './global-flags.js';

/** Runner for a `flags` command, called once its flags passed validation. */
type FlagCommandRunner = (
  configPath: string,
  values: Readonly<Record<string, unknown>>,
  positionals: readonly string[],
) => Promise<number>;

interface BuiltinCommandBase {
  /** The command token, or the token prefix for a `make:<type>` family. */
  readonly name: string;
  /** The left help column; defaults to `name`. */
  readonly usage?: string;
  readonly summary: string;
  /** Extra help lines printed under the summary. */
  readonly details?: readonly string[];
}

/** A command that parses its own arguments. */
export interface ArgvCommand extends BuiltinCommandBase {
  readonly kind: 'argv';
  /** Run with the tokens after the command; `token` is the command as typed. */
  readonly run: (args: readonly string[], token: string) => Promise<number>;
}

/** A command driven by the shared global flags and a config module. */
export interface FlagCommand extends BuiltinCommandBase {
  readonly kind: 'flags';
  readonly config: CommandConfigType;
  /** Whether the command takes one positional argument (`create <dir>`). */
  readonly positional?: boolean;
  /** Whether a failure is reported through the app error formatter. */
  readonly appErrors?: boolean;
  readonly load: () => Promise<FlagCommandRunner>;
}

export type BuiltinCommand = ArgvCommand | FlagCommand;

/**
 * Install the framework globals, then the project's generated globals.
 *
 * A bare identifier in app code (`ApplicationRecord`, a user's `Author`)
 * resolves against `globalThis` at module-evaluation time, so both sets must be
 * installed before any app module is imported. `rootDir` is the directory that
 * holds `.jsails/project-symbols.js`: the config module's directory, or the
 * working directory for commands that read no config path.
 */
export async function installGlobals(rootDir: string): Promise<void> {
  const { installFrameworkSymbols, installProjectSymbols } =
    await import('../symbols/install-server.js');
  await installFrameworkSymbols(rootDir);
  await installProjectSymbols(rootDir);
}

/** Report a usage error on stderr with the global help hint; returns exit code 2. */
export function usageFailure(message: string): number {
  return usageError((line) => console.error(line), 'Run "jsails --help" for usage.', message);
}

/** The config module a `flags` command reads when `--config` is absent. */
export function defaultConfigPath(config: CommandConfigType): string | undefined {
  switch (config) {
    case 'app':
      return DEFAULT_APP_CONFIG_PATH;
    case 'database':
      return DEFAULT_DATABASE_CONFIG_PATH;
    case 'runtime':
      return DEFAULT_RUNTIME_CONFIG_PATH;
    case 'seed':
      return DEFAULT_SEED_CONFIG_PATH;
    case 'none':
      return undefined;
  }
}

/** Built-in commands in help order. */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = Object.freeze([
  {
    kind: 'flags',
    name: 'db:push',
    summary: 'Diff the declared model schema against the live DB and apply the plan',
    config: 'database',
    load: async () => {
      const { runDbPush } = await import('./commands/db.js');
      return (configPath, values) =>
        runDbPush(configPath, {
          dryRun: Boolean(values['dry-run']),
          allowDestructive: Boolean(values['allow-destructive']),
          appConfigPath: values['app-config'] as string | undefined,
        });
    },
  },
  {
    kind: 'flags',
    name: 'db:diff',
    summary: 'Diff the declared model schema against the live DB (read-only)',
    config: 'database',
    load: async () => {
      const { runDbDiff } = await import('./commands/db.js');
      return (configPath, values) =>
        runDbDiff(configPath, {
          sql: Boolean(values.sql),
          appConfigPath: values['app-config'] as string | undefined,
        });
    },
  },
  {
    kind: 'flags',
    name: 'work',
    summary: 'Run the job worker (registering schedules, then processing jobs)',
    config: 'runtime',
    load: async () => {
      const { runRuntimeCommand } = await import('./commands/runtime.js');
      return (configPath) => runRuntimeCommand('work', configPath);
    },
  },
  {
    kind: 'flags',
    name: 'schedule',
    summary: 'Register schedules once, then exit',
    config: 'runtime',
    load: async () => {
      const { runRuntimeCommand } = await import('./commands/runtime.js');
      return (configPath) => runRuntimeCommand('schedule', configPath);
    },
  },
  {
    kind: 'flags',
    name: 'build',
    summary: 'Render the static site into the configured output directory',
    config: 'app',
    appErrors: true,
    load: async () => {
      const { runAppCommand } = await import('./commands/app.js');
      return (configPath) => runAppCommand('build', configPath);
    },
  },
  {
    kind: 'argv',
    name: 'build:meta',
    summary: 'Generate .jsails/ artifacts (models, components, autoload) before tsc',
    run: async (args) => {
      const { runMetaCommand } = await import('./commands/build-meta.js');
      return runMetaCommand({ dir: flagValue(args, '--dir') });
    },
  },
  {
    kind: 'argv',
    name: 'inject:auto-imports',
    summary: 'Inject scoped Preact imports into compiled server output',
    run: async (args) => {
      const dir = flagValue(args, '--dir');
      const { runAutoImportCommand } = await import('./commands/inject-auto-imports.js');
      return runAutoImportCommand(dir === undefined ? {} : { dir });
    },
  },
  {
    kind: 'flags',
    name: 'serve',
    summary: 'Run the HTTP server until SIGINT/SIGTERM',
    config: 'app',
    appErrors: true,
    load: async () => {
      const { runAppCommand } = await import('./commands/app.js');
      return (configPath) => runAppCommand('serve', configPath);
    },
  },
  {
    kind: 'flags',
    name: 'seed',
    summary: 'Run registered database seeders (filter with --only <name>)',
    config: 'seed',
    load: async () => {
      const { runSeedCommand } = await import('./commands/seed.js');
      return (configPath, values) =>
        runSeedCommand(configPath, { names: values.only as readonly string[] | undefined });
    },
  },
  {
    kind: 'flags',
    name: 'queue',
    summary: 'Print queue metrics (--json for machine-readable output)',
    config: 'runtime',
    load: async () => {
      const { runQueueCommand } = await import('./commands/queue.js');
      return (configPath, values) => runQueueCommand(configPath, { json: Boolean(values.json) });
    },
  },
  {
    kind: 'flags',
    name: 'schedules',
    summary: 'List registered schedules (--json for machine-readable output)',
    config: 'runtime',
    load: async () => {
      const { runSchedulesCommand } = await import('./commands/schedules.js');
      return (configPath, values) =>
        runSchedulesCommand(configPath, { json: Boolean(values.json) });
    },
  },
  {
    kind: 'flags',
    name: 'create',
    usage: 'create <dir>',
    summary: 'Scaffold a fresh JSails starter application',
    config: 'none',
    positional: true,
    load: async () => {
      const { runCreateCommand, parsePackageDependencyFlags } =
        await import('./commands/create.js');
      return (_configPath, values, positionals) =>
        runCreateCommand(positionals[0] as string, {
          name: values.name as string | undefined,
          jsailsDependency: values['jsails-dependency'] as string | undefined,
          packageDependencies: parsePackageDependencyFlags(
            values['package-dependency'] as readonly string[] | undefined,
          ),
          install: Boolean(values.install),
          git: values['no-git'] !== true,
          admin: Boolean(values.admin),
          blog: Boolean(values.blog),
          saas: Boolean(values.saas),
          cli: Boolean(values.cli),
          starter: Boolean(values.starter),
        });
    },
  },
  {
    kind: 'flags',
    name: 'dev',
    summary: 'Compile, watch, and serve the app for development',
    config: 'app',
    appErrors: true,
    load: async () => {
      const { runDevCommand } = await import('./commands/app.js');
      return (configPath) => runDevCommand(configPath);
    },
  },
  {
    kind: 'argv',
    name: 'make',
    usage: `make:<${MAKE_COMMAND_TYPES.join('|')}>`,
    summary: 'Generate a single conventional file (e.g. make:model blog-post)',
    run: async (args, token) => {
      const { GLOBAL_MAKE_HELP, isMakeCommandType, runMakeCommand } =
        await import('./commands/make.js');
      if (token === 'make') {
        process.stdout.write(GLOBAL_MAKE_HELP);
        return 0;
      }
      const type = token.slice('make:'.length);
      if (!isMakeCommandType(type)) {
        return usageFailure(`unknown command ${JSON.stringify(token)}`);
      }
      return runMakeCommand(type, args);
    },
  },
  {
    kind: 'argv',
    name: 'convert:component',
    summary: 'Convert a component between single-file and multi-file shapes',
    run: async (args) => {
      const { runConvertCommand } = await import('./commands/convert-component.js');
      return runConvertCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'jamal',
    usage: 'jamal <dev|deploy>',
    summary: 'Plan Docker/Kamal deployment files (write with --write)',
    run: async (args) => {
      // Jamal loads the app config (deploy generators, app name), which may
      // reference framework globals by bare name.
      await installGlobals(process.cwd());
      const { runJamalCommand } = await import('../jamal/command.js');
      return runJamalCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'test',
    summary: 'Boot the test DB, reconcile the schema, and run node --test',
    run: async (args) => {
      // The test runner loads the app config and reconciles the test database;
      // both may reference framework globals by bare name.
      await installGlobals(process.cwd());
      const { runTestCommand } = await import('./commands/test.js');
      return runTestCommand({
        config: flagValue(args, '--config'),
        noServices: args.includes('--no-services'),
        watch: args.includes('--watch'),
        testFile: flagValue(args, '--test-file'),
      });
    },
  },
  {
    kind: 'argv',
    name: 'plugins',
    summary: 'Discover, check, and manage installed JSails plugins',
    details: [
      '(list | check | resolve | install | enable | disable | uninstall | rollback | export | import)',
    ],
    run: async (args) => {
      const { runPluginsCommand } = await import('./commands/plugins/index.js');
      return runPluginsCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'inspect',
    summary: 'Introspect the application (routes ...)',
    run: async (args) => {
      const { runInspectCommand } = await import('./commands/inspect.js');
      return runInspectCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'describe',
    summary: "Compose a machine-readable snapshot of the app's definition",
    run: async (args) => {
      const { runDescribeCommand } = await import('./commands/describe.js');
      return runDescribeCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'explain',
    usage: 'explain <path>',
    summary: 'Resolve which route handles a path and show its pipeline stages',
    run: async (args) => {
      const { runExplainCommand } = await import('./commands/explain.js');
      return runExplainCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'app:shape',
    usage: 'app:shape <shape>',
    summary: 'Report live-only plugins for a given deployment shape (static|full|cli)',
    run: async (args) => {
      const { runAppShapeCommand } = await import('./commands/app-shape.js');
      return runAppShapeCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'mcp',
    summary: 'Start the MCP introspection server (Model Context Protocol over stdio)',
    run: async (args) => {
      const { runMcpCommand } = await import('./commands/mcp.js');
      return runMcpCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'agents:setup',
    summary: 'Emit agent files (.mcp.json, AGENTS.md) so an AI agent can drive this app',
    run: async (args) => {
      const { runAgentsSetupCli } = await import('./commands/agents-setup.js');
      return runAgentsSetupCli(args);
    },
  },
  {
    kind: 'argv',
    name: 'i18n:missing',
    summary: 'Report translation keys used in code but absent from catalogs',
    run: async (args) => {
      const { runI18nMissingCommand } = await import('./commands/i18n-missing.js');
      return runI18nMissingCommand(args);
    },
  },
  {
    kind: 'flags',
    name: 'live:list',
    summary: 'List live publications (name, collection, and authorize presence)',
    config: 'app',
    appErrors: true,
    load: async () => {
      const { runLiveListCommand } = await import('./commands/live-list.js');
      return (configPath) => runLiveListCommand(configPath);
    },
  },
  {
    kind: 'argv',
    name: 'credentials',
    usage: 'credentials <edit|show|regenerate>',
    summary: 'Edit, list, or re-seal the encrypted per-environment credentials',
    run: async (args) => {
      const { runCredentialsCommand } = await import('./commands/credentials.js');
      return runCredentialsCommand(args);
    },
  },
  {
    kind: 'argv',
    name: 'console',
    summary: 'Start an interactive REPL with the application loaded',
    run: async (args) => {
      const { runConsole } = await import('./commands/console.js');
      return runConsole(args);
    },
  },
] satisfies readonly BuiltinCommand[]);

const COMMANDS_BY_NAME: ReadonlyMap<string, BuiltinCommand> = new Map(
  BUILTIN_COMMANDS.map((command) => [command.name, command]),
);

/** The built-in command a token names (`make:<type>` resolves to `make`). */
export function findBuiltinCommand(token: string): BuiltinCommand | undefined {
  return COMMANDS_BY_NAME.get(token.startsWith('make:') ? 'make' : token);
}
