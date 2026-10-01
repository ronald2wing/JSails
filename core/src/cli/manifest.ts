/**
 * The built-in command manifest: every command the `jsails` bin owns, in help
 * order, as frozen {@link CommandDescriptor}s.
 *
 * The manifest is the single source for a built-in's name, options, help,
 * needs and entry point, so a command cannot be listed without being
 * dispatchable, and its `--help` cannot drift from what it parses. Its static
 * import graph is types only: each `load` is a dynamic `import()` that runs
 * once that command is dispatched, so `jsails --help` and every usage error
 * load no implementation (the `cli-graph` gate holds it).
 *
 * Commands that used to be built in and now come from a package are listed in
 * {@link PACKAGE_COMMANDS}, so a project without the package gets an install
 * hint instead of "unknown command".
 */

import type { MakeCommandType } from '../compiler/conventions.js';
import type {
  CommandDescriptor,
  CommandNeeds,
  CommandOption,
  CommandOptions,
  CommandPositional,
} from './descriptor.js';

/**
 * Erase one descriptor's option and needs types for the table. Each
 * descriptor is checked against its own command module where it is written;
 * the table only dispatches, which needs no more than the erased shape.
 */
function builtin<O extends CommandOptions, N extends CommandNeeds>(
  descriptor: CommandDescriptor<O, N>,
): CommandDescriptor {
  return Object.freeze(descriptor);
}

/** A boolean flag. */
type BooleanOption = CommandOption & { readonly type: 'boolean' };
/** A string option. */
type StringOption = CommandOption & { readonly type: 'string' };
/** A string option that may repeat. */
type StringListOption = StringOption & { readonly multiple: true };

const json = (summary: string): BooleanOption => ({ type: 'boolean', summary });

const config = (defaultPath: string, what: string): StringOption => ({
  type: 'string',
  short: 'c',
  value: '<path>',
  summary: `The ${what} config module (default: ${defaultPath})`,
});

const APP_CONFIG = config('jsails.app.js', 'app');
const DATABASE_CONFIG = config('jsails.database.js', 'database');
const RUNTIME_CONFIG = config('jsails.runtime.js', 'runtime');
const DIR: StringOption = {
  type: 'string',
  value: '<dir>',
  summary: 'The project directory (default: the working directory)',
};

// ---------------------------------------------------------------------------
// Options, one constant per command; command modules type their values by them
// ---------------------------------------------------------------------------

/** A command that takes no options of its own. */
export const NO_OPTIONS: Readonly<Record<never, never>> = Object.freeze(
  {} as const satisfies CommandOptions,
);

export const DB_PUSH_OPTIONS: Readonly<{
  config: StringOption;
  'app-config': StringOption;
  'dry-run': BooleanOption;
  'allow-destructive': BooleanOption;
  approve: StringListOption;
  'approve-all': BooleanOption;
  'wait-lock': StringOption;
  json: BooleanOption;
}> = Object.freeze({
  config: DATABASE_CONFIG,
  'app-config': {
    type: 'string',
    value: '<path>',
    summary: 'The app config whose plugins declare schema (default: jsails.app.js)',
  },
  'dry-run': { type: 'boolean', summary: 'Print the plan without applying it' },
  'allow-destructive': { type: 'boolean', summary: 'Permit destructive changes' },
  approve: {
    type: 'string',
    multiple: true,
    value: '<digest>',
    summary: 'Apply the deferred operation db:diff printed with this digest (repeatable)',
  },
  'approve-all': {
    type: 'boolean',
    summary: 'Apply every deferred operation (development and test only)',
  },
  'wait-lock': {
    type: 'string',
    value: '<seconds>',
    summary: "How long to wait for another push's schema lock (default: 60)",
  },
  json: json('Print the plan or the push report as JSON'),
} as const satisfies CommandOptions);

