/**
 * `jsails describe` — the CLI wrapper over the static-definition snapshot.
 *
 * All snapshot logic lives in `src/introspect/describe.ts` (imported here and by
 * the MCP introspection server); this module owns argument parsing, the
 * human-readable rendering, and the command's exit codes.
 */

import { formatError, usageError as reportUsageError } from '../internal/errors.js';
import {
  buildDescribeResult,
  defaultDescribeDeps,
  type DescribeDeps,
  type DescribeInput,
  type DescribeResult,
} from '../introspect/describe.js';

// Re-exported so the command's tests can inject fakes and name its result.
export type { DescribeDeps, DescribeInput, DescribeResult } from '../introspect/describe.js';

/**
 * Compose the static definition snapshot from the resolved app config and
 * optional schema, then print it.
 */
export async function runDescribe(
  input: DescribeInput,
  deps: DescribeDeps = defaultDescribeDeps,
): Promise<number> {
  let result: DescribeResult;
  try {
    result = await buildDescribeResult(input, deps);
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: () => false, fallback: 'failed to load config' })}`,
    );
    return 1;
  }

  if (input.options.json === true) {
    deps.stdout(JSON.stringify(result));
  } else {
    for (const line of renderHumanReadable(result)) {
      deps.stdout(line);
    }
  }
  return 0;
}

/** Render a human-readable summary of the describe result. */
function renderHumanReadable(result: DescribeResult): string[] {
  const lines: string[] = [];

  lines.push('Application');
  lines.push('-----------');
  lines.push(`  root:        ${result.app.rootDir}`);
  lines.push(`  host:        ${result.app.host}:${result.app.port}`);
  if (result.app.publicOrigin) {
    lines.push(`  origin:      ${result.app.publicOrigin}`);
  }
  lines.push(`  health:      ${result.app.healthPath ?? '(disabled)'}`);
  lines.push(`  pages:       ${result.app.pages}`);
  lines.push(`  api:         ${result.app.api}`);
  lines.push(`  public:      ${result.app.public}`);
  lines.push(`  out:         ${result.app.out}`);
  lines.push('');

  lines.push(`Routes (${result.routes.length})`);
  lines.push('------');
  if (result.routes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const route of result.routes) {
      const params = route.params.length > 0 ? ` (params: ${route.params.join(', ')})` : '';
      lines.push(`  ${route.route.padEnd(24)} ${route.kind}${params}`);
    }
  }
  lines.push('');

  lines.push(`Plugins (${result.plugins.enabled.length} enabled)`);
  lines.push('-------');
  if (result.plugins.enabled.length === 0) {
    lines.push('  (none)');
  } else {
    for (const id of result.plugins.enabled) {
      lines.push(`  ${id}`);
    }
  }
  if (result.plugins.conflicts.length > 0) {
    lines.push(`  conflicts: ${result.plugins.conflicts.join(', ')}`);
  }
  lines.push('');

  lines.push(`Commands (${result.commands.length})`);
  lines.push('--------');
  if (result.commands.length === 0) {
    lines.push('  (none)');
  } else {
    for (const cmd of result.commands) {
      const configTag = cmd.config !== 'none' ? ` [config: ${cmd.config}]` : '';
      lines.push(`  ${cmd.name.padEnd(24)} ${cmd.summary}${configTag}`);
    }
  }
  lines.push('');

  lines.push(`Components (${result.components.length})`);
  lines.push('----------');
  if (result.components.length === 0) {
    lines.push('  (none)');
  } else {
    for (const component of result.components) {
      const actions =
        component.actions.length > 0 ? ` [actions: ${component.actions.join(', ')}]` : '';
      lines.push(`  ${component.name}${actions}`);
    }
  }
  lines.push('');

  lines.push(`Schema (${result.schema.tables.length} tables)`);
  lines.push('------');
  if (result.schema.tables.length === 0) {
    lines.push('  (no entity tables declared)');
  } else {
    for (const table of result.schema.tables) {
      const pk = table.columns.find((c) => c.primaryKey);
      const pkLabel = pk ? ` [pk: ${pk.name}]` : '';
      lines.push(
        `  ${table.name}${pkLabel} (${table.columns.length} columns, ` +
          `${table.indexes.length} indexes, ${table.foreignKeys.length} FKs)`,
      );
    }
  }

  return lines;
}

/** Render usage text for `describe --help`. */
function describeHelp(): string {
  return `describe - compose a machine-readable snapshot of the app's definition

Usage:
  jsails describe [options]

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --db-config <path>  Path to the database config module (default: jsails.config.js)
      --json              Emit a single JSON line instead of a summary
  -h, --help              Show this help

Read-only: never imports page/API modules, never opens a connection.
The schema section is extracted from entity metadata without connecting.
`;
}

/**
 * Parse and run `jsails describe` from the raw arguments after the command name.
 * Owns its own argument parsing like `jamal`/`plugins`/`inspect`, so it is
 * routed before the shared `parseArgs` flag-gating in `cli.ts`.
 */
export async function runDescribeCommand(
  args: readonly string[],
  deps?: DescribeDeps,
): Promise<number> {
  let configPath = 'jsails.app.js';
  let dbConfigPath: string | undefined;
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--json') {
      json = true;
    } else if (token === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
          'Run "jsails describe --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token === '--db-config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
          'Run "jsails describe --help" for usage.',
          '--db-config requires a value',
        );
      }
      dbConfigPath = value;
      index += 1;
    } else if (token.startsWith('--db-config=')) {
      dbConfigPath = token.slice('--db-config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
        'Run "jsails describe --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultDescribeDeps.stderr)(line),
        'Run "jsails describe --help" for usage.',
        `unexpected argument: ${token}`,
      );
    }
  }

  if (help) {
    (deps?.stdout ?? defaultDescribeDeps.stdout)(describeHelp());
    return 0;
  }

  return runDescribe({ configPath, dbConfigPath, options: { json } }, deps);
}
