/**
 * `jsails console` — an interactive REPL for poking the database, calling
 * models, inspecting config, and running jobs interactively (Rails `rails
 * console` / Laravel `artisan tinker` equivalent).
 *
 * `--config` (default `jsails.database.js`) and `--runtime-config` (default
 * `jsails.runtime.js`) are optional. Both flags are optional. When the db config exists, the data source is
 * initialized before the REPL opens and destroyed afterward; when absent, the
 * DB is skipped and the REPL still opens. The runtime config is optional and
 * builds a jobs runtime (reusing the same loader `schedule`/`queue`/`schedules`
 * use) — the runtime is closed when the REPL exits.
 *
 * The REPL context object exposes:
 *   db       — the initialized DataSource, or undefined
 *   models   — a map of entity name -> repository (from entityMetadatas)
 *   config   — the loaded module defaults ({ db: ..., runtime: ... })
 *   jobs     — the JobsRuntime, or undefined
 *
 * All errors are value-free: a bad config path or failed init surfaces a
 * stable code + generic message, never file contents or credentials.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { start, type REPLServer } from 'node:repl';

import { loadDataSourceConfig } from '../config-loader.js';
import type { Awaitable } from '../../contracts/awaitable.js';
import type { JsailsDataSource } from '../../database/data-source.js';
import type { CommandModule } from '../descriptor.js';
import type { CONSOLE_OPTIONS } from '../manifest.js';
import { writeFailure } from '../report.js';
import { installGlobals } from '../stages.js';
import type { ResolvedRuntimeConfig } from '../../jobs/runtime-config.js';
import type { JobsRuntime } from '../../jobs/runtime.js';
import { DEFAULT_DATABASE_CONFIG_PATH, DEFAULT_RUNTIME_CONFIG_PATH } from '../../config-modules.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed `console` command options. */
export interface ConsoleOptions {
  /** Path to the database config (default `jsails.database.js`). */
  readonly configPath?: string;
  /** Path to the runtime config (default `jsails.runtime.js`). */
  readonly runtimePath?: string;
}

/** The REPL surface the command drives; testable via injection. */
export interface ConsoleRepl {
  /** A promise that resolves when the REPL exits. */
  readonly closed: Promise<void>;
  /** The REPL context object (populated before the prompt appears). */
  readonly context: Record<string, unknown>;
  /** Close the REPL programmatically (idempotent, best-effort). */
  close(): void;
}

/** Dependency seam for the console command. Tests inject fakes for I/O. */
export interface ConsoleDeps {
  /** The environment a failure report reads `JSAILS_DEBUG` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Write a line to stdout. */
  stdout(text: string): void;
  /** Write a line to stderr. */
  stderr(text: string): void;
  /** Load a data source from a config path; returns undefined when the file does not exist. */
  loadDataSource(configPath: string): Promise<JsailsDataSource | undefined>;
  /** Load a resolved runtime config; returns undefined when the file does not exist. */
  loadRuntimeConfig(configPath: string): Promise<ResolvedRuntimeConfig | undefined>;
  /** Build a jobs runtime from a resolved config. */
  createRuntime(config: ResolvedRuntimeConfig): Awaitable<JobsRuntime>;
  /** Start the REPL with the given context object. */
  startRepl(context: Record<string, unknown>): ConsoleRepl;
}

// ---------------------------------------------------------------------------
// Default dependencies (real I/O, real node:repl)
// ---------------------------------------------------------------------------

async function defaultLoadDataSource(configPath: string): Promise<JsailsDataSource | undefined> {
  return existsSync(resolve(configPath)) ? loadDataSourceConfig(configPath) : undefined;
}

async function defaultLoadRuntimeConfig(
  configPath: string,
): Promise<ResolvedRuntimeConfig | undefined> {
  if (!existsSync(resolve(configPath))) {
    return undefined;
  }
  const { loadResolvedRuntimeConfig } = await import('../../jobs/runtime-config.js');
  return loadResolvedRuntimeConfig(configPath);
}

function defaultStartRepl(context: Record<string, unknown>): ConsoleRepl {
  const server: REPLServer = start({ prompt: 'jsails> ', terminal: true, useColors: true });
  // Copy context entries into the REPL server context.
  for (const [key, value] of Object.entries(context)) {
    server.context[key] = value;
  }
  let closedResolve: () => void;
  const closed = new Promise<void>((resolveFn) => {
    closedResolve = resolveFn;
  });
  server.on('exit', () => closedResolve());
  return {
    closed,
    get context() {
      // A snapshot, so REPL-side mutations are visible without aliasing the live object.
      return { ...server.context };
    },
    close() {
      try {
        server.close();
      } catch {
        // The REPL may already be closed; swallow.
      }
    },
  };
}

const defaultConsoleDeps: Omit<ConsoleDeps, 'env'> = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  loadDataSource: defaultLoadDataSource,
  loadRuntimeConfig: defaultLoadRuntimeConfig,
  async createRuntime(config) {
    const { JobsRuntimeImpl } = await import('../../jobs/runtime.js');
    return new JobsRuntimeImpl({
      registry: config.registry,
      adapter: config.adapter,
      queueName: config.queueName,
      prefix: config.prefix,
      concurrency: config.concurrency,
    });
  },
  startRepl: defaultStartRepl,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

interface BootContext {
  db: JsailsDataSource | undefined;
  models: Record<string, unknown>;
  config: Record<string, unknown>;
  jobs: JobsRuntime | undefined;
  /** The runtime config's Valkey connections, closed after the runtime. */
  closeRuntimeConfig: () => Promise<void>;
}

