/**
 * `jsails describe` — the CLI wrapper over the static-definition snapshot.
 *
 * All snapshot logic lives in `src/introspect/describe.ts` (shared with the MCP
 * introspection server); this module owns the
 * human-readable rendering, and the command's exit codes. The snapshot module,
 * and the app config loader behind it, are imported when the command runs.
 */

import type { DescribeDeps, DescribeInput, DescribeResult } from '../../introspect/describe.js';
import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import type { CommandModule } from '../descriptor.js';
import type { DESCRIBE_OPTIONS } from '../manifest.js';
import { renderResult, writeFailure } from '../report.js';

// Re-exported so the command's tests can inject fakes and name its result.
export type { DescribeDeps, DescribeInput, DescribeResult } from '../../introspect/describe.js';

/**
 * Compose the static definition snapshot from the resolved app config and
 * optional schema, then print it.
 */
export async function runDescribe(
  input: DescribeInput,
  env: Readonly<Record<string, string | undefined>>,
  injected?: DescribeDeps,
): Promise<number> {
  const { buildDescribeResult, defaultDescribeDeps } = await import('../../introspect/describe.js');
  const deps = injected ?? defaultDescribeDeps;
  let result: DescribeResult;
  try {
    result = await buildDescribeResult(input, deps);
  } catch (error) {
    // A config error's message is value-free; anything else (an extension's
    // own error) is summarised under the fixed line.
    const { isAppConfigError } = await import('../../app/config/errors.js');
    await writeFailure(error, (line) => deps.stderr(line), {
      allow: isAppConfigError,
      fallback: 'failed to load config',
      env,
    });
    return 1;
  }

  for (const line of renderResult(result, {
    json: input.options.json === true,
    render: renderHumanReadable,
  })) {
    deps.stdout(line);
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
  if (result.app.origin) {
    lines.push(`  origin:      ${result.app.origin}`);
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

  lines.push(`Plugins (${result.plugins.graph.length})`);
  lines.push('-------');
  for (const node of result.plugins.graph) {
    lines.push(`  ${node.name.padEnd(24)} ${node.origin}`);
  }
  if (result.plugins.liveOnly.length > 0) {
    lines.push(`  live-only: ${result.plugins.liveOnly.join(', ')}`);
  }
  lines.push('');

  lines.push(`Commands (${result.commands.length})`);
  lines.push('--------');
  if (result.commands.length === 0) {
    lines.push('  (none)');
  } else {
    for (const command of result.commands) {
      const from = command.package ?? (command.unbuilt === true ? 'app, not built' : 'app');
      lines.push(`  ${command.name.padEnd(24)} ${command.summary ?? ''} [${from}]`);
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

/** `jsails describe [--json]`. */
export const describeCommand: CommandModule<typeof DESCRIBE_OPTIONS, 'environment'> = {
  run: (context) =>
    runDescribe(
      {
        configPath: context.values.config ?? DEFAULT_APP_CONFIG_PATH,
        ...(context.values['db-config'] === undefined
          ? {}
          : { dbConfigPath: context.values['db-config'] }),
        options: { json: context.values.json === true },
      },
      context.env,
    ),
};
