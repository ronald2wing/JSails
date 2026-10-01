/**
 * `jsails explain` — the CLI wrapper over the static route-resolution snapshot.
 *
 * All resolution logic lives in `src/introspect/explain.ts` (shared with the
 * MCP introspection server); this module owns argument parsing, the
 * human-readable rendering, and the command's exit codes. The resolver, and
 * the app config loader behind it, are imported once the arguments are valid,
 * so help and usage errors load neither.
 */

import type { ExplainDeps, ExplainInput, ExplainResult } from '../../introspect/explain.js';
import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import { loadAppConfig } from '../config-loader.js';
import { renderResult } from '../report.js';
import { usageError as reportUsageError } from '../usage-error.js';

export type { ExplainDeps, ExplainInput, ExplainResult } from '../../introspect/explain.js';

/** The command's own seam: the real config loader and the process streams. */
const cliExplainDeps: ExplainDeps = Object.freeze<ExplainDeps>({
  loadConfig: (configPath) => loadAppConfig(configPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});

/**
 * Load config, discover routes, resolve the path, and print the result.
 * Returns 0 on success, 1 on failure.
 */
export async function runExplain(
  input: ExplainInput,
  deps: ExplainDeps = cliExplainDeps,
): Promise<number> {
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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/** Render usage text for `explain --help`. */
function explainHelp(): string {
  return `explain - resolve which route handles a path and show its pipeline stages

Usage:
  jsails explain <path> [options]

Arguments:
  <path>                  The request path to explain (required)

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --json              Emit a single JSON line instead of a summary
  -h, --help              Show this help

Read-only: never imports page/API modules, never opens a connection.

The result shows whether the path matches a route, any resolved parameter
values, and the fixed pipeline stages that would run for that request.
Framework-owned paths under /_jsails are reported as reserved and never
matched against the manifest.
`;
}

/**
 * Parse and run `jsails explain` from the raw arguments after the command name.
 * An `argv` built-in (see `builtin-commands.ts`): it parses its own arguments
 * instead of the shared global flags.
 */
export async function runExplainCommand(
  args: readonly string[],
  deps?: ExplainDeps,
): Promise<number> {
  let configPath = DEFAULT_APP_CONFIG_PATH;
  let json = false;
  let help = false;
  let inputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--json') {
      json = true;
    } else if (token === '--config' || token === '-c') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? cliExplainDeps.stderr)(line),
          'Run "jsails explain --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? cliExplainDeps.stderr)(line),
        'Run "jsails explain --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else if (inputPath === undefined) {
      inputPath = token;
    } else {
      return reportUsageError(
        (line) => (deps?.stderr ?? cliExplainDeps.stderr)(line),
        'Run "jsails explain --help" for usage.',
        'explain takes exactly one path argument',
      );
    }
  }

  if (help) {
    (deps?.stdout ?? cliExplainDeps.stdout)(explainHelp());
    return 0;
  }

  if (inputPath === undefined || inputPath === '') {
    return reportUsageError(
      (line) => (deps?.stderr ?? cliExplainDeps.stderr)(line),
      'Run "jsails explain --help" for usage.',
      'a path argument is required',
    );
  }

  return runExplain({ configPath, path: inputPath, json }, deps);
}