export const DB_DIFF_OPTIONS: Readonly<{
  config: StringOption;
  'app-config': StringOption;
  sql: BooleanOption;
  json: BooleanOption;
}> = Object.freeze({
  config: DATABASE_CONFIG,
  'app-config': DB_PUSH_OPTIONS['app-config'],
  sql: { type: 'boolean', summary: 'Print driver-specific SQL instead of the summary' },
  json: json('Print the plan as JSON'),
} as const satisfies CommandOptions);

export const APP_CONFIG_OPTIONS: Readonly<{ config: StringOption }> = Object.freeze({
  config: APP_CONFIG,
} as const);

export const SERVE_OPTIONS: Readonly<{ config: StringOption; with: StringListOption }> =
  Object.freeze({
    config: APP_CONFIG,
    with: {
      type: 'string',
      multiple: true,
      value: '<role>',
      summary: 'Also run this role in the same process (worker)',
    },
  } as const satisfies CommandOptions);

export const RUNTIME_CONFIG_OPTIONS: Readonly<{ config: StringOption }> = Object.freeze({
  config: RUNTIME_CONFIG,
} as const);

export const RUNTIME_JSON_OPTIONS: Readonly<{ config: StringOption; json: BooleanOption }> =
  Object.freeze({
    config: RUNTIME_CONFIG,
    json: json('Print as JSON'),
  } as const satisfies CommandOptions);

export const QUEUE_FAILED_OPTIONS: Readonly<{
  config: StringOption;
  queue: StringOption;
  limit: StringOption;
  json: BooleanOption;
}> = Object.freeze({
  config: RUNTIME_CONFIG,
  queue: { type: 'string', value: '<name>', summary: 'Only this queue' },
  limit: { type: 'string', value: '<n>', summary: 'At most this many entries (1-1000)' },
  json: json('Print as JSON'),
} as const satisfies CommandOptions);

export const QUEUE_CHANGE_OPTIONS: Readonly<{
  config: StringOption;
  all: BooleanOption;
  queue: StringOption;
  json: BooleanOption;
}> = Object.freeze({
  config: RUNTIME_CONFIG,
  all: { type: 'boolean', summary: 'Every recorded failed job instead of the given ids' },
  queue: { type: 'string', value: '<name>', summary: 'With --all, only this queue' },
  json: json('Print as JSON'),
} as const satisfies CommandOptions);

const QUEUE_IDS: readonly CommandPositional[] = [
  { name: 'id', summary: 'A failed job id (or --all)', required: false, variadic: true },
];

export const SEED_OPTIONS: Readonly<{ config: StringOption; only: StringListOption }> =
  Object.freeze({
    config: config('jsails.seed.js', 'seed'),
    only: {
      type: 'string',
      multiple: true,
      value: '<name>',
      summary: 'Run only this seeder (repeatable)',
    },
  } as const satisfies CommandOptions);

export const CREATE_OPTIONS: Readonly<{
  name: StringOption;
  'jsails-dependency': StringOption;
  'package-dependency': StringListOption;
  install: BooleanOption;
  'no-git': BooleanOption;
  starter: BooleanOption;
  admin: BooleanOption;
  blog: BooleanOption;
  saas: BooleanOption;
  cli: BooleanOption;
}> = Object.freeze({
  name: {
    type: 'string',
    value: '<name>',
    summary: 'The npm package name (default: derived from the directory)',
  },
  'jsails-dependency': {
    type: 'string',
    value: '<spec>',
    summary: 'The jsails dependency specifier (a file: path or a semver range)',
  },
  'package-dependency': {
    type: 'string',
    multiple: true,
    value: '<name>=<spec>',
    summary: 'Override one plugin dependency specifier (repeatable)',
  },
  install: { type: 'boolean', summary: 'Run npm install in the new project' },
  'no-git': { type: 'boolean', summary: 'Skip git init' },
  starter: { type: 'boolean', summary: 'The static site starter (the default)' },
  admin: { type: 'boolean', summary: 'The server-rendered starter with the admin panel' },
  blog: { type: 'boolean', summary: 'The standalone blog CMS starter' },
  saas: { type: 'boolean', summary: 'The multi-tenant starter: admin, tenancy and flags' },
  cli: { type: 'boolean', summary: 'A CLI-only starter with no web surface' },
} as const satisfies CommandOptions);

