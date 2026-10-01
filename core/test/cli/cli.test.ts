/**
 * End-to-end tests of the `jsails` executable: help output, argument handling,
 * config loading, and audience-aware dispatch, run as a subprocess against
 * fixture projects.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { CLI_SUITE_CONCURRENCY, runCli as spawnCli, type ProcessResult } from './spawn-cli.js';

/**
 * End-to-end CLI tests that spawn the compiled CLI as a real process. No live
 * database is ever contacted: `db:push`/`db:diff` reconcile the declared model
 * schema against the live schema, so these cases exercise only argument
 * handling and config loading, which fail before any connection is opened.
 * Audience-aware dispatch, which never loads an app config for a discovered
 * user command, runs entirely offline.
 */

const indexUrl = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;

// Fixtures live under dist/ so bare `typeorm` imports resolve to the repo's
// node_modules; the jsails package itself is imported via its built file URL.
const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'cli-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): Promise<ProcessResult> {
  return spawnCli(args, { cwd });
}

function emptyDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a compiled command module under `dir/commands/<filename>` (creates parents). */
function writeCommandModule(dir: string, filename: string, body: string): void {
  const filePath = join(dir, 'commands', filename);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

describe('cli: help and argument handling', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('prints help on --help without importing the config', async () => {
    const dir = emptyDir('help');
    const result = await runCli(['--help'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /db:push/);
    assert.match(result.stdout, /db:diff/);
    assert.match(result.stdout, /--allow-destructive/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /create <dir>/);
    assert.match(result.stdout, /^ {2}dev\s/m);
  });

  it("loads no third-party package for help, usage errors, or a command's help", async () => {
    // A module-load hook records every module each process loads. Help text,
    // usage errors, and an argv command's own help are answered from the
    // command table and the command's argument parser alone: no Zod (the app
    // config schema), no server stack, no data layer. One command parses with
    // a module of its own domain: `queue:failed` bounds `--limit` with the
    // failed-job history's limit, whose module loads the job helpers.
    const dir = emptyDir('help-modules');
    const hookPath = join(dir, 'record-loads.mjs');
    writeFileSync(
      hookPath,
      [
        "import { registerHooks } from 'node:module';",
        "import { writeFileSync } from 'node:fs';",
        'const loaded = [];',
        'registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });',
        "process.on('exit', () => writeFileSync(process.env.LOADED_REPORT, JSON.stringify(loaded)));",
        '',
      ].join('\n'),
    );
    const invocations: readonly (readonly [readonly string[], number, readonly string[]])[] = [
      [['--help'], 0, []],
      [['--no-such-flag'], 2, []],
      [['create', '--help'], 0, []],
      [['make:page', '--help'], 0, []],
      [['inspect', '--help'], 0, []],
      [['describe', '--help'], 0, []],
      [['explain', '--help'], 0, []],
      [['app:shape', '--help'], 0, []],
      [['i18n:missing', '--help'], 0, []],
      [['console', '--help'], 0, []],
      [['queue:failed', '--help'], 0, ['es-toolkit']],
      [['mcp', '--help'], 0, []],
      [['credentials', '--help'], 0, []],
      [['agents:setup', '--help'], 0, []],
      [['plugins', '--help'], 0, []],
      [['build:meta', '--help'], 0, []],
      [['inject:auto-imports', '--help'], 0, []],
      [['test', '--help'], 0, []],
    ];
    await Promise.all(
      invocations.map(async ([args, status, allowed], index) => {
        const label = `jsails ${args.join(' ')}`;
        const reportPath = join(dir, `loaded-${index}.json`);
        const result = await spawnCli(args, {
          cwd: dir,
          env: { ...process.env, LOADED_REPORT: reportPath },
          nodeArgs: ['--import', pathToFileURL(hookPath).href],
        });
        assert.equal(result.status, status, `${label}: ${result.stderr}`);
        const loaded = JSON.parse(readFileSync(reportPath, 'utf8')) as string[];
        assert.ok(
          loaded.some((url) => url.endsWith('/src/cli/index.js')),
          `${label}: the hook saw the CLI`,
        );
        const packages = new Set(
          loaded.flatMap((url) => {
            const match = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
            return match?.[1] === undefined ? [] : [match[1]];
          }),
        );
        assert.deepEqual(
          [...packages].filter((name) => !allowed.includes(name)),
          [],
          `${label} loaded third-party packages`,
        );
      }),
    );
  });

  it('rejects an unknown command', async () => {
    const result = await runCli(['bogus'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command/);
  });

  it('rejects the removed live:list and convert:component as unknown commands', async () => {
    const commands = ['live:list', 'convert:component'];
    const results = await Promise.all(commands.map((command) => runCli([command], fixturesRoot)));
    commands.forEach((command, index) => {
      const result = results[index]!;
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /unknown command/);
    });
  });

  it('lists neither removed command in the global help', async () => {
    const result = await runCli(['--help'], fixturesRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /live:list|convert:component/);
  });

  it('rejects an unknown flag', async () => {
    const result = await runCli(['db:push', '--bogus'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown option/);
  });

  it('rejects a missing command', async () => {
    const result = await runCli([], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /command is required/);
  });

  it('rejects --allow-destructive on db:diff', async () => {
    const result = await runCli(['db:diff', '--allow-destructive'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only valid for db:push/);
  });

  it('rejects --dry-run on db:diff', async () => {
    const result = await runCli(['db:diff', '--dry-run'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only valid for db:push/);
  });

  it('rejects unexpected positional arguments', async () => {
    const result = await runCli(['db:push', 'extra'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unexpected argument/);
  });

  it('answers --help of the flag-only commands without running them', async () => {
    const commands = ['build:meta', 'inject:auto-imports', 'test'];
    await Promise.all(
      commands.map(async (command) => {
        const dir = emptyDir(`own-help-${command.replace(':', '-')}`);
        const result = await runCli([command, '--help'], dir);
        assert.equal(result.status, 0, `${command}: ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`^${command} - `), command);
        assert.match(result.stdout, new RegExp(`Usage:\\n  jsails ${command}`), command);
        assert.equal(existsSync(join(dir, '.jsails')), false, `${command} wrote .jsails/`);
      }),
    );
  });

  it('rejects an unknown flag or an argument to a flag-only command before running it', async () => {
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['build:meta', '--bogus'], /Unknown option '--bogus'/],
      [['build:meta', 'extra'], /Unexpected argument 'extra'/],
      [['build:meta', '--dir'], /argument missing/],
      [['inject:auto-imports', '--bogus'], /Unknown option '--bogus'/],
      [['test', '--bogus'], /Unknown option '--bogus'/],
    ];
    await Promise.all(
      cases.map(async ([args, message]) => {
        const dir = emptyDir(`own-usage-${args.join('-').replace(/[:]/g, '-')}`);
        const result = await runCli([...args], dir);
        const label = args.join(' ');
        assert.equal(result.status, 2, `${label}: ${result.stderr}`);
        assert.match(result.stderr, message, label);
        assert.match(result.stderr, new RegExp(`Run "jsails ${args[0]} --help" for usage.`), label);
        assert.equal(existsSync(join(dir, '.jsails')), false, `${label} wrote .jsails/`);
      }),
    );
  });
});

describe('cli: config loading', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('fails with a clear error when the config is missing', async () => {
    const dir = emptyDir('missing-config');
    const result = await runCli(['db:push', '--config', 'nope.js'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load config/);
    assert.doesNotMatch(result.stderr, /password/);
  });

  it('rejects a TypeScript config path with a compile hint', async () => {
    const dir = emptyDir('ts-config');
    const result = await runCli(['db:push', '--config', 'jsails.database.ts'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compile it to JavaScript first/);
  });

  it('never prints data source credentials', async () => {
    const dir = emptyDir('no-creds');
    writeFileSync(
      join(dir, 'jsails.database.js'),
      `
import { JsailsDataSource } from '${indexUrl}';
const ds = new JsailsDataSource({
  type: 'postgres', host: 'h', port: 5432,
  username: 'secret-user', password: 'super-secret-123', database: 'd',
  entities: [],
});
throw new Error('deliberate config failure');
export default ds;
`,
    );
    const result = await runCli(['db:push'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deliberate config failure/);
    assert.doesNotMatch(result.stderr, /super-secret-123/);
    assert.doesNotMatch(result.stderr, /secret-user/);
  });
});

describe('cli: audience-aware dispatch and help', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('global --help lists both sections with a discovered user command and imports no config', async () => {
    const dir = emptyDir('audience-global-help');
    // A config that would write a marker if imported: proves --help never loads it.
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default { commands: [] };
`,
    );
    writeCommandModule(
      dir,
      'login.js',
      `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'login {--no-open}',
  summary: 'Sign in from the CLI via a browser approval page',
  audience: 'user',
  run() { return 0; },
});
`,
    );

    const result = await runCli(['--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Developer commands:/);
    assert.match(result.stdout, /User commands:/);
    assert.match(result.stdout, /login - Sign in from the CLI via a browser approval page/);
    assert.equal(existsSync(join(dir, 'imported.marker')), false, 'config was not imported');
  });

  it('--no-interaction fails a prompting command instead of blocking', async () => {
    const dir = emptyDir('no-interaction');
    writeCommandModule(
      dir,
      'ask.js',
      `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'ask',
  summary: 'Ask for input',
  async run(_input, ctx) { await ctx.prompter.text('Name?'); return 0; },
});
`,
    );

    const result = await runCli(['ask', '--no-interaction'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /interactive input is not available/);
  });

  it('labels a discovered command as a user command in `jsails <cmd> --help`', async () => {
    const dir = emptyDir('audience-user-help');
    writeCommandModule(
      dir,
      'login.js',
      `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'login {--no-open}',
  summary: 'Sign in from the CLI via a browser approval page',
  audience: 'user',
  run() { return 0; },
});
`,
    );

    const result = await runCli(['login', '--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /login - Sign in from the CLI via a browser approval page/);
    assert.match(result.stdout, /Audience: user command/);
    assert.match(result.stdout, /jsails login \[--no-open\]/);
  });

  it('labels a config-declared command as a developer command in `jsails <cmd> --help`', async () => {
    const dir = emptyDir('audience-developer-help');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `export default { commands: [{ name: 'deploy', summary: 'deploy it', run() { return 0; } }] };
`,
    );

    const result = await runCli(['deploy', '--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Audience: developer command/);
    assert.match(result.stdout, /deploy - deploy it/);
  });

  it('runs a discovered user command without loading a present app config', async () => {
    const dir = emptyDir('audience-user-skips-config');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default { commands: [{ name: 'deploy', summary: 'deploy', run() { return 0; } }] };
`,
    );
    writeCommandModule(
      dir,
      'login.js',
      `export default { name: 'login', summary: 'Sign in', audience: 'user', run(rawArgs, ctx) { ctx.stdout('logged in'); } };
`,
    );

    const result = await runCli(['login'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'logged in\n');
    assert.equal(
      existsSync(join(dir, 'imported.marker')),
      false,
      'user command must not import the config',
    );
  });

  it('loads the app config for a config-declared developer command', async () => {
    const dir = emptyDir('audience-developer-loads-config');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default { commands: [{ name: 'deploy', summary: 'deploy', run(rawArgs, ctx) { ctx.stdout('deployed'); } }] };
`,
    );

    const result = await runCli(['deploy'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'deployed\n');
    assert.equal(
      existsSync(join(dir, 'imported.marker')),
      true,
      'developer command loads the config',
    );
  });
});
