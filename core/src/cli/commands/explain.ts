/**
 * `jsails explain` — the CLI wrapper over the static route-resolution snapshot.
 *
 * All resolution logic lives in `src/introspect/explain.ts` (shared with the
 * MCP introspection server); this module owns the
 * human-readable rendering and the command's exit codes. The resolver, and
 * the app config loader behind it, are imported when the command runs.
 */

import type { ExplainDeps, ExplainInput, ExplainResult } from '../../introspect/explain.js';
import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import { loadAppConfig } from '../config-loader.js';
import type { CommandModule } from '../descriptor.js';
import type { APP_JSON_OPTIONS } from '../manifest.js';
import { renderResult } from '../report.js';

export type { ExplainDeps, ExplainInput, ExplainResult } from '../../introspect/explain.js';

/** The command's own seam: the real config loader and the process streams. */
const cliExplainDeps: Omit<ExplainDeps, 'env'> = Object.freeze({
  loadConfig: (configPath: string) => loadAppConfig(configPath),
  stdout: (text: string) => process.stdout.write(`${text}\n`),
  stderr: (text: string) => process.stderr.write(`${text}\n`),
});

/**
 * Load config, discover routes, resolve the path, and print the result.
 * Returns 0 on success, 1 on failure.
 */
export async function runExplain(input: ExplainInput, deps: ExplainDeps): Promise<number> {
  const { buildExplainResult } = await import('../../introspect/explain.js');
  const { exitCode, result } = await buildExplainResult(input, deps);
  if (result === undefined) return exitCode;
  for (const line of renderResult(result, {
    json: input.json === true,
    render: renderHumanReadable,
  })) {
    deps.stdout(line);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function renderHumanReadable(result: ExplainResult): string[] {
  const lines: string[] = [];

  lines.push(`Path:      ${result.path}`);
  lines.push(`Matched:   ${result.matched ? 'yes' : 'no'}`);
  lines.push(`Reserved:  ${result.reserved ? 'yes (/ _jsails namespace)' : 'no'}`);
  lines.push('');

  if (result.route) {
    lines.push('Route');
    lines.push('-----');
    lines.push(`  pattern:      ${result.route.route}`);
    lines.push(`  kind:         ${result.route.kind}`);
    lines.push(`  dynamic:      ${result.route.dynamic ? 'yes' : 'no'}`);
    if (result.route.params.length > 0) {
      lines.push(`  params:       ${result.route.params.join(', ')}`);
    }
    lines.push(`  layouts:      ${result.route.layoutCount}`);
    if (result.paramValues && Object.keys(result.paramValues).length > 0) {
      lines.push(`  param values:`);
      for (const [key, value] of Object.entries(result.paramValues)) {
        lines.push(`    ${key} = ${value}`);
      }
    }
    lines.push('');
  }

  lines.push('Pipeline stages (in order)');
  lines.push('-----------------------');
  for (let index = 0; index < result.stages.length; index++) {
    lines.push(`  ${index + 1}. ${result.stages[index]}`);
  }

  return lines;
}

/** `jsails explain <path> [--json]`. */
export const explainCommand: CommandModule<typeof APP_JSON_OPTIONS, 'environment'> = {
  run: (context) => {
    const path = context.positionals[0] as string;
    if (path === '') return context.usage('a path argument is required');
    return runExplain(
      {
        configPath: context.values.config ?? DEFAULT_APP_CONFIG_PATH,
        path,
        json: context.values.json === true,
      },
      { ...cliExplainDeps, env: context.env },
    );
  },
};
