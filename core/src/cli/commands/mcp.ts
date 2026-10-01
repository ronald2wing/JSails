/**
 * `jsails mcp` — run the developer MCP server over stdio.
 *
 * ```sh
 * jsails mcp [--config <path>] [--db-config <path>] [--help]
 * ```
 *
 * Only protocol frames reach stdout; the startup line, app console output, and
 * failure reports go to stderr. Usage errors exit 2, consistent with the other
 * early-routed commands.
 */

import { formatError } from '../../errors/inspect.js';

import { usageError as reportUsageError } from '../usage-error.js';
import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';

/** Render usage text for `jsails mcp --help`. */
function mcpHelp(): string {
  return `mcp - serve read-only introspection of this app to an AI agent (MCP over stdio)

Usage:
  jsails mcp [options]

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --db-config <path>  Path to the database config module (default: jsails.database.js)
  -h, --help              Show this help

Point your agent or editor at "jsails mcp" as a stdio MCP server. Messages are
newline-delimited JSON-RPC on stdin and stdout; nothing else is written to
stdout. Output from the app's own modules (console.log included) goes to
stderr, where clients show server logs.

Protocol: MCP 2026-07-28 (server/discover, tools/list, tools/call), and the
2025 revisions for clients that open with an initialize handshake. The server
exits when stdin closes, or on SIGINT or SIGTERM.

Tools (all read-only, idempotent, and local):
  jsails_describe        the app definition: routes, plugins, commands, schema
  jsails_inspect_routes  every page and API route with its parameters
  jsails_explain_route   which route serves a path (matched: false when none)
  jsails_schema          the declared entity schema, without a connection

The tools run the selected config modules' top-level code, as every jsails
command does, but never write to the filesystem or open a database
connection. The module paths are fixed by these flags; a tool call cannot
choose a different module to load.
`;
}

/**
 * How long a closed server waits for the event loop to drain before the
 * process exits anyway: an app module's open handle (a timer, a pool) must not
 * keep a server whose client has gone alive.
 */
const EXIT_GRACE_MS = 1000;

/**
 * Parse and run `jsails mcp` from the raw arguments after the command name.
 * Owns its own argument parsing, like the other early-routed read-only commands.
 */
export async function runMcpCommand(args: readonly string[]): Promise<number> {
  let configPath = DEFAULT_APP_CONFIG_PATH;
  let dbConfigPath: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--config' || token === '-c') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => process.stderr.write(`${line}\n`),
          'Run "jsails mcp --help" for usage.',
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
          (line) => process.stderr.write(`${line}\n`),
          'Run "jsails mcp --help" for usage.',
          '--db-config requires a value',
        );
      }
      dbConfigPath = value;
      index += 1;
    } else if (token.startsWith('--db-config=')) {
      dbConfigPath = token.slice('--db-config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => process.stderr.write(`${line}\n`),
        'Run "jsails mcp --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else {
      return reportUsageError(
        (line) => process.stderr.write(`${line}\n`),
        'Run "jsails mcp --help" for usage.',
        `unexpected argument: ${token}`,
      );
    }
  }

  if (help) {
    process.stdout.write(mcpHelp());
    return 0;
  }

  process.stderr.write(`jsails MCP server starting (config: ${configPath})\n`);

  try {
    const { runJsailsDevMcp } = await import('../../mcp/server.js');
    await runJsailsDevMcp({
      configPath,
      ...(dbConfigPath !== undefined ? { dbConfigPath } : {}),
    });
  } catch (error) {
    process.stderr.write(
      `jsails: ${formatError(error, { fallback: 'failed to start MCP server' })}\n`,
    );
    return 1;
  }

  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, EXIT_GRACE_MS).unref();
  return 0;
}