export const BUILD_DIR_OPTIONS: Readonly<{ dir: StringOption }> = Object.freeze({
  dir: DIR,
} as const);

export const INJECT_OPTIONS: Readonly<{ dir: StringOption }> = Object.freeze({
  dir: {
    type: 'string',
    value: '<dir>',
    summary: 'The compiled output directory (default: dist)',
  },
} as const satisfies CommandOptions);

export const MAKE_OPTIONS: Readonly<{ dir: StringOption; 'no-test': BooleanOption }> =
  Object.freeze({
    dir: DIR,
    'no-test': { type: 'boolean', summary: 'Skip the companion test file' },
  } as const satisfies CommandOptions);

export const MAKE_FOLDER_OPTIONS: Readonly<{
  dir: StringOption;
  'no-test': BooleanOption;
  mfc: BooleanOption;
}> = Object.freeze({
  ...MAKE_OPTIONS,
  mfc: { type: 'boolean', summary: 'Write a .jsails component folder' },
} as const satisfies CommandOptions);

export const MAKE_DOCKERFILE_OPTIONS: Readonly<{
  dir: StringOption;
  'health-path': StringOption;
  'no-healthcheck': BooleanOption;
  force: BooleanOption;
}> = Object.freeze({
  dir: DIR,
  'health-path': {
    type: 'string',
    value: '<path>',
    summary: 'The path the image health check requests',
  },
  'no-healthcheck': { type: 'boolean', summary: 'Write no health check' },
  force: { type: 'boolean', summary: 'Overwrite existing files' },
} as const satisfies CommandOptions);

export const TEST_OPTIONS: Readonly<{
  config: StringOption;
  'app-config': StringOption;
  'test-file': StringOption;
  'no-services': BooleanOption;
  watch: BooleanOption;
  'allow-non-test-database': BooleanOption;
}> = Object.freeze({
  config: DATABASE_CONFIG,
  'app-config': {
    type: 'string',
    value: '<path>',
    summary: 'The app config the tests run (default: jsails.app.js)',
  },
  'test-file': { type: 'string', value: '<file>', summary: 'Run one test file' },
  'no-services': { type: 'boolean', summary: 'Start no local services' },
  watch: { type: 'boolean', summary: 'Re-run on change' },
  'allow-non-test-database': {
    type: 'boolean',
    summary: 'Reconcile a database whose name does not say test',
  },
} as const satisfies CommandOptions);

export const CHECK_OPTIONS: Readonly<{
  config: StringOption;
  deploy: BooleanOption;
  json: BooleanOption;
}> = Object.freeze({
  config: APP_CONFIG,
  deploy: {
    type: 'boolean',
    summary: 'Also check that the app is ready to deploy (as production)',
  },
  json: json('Print the result as JSON'),
} as const satisfies CommandOptions);

export const APP_JSON_OPTIONS: Readonly<{ config: StringOption; json: BooleanOption }> =
  Object.freeze({
    config: APP_CONFIG,
    json: json('Print one JSON line'),
  } as const satisfies CommandOptions);

export const DESCRIBE_OPTIONS: Readonly<{
  config: StringOption;
  'db-config': StringOption;
  json: BooleanOption;
}> = Object.freeze({
  config: APP_CONFIG,
  'db-config': {
    type: 'string',
    value: '<path>',
    summary: 'The database config module (default: jsails.database.js)',
  },
  json: json('Print one JSON line'),
} as const satisfies CommandOptions);

export const MCP_OPTIONS: Readonly<{ config: StringOption; 'db-config': StringOption }> =
  Object.freeze({
    config: APP_CONFIG,
    'db-config': DESCRIBE_OPTIONS['db-config'],
  } as const satisfies CommandOptions);

export const AGENTS_SETUP_OPTIONS: Readonly<{ force: BooleanOption }> = Object.freeze({
  force: {
    type: 'boolean',
    short: 'f',
    summary: 'Overwrite AGENTS.md and the skill (.mcp.json is always merged)',
  },
} as const satisfies CommandOptions);