async function bootContext(options: ConsoleOptions, deps: ConsoleDeps): Promise<BootContext> {
  const configRecords: Record<string, unknown> = {};

  // 1. Data source.
  let db: JsailsDataSource | undefined;
  let models: Record<string, unknown> = {};
  try {
    db = await deps.loadDataSource(options.configPath ?? DEFAULT_DATABASE_CONFIG_PATH);
  } catch (error) {
    await writeFailure(error, (line) => deps.stderr(line), {
      env: deps.env,
      label: 'failed to load db config',
    });
    // Continue: the REPL still opens without a database.
  }
  if (db !== undefined) {
    try {
      await db.initialize();
      configRecords.db = {
        initialized: true,
        options: { type: db.options.type, database: db.options.database },
      };
      const modelMap: Record<string, unknown> = {};
      for (const meta of db.entityMetadatas) {
        // Store the entity constructor/name so callers can do `models.User.find()`.
        modelMap[meta.name] = meta.target;
      }
      models = modelMap;
    } catch (error) {
      await writeFailure(error, (line) => deps.stderr(line), {
        env: deps.env,
        label: 'failed to initialize data source',
      });
      db = undefined;
    }
  }

  // 2. Runtime config + jobs runtime.
  let jobs: JobsRuntime | undefined;
  let closeRuntimeConfig = (): Promise<void> => Promise.resolve();
  try {
    const rtConfig = await deps.loadRuntimeConfig(
      options.runtimePath ?? DEFAULT_RUNTIME_CONFIG_PATH,
    );
    if (rtConfig !== undefined) {
      closeRuntimeConfig = async () => {
        await rtConfig.valkey?.close();
      };
      configRecords.runtime = {
        queueName: rtConfig.queueName,
        scheduleCount: rtConfig.schedules.length,
      };
      jobs = await deps.createRuntime(rtConfig);
    }
  } catch (error) {
    await writeFailure(error, (line) => deps.stderr(line), {
      env: deps.env,
      label: 'failed to load runtime config',
    });
    // Continue: the REPL still opens without a jobs runtime.
  }

  return { db, models, config: configRecords, jobs, closeRuntimeConfig };
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner(ctx: BootContext, deps: ConsoleDeps): void {
  const lines: string[] = ['JSails interactive console'];
  if (ctx.db !== undefined) {
    const entityCount = Object.keys(ctx.models).length;
    lines.push(`  Database: connected (${entityCount} model(s))`);
  } else {
    lines.push('  Database: not available');
  }
  if (ctx.jobs !== undefined) {
    lines.push('  Jobs: ready');
  } else {
    lines.push('  Jobs: not available');
  }
  lines.push('');
  lines.push('Type .exit to quit, .help for REPL commands.');
  for (const line of lines) {
    deps.stdout(line);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the `jsails console` command.
 *
 * @param options  The config paths (each defaults to its conventional module).
 * @param deps     Injected dependencies. The `startRepl` seam is the injection
 *                 point for tests — supply a fake REPL to inspect the context
 *                 without a real TTY.
 */
export async function runConsole(options: ConsoleOptions, deps: ConsoleDeps): Promise<number> {
  const parsed = {
    configPath: options.configPath ?? DEFAULT_DATABASE_CONFIG_PATH,
    runtimePath: options.runtimePath ?? DEFAULT_RUNTIME_CONFIG_PATH,
  };

  // Reject .ts config paths (compile first).
  for (const [label, path] of [
    ['--config', parsed.configPath],
    ['--runtime-config', parsed.runtimePath],
  ] as const) {
    if (/\.(?:ts|mts|cts)$/.test(path)) {
      deps.stderr(
        `jsails: ${label} "${path}" is a TypeScript module; compile it to JavaScript first ` +
          `(e.g. tsc) and point ${label} at the compiled output`,
      );
      return 1;
    }
  }

  const ctx = await bootContext(
    { configPath: parsed.configPath, runtimePath: parsed.runtimePath },
    deps,
  );

  const replContext: Record<string, unknown> = {
    db: ctx.db,
    models: ctx.models,
    config: ctx.config,
    jobs: ctx.jobs,
  };

  printBanner(ctx, deps);

  const repl = deps.startRepl(replContext);

  // Wait for the REPL to exit, then tear down.
  await repl.closed;

  // Teardown: destroy the data source and close the jobs runtime.
  // Both are best-effort: a teardown error is swallowed so exit is clean.
  if (ctx.db !== undefined) {
    try {
      await ctx.db.destroy();
    } catch {
      // Swallow: the process is exiting.
    }
  }
  if (ctx.jobs !== undefined) {
    try {
      await ctx.jobs.close();
    } catch {
      // Swallow.
    }
  }
  try {
    await ctx.closeRuntimeConfig();
  } catch {
    // Swallow: the process is exiting.
  }

  return 0;
}

/** `jsails console`. */
export const consoleCommand: CommandModule<typeof CONSOLE_OPTIONS, 'environment'> = {
  async run(context) {
    // The configs and the models they import may name framework globals.
    await installGlobals(context.cwd);
    return runConsole(
      {
        ...(context.values.config === undefined ? {} : { configPath: context.values.config }),
        ...(context.values['runtime-config'] === undefined
          ? {}
          : { runtimePath: context.values['runtime-config'] }),
      },
      { ...defaultConsoleDeps, env: context.env },
    );
  },
};
