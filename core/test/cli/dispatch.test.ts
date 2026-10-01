/**
 * The dispatcher (`cli/dispatch.ts`) in process, on the paths that stop
 * before an environment is resolved (so nothing here touches `process.env`):
 * the globals before the command, unknown commands, a command's own usage
 * errors and help, and locating a command that is not built in (a missing
 * package, a name two sources claim, a built-in name a dependency or the
 * app claims, an Object.prototype key, an app command's generated help). A
 * command that runs is covered by the spawned suites.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { dispatch, jsailsVersion } from '../../src/cli/dispatch.js';
import { appliedEnvironment } from '../../src/environment/resolve.js';

const root = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'cli-dispatch-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const indexUrl = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;

/** A project of `files` (path to text) in a fresh directory. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = join(root, `case-${seq++}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** Run `jsails ...argv` in `cwd`, capturing what it prints. */
async function run(
  argv: readonly string[],
  cwd = project(),
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  let out = '';
  const err: string[] = [];
  const code = await dispatch(argv, {
    cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (line) => err.push(line),
  });
  return { code, out, err: err.join('\n') };
}

/** A dependency `name` of a project, declaring `commands`. */
function dependency(name: string, commands: readonly object[]): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      exports: { './cmd': './cmd.js' },
      jsails: { commands },
    }),
    [`node_modules/${name}/cmd.js`]: "throw new Error('imported');\n",
  };
}

describe('dispatch: the globals before the command', () => {
  it('prints the global help with no arguments, --help or -h', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const result = await run(argv);
      assert.equal(result.code, 0);
      assert.match(result.out, /^jsails - TypeScript application framework CLI\n/);
      assert.match(result.out, /^ {2}db:push {15}/m);
      assert.equal(result.err, '');
    }
  });

  it('prints the version of core with --version', async () => {
    const version = (
      JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
    assert.equal(await jsailsVersion(), version);
    const result = await run(['--version']);
    assert.deepEqual(result, { code: 0, out: `${version}\n`, err: '' });
  });

  it('refuses another flag before the command, and arguments after a global', async () => {
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['--bogus'], /only --env, --version and --help come before the command/],
      [['--config', 'x.js', 'build'], /only --env, --version and --help come before the command/],
      [['--env'], /--env requires an environment name/],
      [['--env='], /--env requires an environment name/],
      [['--env', '--help'], /--env requires an environment name/],
      [['--version', 'extra'], /--version takes no arguments/],
      [['--help', 'extra'], /--help takes no arguments/],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err, message);
      assert.match(result.err, /Run "jsails --help" for usage\./);
    }
  });

  it('names an unknown command only when it reads as a command name', async () => {
    const plain = await run(['deploy']);
    assert.equal(plain.code, 2);
    assert.match(plain.err, /^jsails: unknown command deploy$/m);
    const odd = await run(['token=hunter2']);
    assert.equal(odd.code, 2);
    assert.match(odd.err, /^jsails: unknown command$/m);
    assert.doesNotMatch(odd.err, /hunter2/);
  });

  it('finds no command under an Object.prototype key, so it is unknown like any other', async () => {
    const dir = project({ 'package.json': '{}' });
    const named = await run(['constructor'], dir);
    assert.deepEqual(
      { code: named.code, err: named.err.split('\n')[0] },
      { code: 2, err: 'jsails: unknown command constructor' },
    );
    for (const name of ['__proto__', 'hasOwnProperty', 'toString']) {
      const result = await run([name], dir);
      assert.equal(result.code, 2, name);
      assert.match(result.err, /^jsails: unknown command$/m, name);
    }
  });
});