export const I18N_MISSING_OPTIONS: Readonly<{
  config: StringOption;
  json: BooleanOption;
  unused: BooleanOption;
}> = Object.freeze({
  config: APP_CONFIG,
  json: json('Print as JSON'),
  unused: { type: 'boolean', summary: 'Also report catalog keys no code uses' },
} as const satisfies CommandOptions);

export const CREDENTIALS_OPTIONS: Readonly<{
  env: StringOption;
  from: StringOption;
  finish: BooleanOption;
}> = Object.freeze({
  env: {
    type: 'string',
    value: '<name>',
    summary: 'The environment whose credentials to change (default: the resolved one)',
  },
  from: { type: 'string', value: '<file>', summary: 'init: seal this dotenv file' },
  finish: { type: 'boolean', summary: 'rotate: retire the previous key' },
} as const satisfies CommandOptions);

export const PLUGINS_OPTIONS: Readonly<{ json: BooleanOption }> = Object.freeze({
  json: json('Emit machine-readable JSON'),
} as const satisfies CommandOptions);

export const CONSOLE_OPTIONS: Readonly<{ config: StringOption; 'runtime-config': StringOption }> =
  Object.freeze({
    config: DATABASE_CONFIG,
    'runtime-config': {
      type: 'string',
      value: '<path>',
      summary: 'The runtime config module (default: jsails.runtime.js)',
    },
  } as const satisfies CommandOptions);

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** One `make:<type>` generator descriptor. */
function make(
  type: MakeCommandType,
  summary: string,
  options: typeof MAKE_OPTIONS | typeof MAKE_FOLDER_OPTIONS,
  positionals: readonly CommandPositional[] = [{ name: 'name', summary: 'The name to generate' }],
): CommandDescriptor {
  return builtin({
    name: `make:${type}`,
    summary,
    options,
    positionals,
    needs: 'nothing',
    secrets: 'unused',
    load: () => import('./commands/make.js').then((module) => module.makeCommand),
  });
}

/**
 * Every built-in command, in help order.
 *
 * @internal
 */
