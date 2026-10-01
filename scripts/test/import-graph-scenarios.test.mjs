/**
 * Tests for the loaded-set scenario processes (`scripts/import-graph/scenarios.mjs`,
 * `scenarios/serve.mjs`, and `scenarios/mcp.mjs`): the throwaway projects
 * resolve `jsails` through a link, the serve scenario drives a CLI that
 * listens, answers one request, and stops on SIGTERM, the MCP scenario one
 * that answers `tools/list` over stdio, and a CLI scenario's exit status is
 * part of its contract. Stand-in CLIs replace `jsails`, so no build is needed.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { probe } from '../import-graph/loaded-set.mjs';
import { SCENARIOS } from '../import-graph/policy.mjs';
import { CLI_SCENARIOS, prepareScenario, writeProject } from '../import-graph/scenarios.mjs';
import { repoRoot } from '../workspaces.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SERVE = join(repoRoot, 'scripts', 'import-graph', 'scenarios', 'serve.mjs');
const MCP = join(repoRoot, 'scripts', 'import-graph', 'scenarios', 'mcp.mjs');

/** A stand-in module written to its own directory. */
function standIn(source) {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-fake-cli-'));
  dirs.push(dir);
  const file = join(dir, 'cli.mjs');
  writeFileSync(file, source);
  return file;
}

/** A stand-in for `jsails serve`: listens on loopback, prints the line, stops on SIGTERM. */
function fakeCli(status) {
  return standIn(`import { createServer } from 'node:http';
const server = createServer((req, res) => { res.statusCode = ${status}; res.end('ok'); });
server.listen(0, '127.0.0.1', () => {
  console.log('Serving at http://127.0.0.1:' + server.address().port + '/');
});
process.once('SIGTERM', () => server.close());
`);
}

describe('scenario projects', () => {
  it('write the files and link jsails to core/', () => {
    const dir = writeProject(repoRoot, { 'api/hello.js': 'export const x = 1;\n' });
    dirs.push(dir);
    assert.equal(readFileSync(join(dir, 'api', 'hello.js'), 'utf8'), 'export const x = 1;\n');
    assert.equal(
      realpathSync(join(dir, 'node_modules', 'jsails')),
      realpathSync(join(repoRoot, 'core')),
    );
    assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"type": "module"/);
  });

  it('prepare each policy scenario, and clean up after themselves', () => {
    for (const name of Object.keys(SCENARIOS)) {
      const scenario = prepareScenario(name, repoRoot);
      assert.ok(['main', 'scenario'].includes(scenario.target.mode), name);
      if (scenario.cwd !== repoRoot) {
        assert.ok(existsSync(join(scenario.cwd, 'node_modules', 'jsails')), name);
        assert.equal(
          existsSync(join(scenario.cwd, 'jsails.app.js')),
          !(name in CLI_SCENARIOS) || 'jsails.app.js' in (CLI_SCENARIOS[name].files ?? {}),
          `${name}: a CLI scenario configures an app only through its files`,
        );
        scenario.cleanup();
        assert.equal(existsSync(scenario.cwd), false, name);
      }
    }
    assert.throws(() => prepareScenario('nope', repoRoot), /unknown scenario nope/);
  });

  it('give every CLI scenario a policy and an expected exit status', () => {
    for (const [name, { argv, status, files }] of Object.entries(CLI_SCENARIOS)) {
      assert.ok(name in SCENARIOS, name);
      assert.ok(argv.length > 0, name);
      assert.ok([0, 1, 2].includes(status), name);
      assert.ok(files === undefined || Object.keys(files).length > 0, name);
    }
  });
});

describe('the serve scenario', () => {
  it('waits for the server, sends the request, and stops it', async () => {
    const cli = fakeCli(200);
    const record = await probe(
      { mode: 'scenario', file: SERVE, args: [cli, '/api/hello'] },
      {
        cwd: repoRoot,
      },
    );
    assert.ok(record.some(([url]) => url === 'node:http'));
  });

  it('fails when the request answers another status', async () => {
    const cli = fakeCli(403);
    await assert.rejects(
      probe({ mode: 'scenario', file: SERVE, args: [cli, '/api/hello'] }, { cwd: repoRoot }),
      /GET \/api\/hello answered 403, expected 200/,
    );
  });

  it('fails instead of waiting when the CLI never listens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-fake-cli-'));
    dirs.push(dir);
    const cli = join(dir, 'cli.mjs');
    writeFileSync(cli, "console.error('config failed'); process.exitCode = 1;\n");
    await assert.rejects(
      probe({ mode: 'scenario', file: SERVE, args: [cli, '/'] }, { cwd: repoRoot }),
      /the probe exited with/,
    );
  });
});

describe('a CLI scenario', () => {
  it('accepts the exit status it expects, and only that one', async () => {
    const cli = standIn("console.error('usage'); process.exitCode = 2;\n");
    const record = await probe(
      { mode: 'main', file: cli, argv: ['--x'], status: 2 },
      { cwd: repoRoot },
    );
    assert.ok(Array.isArray(record));
    await assert.rejects(
      probe({ mode: 'main', file: cli, argv: ['--x'] }, { cwd: repoRoot }),
      /the probe exited with 2/,
    );
  });
});

/** A stand-in for `jsails mcp`: answers each request line on stdout, ends with stdin. */
function fakeMcpCli(tools) {
  return standIn(`process.stdin.setEncoding('utf8');
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf('\\n'); end !== -1; end = buffered.indexOf('\\n')) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.id === undefined) continue;
    const result = message.method === 'tools/list' ? { tools: ${JSON.stringify(tools)} } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`);
}

describe('the MCP scenario', () => {
  it('sends the handshake and tools/list, then ends stdin', async () => {
    const cli = fakeMcpCli([{ name: 'jsails_describe' }]);
    const record = await probe({ mode: 'scenario', file: MCP, args: [cli] }, { cwd: repoRoot });
    assert.ok(record.some(([url]) => url === 'node:stream'));
  });

  it('fails when tools/list answers no tools', async () => {
    const cli = fakeMcpCli([]);
    await assert.rejects(
      probe({ mode: 'scenario', file: MCP, args: [cli] }, { cwd: repoRoot }),
      /answered tools\/list without tools/,
    );
  });
});
