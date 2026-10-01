/**
 * `jsails agents:setup` — emit the canonical agent files so an AI coding agent
 * can drive a JSails app.
 *
 * Emits three artifacts, using the cross-editor shared standards only (no
 * per-editor sprawl, no TOML, no editor detection):
 *
 * - `.mcp.json` — the shared MCP registry; registers `jsails mcp` under `jsails`.
 * - `AGENTS.md` — the full framework reader guide (the one packaged at the
 *   package root), the cross-editor guidance file.
 * - `.agents/skills/jsails/SKILL.md` — a loadable JSails skill (on-demand
 *   knowledge), matching the framework's own `skills/<name>/SKILL.md` shape.
 *
 * Each file is written with exclusive creation: an existing file is never
 * overwritten (`.mcp.json` is merged instead), so a re-run is idempotent. The
 * command never runs an app config, opens a connection, or imports plugin code.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type { CommandModule } from '../descriptor.js';
import type { AGENTS_SETUP_OPTIONS } from '../manifest.js';
import { writeFailure } from '../report.js';

/** The packaged framework reader guide, resolved from the package root. */
const GUIDE_URL = new URL('../../../AGENTS.md', import.meta.url);

/** The `.mcp.json` server entry this command maintains. */
const MCP_SERVER_ENTRY = { command: 'jsails', args: ['mcp'] } as const;

/** Injectable filesystem seam for tests. */
export interface AgentsSetupDeps {
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly cwd: string;
}

/** Default deps over the real filesystem + process cwd. */
function defaultDeps(): AgentsSetupDeps {
  return {
    exists: existsSync,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    cwd: process.cwd(),
  };
}

/** The packaged reader guide, with graceful degradation to a one-line pointer. */
async function frameworkGuide(): Promise<string> {
  try {
    return await readFile(fileURLToPath(GUIDE_URL), 'utf8');
  } catch {
    return '# JSails\n\nSee https://jsails.org/docs/architecture for the framework guide.\n';
  }
}

/** Serialize `.mcp.json`, merging the `jsails` entry into an existing servers map. */
function buildMcpJson(existing: string | undefined): string {
  if (existing === undefined) {
    return `${JSON.stringify({ mcpServers: { jsails: MCP_SERVER_ENTRY } }, null, 2)}\n`;
  }
  try {
    const parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers ?? {};
    servers['jsails'] = MCP_SERVER_ENTRY;
    return `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`;
  } catch {
    // An unparseable existing file is not ours to fix; leave it untouched.
    return existing;
  }
}

/** The loadable JSails skill (on-demand agent knowledge). */
function jsailsSkill(): string {
  return `# JSails — how to work with this app

JSails is a TypeORM Active Record data layer plus a bounded application runtime:
filesystem routing, Hono HTTP, Preact SSR + islands, signed server components,
declarative migrations, a provider-neutral jobs runtime, and an extension system.

## Talk to it over MCP (preferred)

\`jsails mcp\` serves read-only tools; register it once (\`jsails agents:setup\`),
which writes the "jsails" entry into \`.mcp.json\`.

- \`jsails_describe\` — one-call snapshot of routes, plugins, and schema.
- \`jsails_inspect_routes\` — the route manifest.
- \`jsails_explain_route\` — which route handles a path and its pipeline.
- \`jsails_schema\` — the declarative entity schema (no connection).

## Read-only CLI introspection

- \`jsails inspect routes [--json]\`
- \`jsails describe [--json]\`
- \`jsails explain <path> [--json]\`

## Key conventions

- Pages: \`pages/**\`; API: \`api/**\`; compiled \`.js\` + TS source \`.ts\`.
- Plugin shape: a plugin declares \`needsLive: true\` when it cannot run statically;
  \`shape\` in \`jsails.app.js\` selects which plugins run (never the file layout).
- Declarative schema (\`jsails db:push\`): model definitions are the source of
  truth — there are no migration files or applied-state ledger.
- Value-free errors; ESM only (\`.js\` import extensions); \`npm run check\`
  typechecks, lints, format-checks, then runs the full test build.
`;
}

/** Run the command; returns the process exit code. */
export async function runAgentsSetupCommand(
  options: { readonly force: boolean },
  deps: AgentsSetupDeps = defaultDeps(),
): Promise<number> {
  const { force } = options;
  const root = deps.cwd;

  // .mcp.json — always merged, never clobbered.
  const mcpPath = resolve(root, '.mcp.json');
  const mcpExisting = deps.exists(mcpPath) ? await deps.readFile(mcpPath) : undefined;
  await deps.writeFile(mcpPath, buildMcpJson(mcpExisting));

  // AGENTS.md — the full framework guide; overwritten only with --force.
  const agentsPath = resolve(root, 'AGENTS.md');
  if (!deps.exists(agentsPath) || force) {
    await deps.writeFile(agentsPath, await frameworkGuide());
  }

  // .agents/skills/jsails/SKILL.md — the loadable skill; overwritten only with --force.
  const skillDir = resolve(root, '.agents', 'skills', 'jsails');
  const skillPath = resolve(skillDir, 'SKILL.md');
  if (!deps.exists(skillPath) || force) {
    await deps.mkdir(skillDir);
    await deps.writeFile(skillPath, jsailsSkill());
  }

  process.stdout.write(
    'Wrote .mcp.json (jsails MCP server), AGENTS.md, .agents/skills/jsails/SKILL.md\n',
  );
  return 0;
}

/** `jsails agents:setup [--force]`, its failures reported value-free. */
export const agentsSetupCommand: CommandModule<typeof AGENTS_SETUP_OPTIONS, 'nothing'> = {
  async run(context) {
    try {
      return await runAgentsSetupCommand(
        { force: context.values.force === true },
        { ...defaultDeps(), cwd: context.cwd },
      );
    } catch (error) {
      await writeFailure(error, (line) => context.stderr(line), {
        fallback: 'agents:setup failed',
        env: context.env,
      });
      return 1;
    }
  },
};