export const BUILTIN_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  builtin({
    name: 'create',
    summary: 'Scaffold a fresh JSails application',
    options: CREATE_OPTIONS,
    positionals: [{ name: 'dir', summary: 'The directory to create' }],
    details: ['The presets (--starter, --admin, --blog, --saas, --cli) exclude one another.'],
    needs: 'nothing',
    secrets: 'unused',
    load: () => import('./commands/create.js').then((module) => module.createCommand),
  }),
  builtin({
    name: 'dev',
    summary: 'Compile, watch, and serve the app (web and worker roles) for development',
    options: APP_CONFIG_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/app.js').then((module) => module.devCommand),
  }),
  builtin({
    name: 'serve',
    summary: 'Run the HTTP server (and with --with worker, the job workers) until SIGINT/SIGTERM',
    options: SERVE_OPTIONS,
    needs: 'app',
    secrets: 'required',
    load: () => import('./commands/app.js').then((module) => module.serveCommand),
  }),
  builtin({
    name: 'work',
    summary: "Run the app's worker role (its job workers) until SIGINT/SIGTERM",
    options: APP_CONFIG_OPTIONS,
    needs: 'app',
    secrets: 'required',
    load: () => import('./commands/runtime.js').then((module) => module.workCommand),
  }),
  builtin({
    name: 'build',
    summary: 'Render the static site into the configured output directory',
    options: APP_CONFIG_OPTIONS,
    needs: 'app',
    secrets: 'unused',
    load: () => import('./commands/app.js').then((module) => module.buildCommand),
  }),
  builtin({
    name: 'build:meta',
    summary: 'Generate the .jsails/ artifacts (models, components, autoload) before tsc',
    options: BUILD_DIR_OPTIONS,
    needs: 'environment',
    secrets: 'unused',
    load: () => import('./commands/build-meta.js').then((module) => module.buildMetaCommand),
  }),
  builtin({
    name: 'inject:auto-imports',
    summary: 'Inject scoped Preact imports into compiled server output',
    options: INJECT_OPTIONS,
    needs: 'environment',
    secrets: 'unused',
    load: () =>
      import('./commands/inject-auto-imports.js').then((module) => module.injectAutoImportsCommand),
  }),
  builtin({
    name: 'check',
    summary: 'Check that the app config loads and, with --deploy, that it is ready to deploy',
    options: CHECK_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    defaultEnvironment: (values) => (values.deploy === true ? 'production' : undefined),
    load: () => import('./commands/check.js').then((module) => module.checkCommand),
  }),
  builtin({
    name: 'test',
    summary: 'Boot the test database, reconcile its schema, and run node --test',
    options: TEST_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    defaultEnvironment: () => 'test',
    load: () => import('./commands/test.js').then((module) => module.testCommand),
  }),
  builtin({
    name: 'console',
    summary: 'Start an interactive REPL with the database and jobs runtime loaded',
    options: CONSOLE_OPTIONS,
    details: [
      'The REPL exposes db (the initialized data source), models (entity name to class),',
      'config (the loaded config metadata) and jobs (the jobs runtime). A config module that',
      'does not exist is skipped and the REPL still opens. Leave it with .exit or Ctrl+D.',
    ],
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/console.js').then((module) => module.consoleCommand),
  }),
  builtin({
    name: 'db:push',
    summary: 'Diff the declared model schema against the live database and apply the plan',
    options: DB_PUSH_OPTIONS,
    details: [
      'A defineSchemaConfig() config takes --approve, --approve-all, --wait-lock and --json;',
      'a JsailsDataSource config takes --dry-run, --allow-destructive and --app-config.',
    ],
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/db.js').then((module) => module.dbPushCommand),
  }),
  builtin({
    name: 'db:diff',
    summary: 'Diff the declared model schema against the live database (read-only)',
    options: DB_DIFF_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/db.js').then((module) => module.dbDiffCommand),
  }),
  builtin({
    name: 'seed',
    summary: 'Run the registered database seeders',
    options: SEED_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/seed.js').then((module) => module.seedCommand),
  }),
  builtin({
    name: 'schedule',
    summary: 'Register the schedules once, then exit',
    options: RUNTIME_CONFIG_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/runtime.js').then((module) => module.scheduleCommand),
  }),
  builtin({
    name: 'schedules',
    summary: 'List the registered schedules',
    options: RUNTIME_JSON_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/schedules.js').then((module) => module.schedulesCommand),
  }),
  builtin({
    name: 'queue',
    summary: 'Print queue metrics',
    options: RUNTIME_JSON_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/queue.js').then((module) => module.queueCommand),
  }),
  builtin({
    name: 'queue:failed',
    summary: 'List the recorded failed jobs',
    options: QUEUE_FAILED_OPTIONS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/queue-failed.js').then((module) => module.queueFailedCommand),
  }),
  builtin({
    name: 'queue:retry',
    summary: 'Re-dispatch recorded failed jobs and remove them on success',
    options: QUEUE_CHANGE_OPTIONS,
    positionals: QUEUE_IDS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/queue-failed.js').then((module) => module.queueRetryCommand),
  }),
  builtin({
    name: 'queue:forget',
    summary: 'Delete recorded failed jobs',
    options: QUEUE_CHANGE_OPTIONS,
    positionals: QUEUE_IDS,
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/queue-failed.js').then((module) => module.queueForgetCommand),
  }),
  make('page', 'Generate a page (pages/<name>.tsx)', MAKE_FOLDER_OPTIONS),
  make('api', 'Generate an API route (api/<name>.ts)', MAKE_OPTIONS),
  make('job', 'Generate a job (jobs/<name>.job.ts)', MAKE_OPTIONS),
  make('model', 'Generate a model (models/<name>.ts)', MAKE_OPTIONS),
  make('command', 'Generate an app command (commands/<name>.ts)', MAKE_OPTIONS),
  make(
    'server-component',
    'Generate a server component (components/<name>.tsx)',
    MAKE_FOLDER_OPTIONS,
  ),
  make('serializer', 'Generate a serializer (serializers/<name>.ts)', MAKE_OPTIONS),
  make('middleware', 'Generate a middleware (middleware/<name>.ts)', MAKE_OPTIONS),
  make('content', 'Generate a content entry (content/<collection>/<name>.md)', MAKE_OPTIONS, [
    { name: 'collection', summary: 'The content collection' },
    { name: 'name', summary: 'The entry name' },
  ]),
  builtin({
    name: 'make:dockerfile',
    summary: 'Generate the production Dockerfile and .dockerignore that jamal deploy builds',
    options: MAKE_DOCKERFILE_OPTIONS,
    needs: 'nothing',
    secrets: 'unused',
    load: () =>
      import('./commands/make-dockerfile.js').then((module) => module.makeDockerfileCommand),
  }),
  builtin({
    name: 'convert',
    summary: 'Toggle a .jsails component between one file and a folder of files',
    options: NO_OPTIONS,
    positionals: [{ name: 'path', summary: 'The component file or folder' }],
    details: [
      'A single file (pages/about.jsails) becomes the folder pages/about/ (about.jsails,',
      'about.ts, about.css, about.scoped.css); a folder (pages/about, or its',
      'pages/about/about.jsails) becomes the single file. The server module',
      'about.server.ts moves with the component. A file becomes a folder only in a',
      'project that syncs .jsails sidecars (.jsails/sfc in the working directory).',
    ],
    needs: 'nothing',
    secrets: 'unused',
    load: () => import('./commands/convert.js').then((module) => module.convertCommand),
  }),
  builtin({
    name: 'credentials',
    summary: 'Create, change, list, or rotate the sealed per-environment credentials',
    options: CREDENTIALS_OPTIONS,
    positionals: [
      { name: 'action', summary: 'init, edit, set, unset, show, import or rotate' },
      { name: 'operand', summary: 'set/unset: the NAME; import: the dotenv file', required: false },
    ],
    details: [
      'set reads the value from standard input, so it never appears in an argv. show prints',
      'names, never values. rotate adds a new current key to the ring and re-seals the',
      'document under it; the previous key stays until "rotate --finish", so servers still',
      'running the old document keep working. When JSAILS_CREDENTIALS_KEY holds the ring,',
      "copy the key file's keys into it (comma-separated) after each step.",
      'Files: config/credentials/<env>.enc (sealed, committed) and',
      'config/credentials/<env>.key (the key ring, git-ignored).',
    ],
    needs: 'environment',
    secrets: 'unused',
    load: () => import('./commands/credentials.js').then((module) => module.credentialsCommand),
  }),
  builtin({
    name: 'plugins',
    summary: 'List and check the JSails plugin packages the app depends on',
    options: PLUGINS_OPTIONS,
    positionals: [
      {
        name: 'subcommand',
        summary: 'list (the default) or check',
        required: false,
        variadic: true,
      },
    ],
    details: [
      'list prints each plugin package with its provenance; check validates their manifests',
      'against the framework version and exits 1 on a finding.',
      '',
      'A plugin package is a direct or transitive npm dependency that self-identifies',
      'through its package.json "jsails" field. Listing one does not run it: a plugin',
      'runs when the app config lists it in plugins.use. The command reads manifests',
      'only and never imports plugin code.',
    ],
    needs: 'nothing',
    secrets: 'unused',
    load: () => import('./commands/plugins/index.js').then((module) => module.pluginsCommand),
  }),
  builtin({
    name: 'inspect',
    summary: 'Print the discovered route manifest (inspect routes)',
    options: APP_JSON_OPTIONS,
    positionals: [{ name: 'subject', summary: 'routes' }],
    details: [
      'Read-only: imports no page or API module and opens no connection.',
      'JSON shape: { "entries": [{ "kind", "route", "file", "dynamic", "catchAll", "params" }] }',
    ],
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/inspect.js').then((module) => module.inspectCommand),
  }),
  builtin({
    name: 'describe',
    summary: "Compose a machine-readable snapshot of the app's definition",
    options: DESCRIBE_OPTIONS,
    details: ['Read-only: imports no page or API module and opens no connection.'],
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/describe.js').then((module) => module.describeCommand),
  }),
  builtin({
    name: 'explain',
    summary: 'Resolve which route handles a path and show its pipeline stages',
    options: APP_JSON_OPTIONS,
    positionals: [{ name: 'path', summary: 'The request path (/blog/hello)' }],
    details: [
      'Read-only: imports no page or API module and opens no connection. Framework-owned',
      'paths under /_jsails are reported as reserved and never matched against the manifest.',
    ],
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/explain.js').then((module) => module.explainCommand),
  }),
  builtin({
    name: 'mcp',
    summary: 'Serve read-only introspection of this app to an AI agent (MCP over stdio)',
    options: MCP_OPTIONS,
    details: [
      'Point your agent or editor at "jsails mcp" as a stdio MCP server. Messages are',
      'newline-delimited JSON-RPC on stdin and stdout; nothing else is written to stdout.',
      "Output from the app's own modules (console.log included) goes to stderr.",
      '',
      'Protocol: MCP 2026-07-28 (server/discover, tools/list, tools/call), and the 2025',
      'revisions for clients that open with an initialize handshake. The server exits when',
      'stdin closes, or on SIGINT or SIGTERM.',
      '',
      'Tools (all read-only, idempotent, and local):',
      '  jsails_describe        the app definition: routes, plugins, commands, schema',
      '  jsails_inspect_routes  every page and API route with its parameters',
      '  jsails_explain_route   which route serves a path (matched: false when none)',
      '  jsails_schema          the declared entity schema, without a connection',
      '',
      "The tools run the selected config modules' top-level code but never write to the",
      'filesystem or open a database connection; a tool call cannot choose another module.',
    ],
    needs: 'environment',
    secrets: 'required',
    load: () => import('./commands/mcp.js').then((module) => module.mcpCommand),
  }),
  builtin({
    name: 'agents:setup',
    summary: 'Write .mcp.json, AGENTS.md and a JSails skill so an AI agent can drive this app',
    options: AGENTS_SETUP_OPTIONS,
    details: [
      'Writes .mcp.json (registers "jsails mcp" as the "jsails" MCP server, merged into an',
      'existing file), AGENTS.md and .agents/skills/jsails/SKILL.md. Existing files are left',
      'alone unless --force; never runs the app config or opens a connection.',
    ],
    needs: 'nothing',
    secrets: 'unused',
    load: () => import('./commands/agents-setup.js').then((module) => module.agentsSetupCommand),
  }),
  builtin({
    name: 'i18n:missing',
    summary: 'Report translation keys used in code but absent from the catalogs',
    options: I18N_MISSING_OPTIONS,
    details: ['Exits 1 when a key is missing, so CI can gate on it.'],
    needs: 'environment',
    secrets: 'unused',
    load: () => import('./commands/i18n-missing.js').then((module) => module.i18nMissingCommand),
  }),
  builtin({
    name: 'jamal',
    summary: "Run the project's @jsails/jamal (local services and deploys)",
    options: NO_OPTIONS,
    passthrough: true,
    details: [
      "Every argument goes to jamal, --help included; jamal decides each verb's environment.",
    ],
    needs: 'nothing',
    secrets: 'unused',
    load: () => import('./jamal-forward.js').then((module) => module.jamalCommand),
  }),
]);

/**
 * First-party commands that come from a package, by name, with that package:
 * dispatching one in a project without the package is `cli.missing_dependency`.
 * A map, not an object, because it is looked up by whatever the user typed,
 * and `constructor` or `__proto__` must find nothing.
 *
 * @internal
 */
export const PACKAGE_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['config:export', '@jsails/config'],
  ['config:import', '@jsails/config'],
]);
