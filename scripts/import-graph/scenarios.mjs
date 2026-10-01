/**
 * The scenario processes of the loaded-set gate, each a throwaway project and
 * a probe target:
 *
 * - `cli-help`: `jsails --help`, the bin, the CLI bootstrap and the global
 *   help (which reads the project's files and imports none of them).
 * - `cli-usage-error`, `cli-unknown-command`, `cli-create-help`,
 *   `cli-make-help`, `cli-db-diff-help`, `cli-queue-failed-help`,
 *   `cli-describe-help`, `cli-plugins-help`: one CLI invocation each in an
 *   empty project (see `CLI_SCENARIOS`), so a command whose usage error or
 *   help starts loading its implementation is caught.
 * - `cli-db-diff-no-config`: `jsails db:diff` in a project without
 *   `jsails.database.js`, so reporting the missing config stays free of the
 *   database layer.
 * - `cli-inspect-routes`: `jsails inspect routes` of an app, the path of every
 *   command that reads the app config without assembling the app, so the
 *   config loader stays free of the server stack.
 * - `cli-build`: `jsails build` of the same app, a static build.
 * - `mcp-ready`: `jsails mcp` from start to its first answered `tools/list`.
 * - `serve-first-request`: `jsails serve` of an app with one API route and no
 *   database, then `GET /api/hello`.
 * - `serve-first-request-database`: the same app with the database plugin over
 *   an in-memory SQLite data source, whose route runs one query.
 *
 * A project resolves `jsails` through a `node_modules/jsails` link to the
 * repo's `core/`, the way an installed app does.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SERVE = join(import.meta.dirname, 'scenarios', 'serve.mjs');
const MCP = join(import.meta.dirname, 'scenarios', 'mcp.mjs');

// An app config any command can read: `jsails build` and `inspect` never
// listen, so it needs no port or origin.
const STATIC_APP_CONFIG = `export default {};
`;

// Every API module states its access.
const HELLO_ROUTE = `export const authorize = () => true;

export function GET() {
  return Response.json({ ok: true });
}
`;

/**
 * The CLI scenarios that run one command line to completion, each in a
 * project of its own `files` (none for most): each covers a dispatch path the
 * others do not (a global-flag usage error, the project-command fallback, a
 * `flags` command's help, an `argv` command's help, an `argv` command that
 * parses its own help, a command with subcommands, a `flags` command whose
 * config module is missing, a command that reads the app config, and one that
 * assembles the app).
 */
export const CLI_SCENARIOS = Object.freeze({
  'cli-usage-error': { argv: ['--no-such-flag'], status: 2 },
  'cli-unknown-command': { argv: ['no-such-command'], status: 2 },
  'cli-create-help': { argv: ['create', '--help'], status: 0 },
  'cli-make-help': { argv: ['make:page', '--help'], status: 0 },
  'cli-db-diff-help': { argv: ['db:diff', '--help'], status: 0 },
  'cli-db-diff-no-config': { argv: ['db:diff'], status: 1 },
  'cli-queue-failed-help': { argv: ['queue:failed', '--help'], status: 0 },
  'cli-describe-help': { argv: ['describe', '--help'], status: 0 },
  'cli-plugins-help': { argv: ['plugins', '--help'], status: 0 },
  'cli-inspect-routes': {
    argv: ['inspect', 'routes'],
    status: 0,
    files: { 'jsails.app.js': STATIC_APP_CONFIG, 'api/hello.js': HELLO_ROUTE },
  },
  'cli-build': {
    argv: ['build'],
    status: 0,
    files: { 'jsails.app.js': STATIC_APP_CONFIG, 'api/hello.js': HELLO_ROUTE },
  },
});

// `jsails serve` outside development requires `server.origin`, and with it
// set any other Host is answered 421, so a scenario app is configured like a
// deployment: on a port chosen up front, with that address as its origin.
const appConfig = (port) => `export default {
  host: '127.0.0.1',
  port: ${port},
  server: { origin: 'http://127.0.0.1:${port}' },
};
`;

const databaseAppConfig = (port) => `import { databasePlugin } from 'jsails/database';

import { dataSource } from './db.js';

export default {
  host: '127.0.0.1',
  port: ${port},
  server: { origin: 'http://127.0.0.1:${port}' },
  extensions: [databasePlugin({ dataSource, initialize: true })],
};
`;

const DATABASE_MODULE = `import { fileURLToPath } from 'node:url';

import { JsailsDataSource } from 'jsails/database';

export const dataSource = new JsailsDataSource({
  type: 'sqljs',
  location: fileURLToPath(new URL('./data.sqlite', import.meta.url)),
  entities: [],
});
`;

const DATABASE_ROUTE = `import { dataSource } from '../db.js';

export const authorize = () => true;

export async function GET() {
  const rows = await dataSource.query('SELECT 1 AS one');
  return Response.json({ ok: rows.length === 1 });
}
`;

/** Writes `files` (`{ relativePath: text }`) into a new project linked to `core/`. */
export function writeProject(root, files) {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-scenario-'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module", "private": true }\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(
    join(root, 'core'),
    join(dir, 'node_modules', 'jsails'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return dir;
}

/**
 * A loopback port that was free a moment ago. Another process could take it
 * before the scenario listens; the scenario then fails to listen, loudly.
 */
function freePort() {
  const script =
    "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close(); });";
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
}

/**
 * The probe target and working directory of scenario `name`:
 * `{ target, cwd, cleanup() }`.
 */
export function prepareScenario(name, root) {
  const cli = join(root, 'core', 'dist', 'src', 'cli', 'bin.cjs');
  if (name === 'cli-help') {
    return { target: { mode: 'main', file: cli, argv: ['--help'] }, cwd: root, cleanup() {} };
  }
  if (name in CLI_SCENARIOS) {
    const { files = {}, ...target } = CLI_SCENARIOS[name];
    const dir = writeProject(root, files);
    return {
      target: { mode: 'main', file: cli, ...target },
      cwd: dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  if (name === 'mcp-ready') {
    const dir = writeProject(root, { 'jsails.app.js': appConfig(freePort()) });
    return {
      target: { mode: 'scenario', file: MCP, args: [cli] },
      cwd: dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  const files =
    name === 'serve-first-request'
      ? { 'jsails.app.js': appConfig(freePort()), 'api/hello.js': HELLO_ROUTE }
      : name === 'serve-first-request-database'
        ? {
            'jsails.app.js': databaseAppConfig(freePort()),
            'db.js': DATABASE_MODULE,
            'api/hello.js': DATABASE_ROUTE,
          }
        : undefined;
  if (files === undefined) throw new Error(`unknown scenario ${name}`);
  const dir = writeProject(root, files);
  return {
    target: { mode: 'scenario', file: SERVE, args: [cli, '/api/hello'] },
    cwd: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