describe('dispatch: a built-in command', () => {
  it('prints its generated help and stops at a usage error before resolving anything', async () => {
    const before = appliedEnvironment();
    const help = await run(['db:diff', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /^jsails db:diff - /);
    for (const argv of [
      ['db:diff', '--allow-destructive'],
      ['db:push', 'extra'],
      ['db:push', '--wait-lock'],
      ['--env', 'production', 'db:push', '--bogus'],
    ]) {
      const result = await run(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err, /Run "jsails db:(?:push|diff) --help" for usage\./);
    }
    assert.equal(appliedEnvironment(), before, 'no environment was resolved');
  });

  it('runs a command that needs nothing without resolving an environment', async () => {
    const before = appliedEnvironment();
    const dir = project();
    const result = await run(['make:api', 'health', '--dir', dir], dir);
    assert.equal(result.code, 0, result.err);
    assert.equal(appliedEnvironment(), before);
  });
});

describe('dispatch: commands that are not built in', () => {
  it('hints at the package of a first-party command the project does not install', async () => {
    const result = await run(['config:export'], project({ 'package.json': '{}' }));
    assert.equal(result.code, 1);
    assert.match(
      result.err,
      /^jsails: command config:export comes from @jsails\/config, which this project does not install/,
    );
    assert.match(result.err, /install that package with npm/);
  });

  it('refuses a name two dependencies declare, and one a dependency and the app declare', async () => {
    const command = { name: 'sync:run', summary: 'Sync', module: 'a-tools/cmd' };
    const twice = project({
      'package.json': JSON.stringify({ dependencies: { 'a-tools': '1', 'b-tools': '1' } }),
      ...dependency('a-tools', [command]),
      ...dependency('b-tools', [{ ...command, module: 'b-tools/cmd' }]),
    });
    const both = await run(['sync:run'], twice);
    assert.equal(both.code, 1);
    assert.match(both.err, /^jsails: command sync:run is declared by both a-tools and b-tools/);

    const shadowed = project({
      'package.json': JSON.stringify({ dependencies: { 'a-tools': '1' } }),
      ...dependency('a-tools', [command]),
      'dist/commands/sync/run.js': "throw new Error('imported');\n",
    });
    const app = await run(['sync:run'], shadowed);
    assert.equal(app.code, 1);
    assert.match(app.err, /declared by both a-tools and dist\/commands\/sync\/run\.js/);
  });

  it('refuses a built-in whose name a dependency or the app claims, after its usage checks', async () => {
    const before = appliedEnvironment();
    const dir = project({
      'package.json': JSON.stringify({ dependencies: { 'a-tools': '1' } }),
      ...dependency('a-tools', [{ name: 'build', summary: 'Mine', module: 'a-tools/cmd' }]),
    });
    const help = await run(['--help'], dir);
    assert.match(help.out, /^Problems:\n {2}a-tools: command build is also declared by jsails$/m);
    assert.doesNotMatch(help.out, /Commands from dependencies:/);

    const claimed = await run(['build'], dir);
    assert.equal(claimed.code, 1);
    assert.match(claimed.err, /^jsails: a-tools declares command build, which is built in$/m);
    assert.equal((await run(['build', '--help'], dir)).code, 0, "the built-in's help still prints");
    assert.equal((await run(['build', '--bogus'], dir)).code, 2, 'a usage error comes first');

    const app = project({ 'dist/commands/make/api.js': "throw new Error('imported');\n" });
    const shadowed = await run(['make:api', 'health', '--dir', app], app);
    assert.equal(shadowed.code, 1);
    assert.match(
      shadowed.err,
      /^jsails: dist\/commands\/make\/api\.js declares command make:api, which is built in$/m,
    );
    assert.equal(existsSync(join(app, 'api')), false, 'the built-in did not run');
    assert.equal(appliedEnvironment(), before, 'no environment was resolved');
  });

  it("prints an app command's generated help from its definition, resolving nothing", async () => {
    const before = appliedEnvironment();
    const dir = project({
      'dist/commands/invoices/send.js': [
        `import { defineCommand } from '${indexUrl}';`,
        'export default defineCommand({',
        "  summary: 'Send one invoice',",
        "  options: { force: { type: 'boolean', summary: 'Send it again' } },",
        "  positionals: [{ name: 'id', summary: 'The invoice id' }],",
        "  run() { throw new Error('ran'); },",
        '});',
        '',
      ].join('\n'),
    });
    const result = await run(['invoices:send', '--help'], dir);
    assert.equal(result.code, 0, result.err);
    assert.equal(
      result.out,
      [
        'jsails invoices:send - Send one invoice',
        '',
        'Usage:',
        '  jsails invoices:send [options] <id>',
        '',
        'Arguments:',
        '  <id>    The invoice id',
        '',
        'Options:',
        '      --force           Send it again',
        '  -n, --no-interaction  Never prompt; a question fails the command',
        '  -h, --help            Show this help',
        '',
      ].join('\n'),
    );
    assert.equal(appliedEnvironment(), before);
  });

  it('refuses a module whose default export defineCommand did not make, value-free', async () => {
    const dir = project({
      'dist/commands/plain.js': "export default { summary: 'x', run() {} };\n",
      'dist/commands/broken.js': "throw new Error('password=hunter2');\n",
    });
    const plain = await run(['plain', '--help'], dir);
    assert.equal(plain.code, 1);
    assert.match(plain.err, /^jsails: command plain from plain\.js is invalid: not_defined/);
    const broken = await run(['broken', '--help'], dir);
    assert.equal(broken.code, 1);
    assert.match(broken.err, /^jsails: command broken failed to load from broken\.js/);
    assert.doesNotMatch(broken.err, /hunter2/);
  });
});
