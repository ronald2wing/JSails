/**
 * `jsails mcp` argument handling, run as the real CLI: the help describes the
 * current protocol (server/discover, the 2025 fallback, stdout purity, exit on
 * end of input and signals) and lists the tools, and usage errors exit 2 with
 * nothing on stdout.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../src/cli/bin.cjs', import.meta.url));

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, 'mcp', ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('jsails mcp', () => {
  for (const flag of ['--help', '-h']) {
    it(`prints the current protocol help for ${flag}`, () => {
      const { code, stdout, stderr } = run(flag);
      assert.equal(code, 0);
      assert.equal(stderr, '');
      for (const text of [
        'Usage:',
        '--config <path>',
        '--db-config <path>',
        '2026-07-28',
        'server/discover',
        'initialize handshake',
        'nothing else is written to',
        'stdin closes, or on SIGINT or SIGTERM',
        'jsails_describe',
        'jsails_inspect_routes',
        'jsails_explain_route',
        'jsails_schema',
      ]) {
        assert.ok(stdout.includes(text), `help mentions ${text}`);
      }
      assert.ok(!/\bping\b/.test(stdout), 'help does not claim ping');
    });
  }

  for (const [args, message] of [
    [['--config'], '--config requires a value'],
    [['--db-config'], '--db-config requires a value'],
    [['--verbose'], 'unknown option --verbose'],
    [['extra'], 'mcp takes no arguments'],
  ] as const) {
    it(`exits 2 for ${args.join(' ')}`, () => {
      const { code, stdout, stderr } = run(...args);
      assert.equal(code, 2);
      assert.equal(stdout, '');
      assert.ok(stderr.includes(message), stderr);
    });
  }

  it('serves and exits 0 when stdin is already closed', () => {
    const { code, stdout, stderr } = run(
      '--config=jsails.app.js',
      '--db-config=jsails.database.js',
    );
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /jsails MCP server starting \(config: jsails\.app\.js\)/);
  });
});
