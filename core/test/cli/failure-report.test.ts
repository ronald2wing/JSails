/**
 * The built `jsails` binary explaining a failure: an app config with a syntax
 * error (in itself or in a module it imports) is reported with its file, line
 * and column and the error's class, never the source or the parser's message,
 * until `JSAILS_DEBUG=1` in the process environment asks for them; a project
 * file cannot set it. The exit code is the one the command had before.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { DEBUG_NOTE } from '../../src/errors/cause-chain.server.js';
import { mapConcurrently, runCli, type ProcessResult } from './spawn-cli.js';

const SECRET = 'sk_live_FAKE0123456789';

const root = mkdtempSync(join(tmpdir(), 'jsails-failure-report-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A project directory under the temporary root holding `files`. */
function makeProject(name: string, files: Readonly<Record<string, string>>): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

const project = makeProject('own', {
  'jsails.app.js': `export default {\n  authorize: () => true,\n  port: 3000 ${SECRET}: 1,\n};\n`,
});

/**
 * The test process's environment without the variables that change a CLI run
 * (every `JSAILS_*` control variable, `NODE_OPTIONS`, `NODE_ENV`): the CLI
 * picks its own environment, so the failure is the project's alone.
 */
function childEnv(debug: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('JSAILS_') || name === 'NODE_OPTIONS' || name === 'NODE_ENV') continue;
    env[name] = value;
  }
  return debug ? { ...env, JSAILS_DEBUG: '1' } : env;
}

const COMMANDS = [['build'], ['inspect', 'routes']] as const;

function run(args: readonly string[], debug: boolean, cwd = project): Promise<ProcessResult> {
  return runCli(args, { cwd, env: childEnv(debug) });
}

describe('jsails failure report: an app config with a syntax error', () => {
  it('names the place and the error class, and none of the source', async () => {
    for (const [args, result] of await mapConcurrently(COMMANDS, (args) => run(args, false))) {
      const label = args.join(' ');
      assert.equal(result.status, 1, label);
      assert.deepEqual(
        result.stderr.trimEnd().split('\n'),
        [
          'jsails: failed to load app config "jsails.app.js"',
          '  caused by: syntax error at jsails.app.js:3:14',
          '  caused by: SyntaxError',
          DEBUG_NOTE,
        ],
        label,
      );
      assert.ok(!result.stderr.includes(SECRET), label);
    }
  });

  it('prints the parser message under JSAILS_DEBUG=1, and no note', async () => {
    for (const [args, result] of await mapConcurrently(COMMANDS, (args) => run(args, true))) {
      const label = args.join(' ');
      assert.equal(result.status, 1, label);
      const lines = result.stderr.trimEnd().split('\n');
      assert.deepEqual(
        lines.slice(0, 4),
        [
          'jsails: failed to load app config "jsails.app.js"',
          '  caused by: syntax error at jsails.app.js:3:14',
          '  caused by: SyntaxError',
          `      Unexpected identifier '${SECRET}'`,
        ],
        label,
      );
      assert.ok(!lines.includes(DEBUG_NOTE), label);
    }
  });
});

describe('jsails failure report: a syntax error in a module the config imports', () => {
  it('names the place in that module', async () => {
    const dir = makeProject('imported', {
      'jsails.app.js':
        "import { port } from './lib/settings.js';\nexport default { authorize: () => true, port };\n",
      'lib/settings.js': `export const port = 3000 ${SECRET};\n`,
    });
    const result = await run(['build'], false, dir);
    assert.equal(result.status, 1);
    assert.deepEqual(result.stderr.trimEnd().split('\n'), [
      'jsails: failed to load app config "jsails.app.js"',
      '  caused by: syntax error at lib/settings.js:1:26',
      '  caused by: SyntaxError',
      DEBUG_NOTE,
    ]);
  });
});

describe('jsails failure report: JSAILS_DEBUG in a project file', () => {
  it('is refused, so a committed file cannot turn full detail on', async () => {
    const dir = makeProject('dotenv', {
      '.env': 'JSAILS_DEBUG=1\n',
      'jsails.app.js': `export default { port: 3000 ${SECRET} };\n`,
    });
    const result = await run(['build'], false, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^jsails: environment\.reserved_key: \.env defines JSAILS_DEBUG/);
    assert.ok(!result.stderr.includes(SECRET));
  });
});
