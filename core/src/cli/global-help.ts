/**
 * The `jsails --help` text. Command rows are generated from the built-in
 * command table; the option reference and config notes are prose.
 */

import { DEFAULT_APP_CONFIG_PATH } from '../app/config/schema.js';
import {
  DEFAULT_DATABASE_CONFIG_PATH,
  DEFAULT_RUNTIME_CONFIG_PATH,
  DEFAULT_SEED_CONFIG_PATH,
} from '../config-modules.js';
import { BUILTIN_COMMANDS, type BuiltinCommand } from './builtin-commands.js';

/** Width of the command column, excluding the two-space indent. */
const USAGE_COLUMN = 19;

function commandRows(command: BuiltinCommand): string[] {
  const usage = command.usage ?? command.name;
  const indent = ' '.repeat(2 + USAGE_COLUMN);
  const rows =
    usage.length < USAGE_COLUMN
      ? [`  ${usage.padEnd(USAGE_COLUMN)}${command.summary}`]
      : [`  ${usage}`, `${indent}${command.summary}`];
  for (const detail of command.details ?? []) {
    rows.push(`${indent}${detail}`);
  }
  return rows;
}

const DEVELOPER_COMMANDS = BUILTIN_COMMANDS.flatMap(commandRows).join('\n');

const OPTIONS_AND_NOTES = `Options:
  -c, --config <path>    Path to the JS ESM config module
                           (default: ${DEFAULT_DATABASE_CONFIG_PATH} for db:push/db:diff,
                           ${DEFAULT_RUNTIME_CONFIG_PATH} for work/schedule/queue/schedules,
                           ${DEFAULT_SEED_CONFIG_PATH} for seed,
                           ${DEFAULT_APP_CONFIG_PATH} for build/serve/dev/live:list)
      --name <name>      npm package name (create, optional; derived from the
                           directory when omitted)
      --jsails-dependency <spec>
                           jsails dependency specifier for a created project
                           (create only; a file: path or an npm semver range like ^1.0.0)
      --package-dependency <name>=<spec>
                           Override a plugin dependency (repeatable; create
                           only). <name> is an npm package name and <spec> a
                           file: tarball path or semver range, e.g.
                           @jsails/blog=file:/tmp/jsails-blog-1.0.0.tgz
      --install          Run npm install in the created project (create only)
      --no-git           Skip git init in the created project (create only)
      --starter          Scaffold the default starter, a static site (create
                           only; the default when no preset flag is supplied)
      --admin            Scaffold the server-rendered starter with the admin
                           panel (create only)
      --blog             Scaffold the standalone blog CMS starter with the
                           admin panel and plugin manager (create only)
      --saas             Scaffold the multi-tenant starter: admin panel plus
                           tenancy and feature flags (create only)
      --cli              Scaffold a CLI-only starter with no web surface
                           (create only; mutually exclusive with --starter/--admin/--blog/--saas)
      --app-config <path>
                           App config used to discover plugin schema
                           (db:push/db:diff; default ${DEFAULT_APP_CONFIG_PATH})
      --allow-destructive
                           Permit destructive schema changes (db:push only)
      --dry-run          Print the reconciliation plan without applying it
                           (db:push only)
      --sql              Print driver-specific SQL instead of the operation
                           summary (db:diff only)
      --only <name>      Run only the named seeder(s) (seed only, repeatable)
      --json             Print queue metrics or schedules as JSON (queue/schedules only)
  -n, --no-interaction   Do not prompt; fail if a custom command requires input
  -h, --help             Show this help

Config modules:
  db:push/db:diff          default-export a JsailsDataSource instance
                             (https://jsails.org/docs/database)
  work/schedule/queue      default-export a runtime object with a job \`registry\`
                             (https://jsails.org/docs/jobs)
  seed                     default-export \`{ registry, dataSource }\`
                             (https://jsails.org/docs/database)
  build/serve/dev          default-export an app config object; host, port, and
                             output directory are set there, not via flags
                             (https://jsails.org/docs/configuration)
TypeScript configs must be compiled to JavaScript before use.
`;

/** Render the global help with the project's discovered user commands. */
export function renderGlobalHelp(userCommands: readonly string[]): string {
  const userSection =
    userCommands.length === 0
      ? '  No user commands discovered in commands/ or dist/commands.'
      : userCommands.join('\n');
  return `jsails - TypeScript application framework CLI

Usage:
  jsails <command> [options]

Developer commands:
${DEVELOPER_COMMANDS}

User commands:
${userSection}

${OPTIONS_AND_NOTES}`;
}
