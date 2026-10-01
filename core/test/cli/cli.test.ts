/**
 * End-to-end tests of the `jsails` executable: help output, argument handling,
 * config loading, and the commands of dependencies and of the app, run as a
 * subprocess against fixture projects.
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
 * A dependency's or the app's command runs offline too: it resolves the
 * environment, then opens only the stages its `needs` asks for.
 */

const indexUrl = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;
const kernelUrl = pathToFileURL(
  fileURLToPath(new URL('../../src/kernel/index.js', import.meta.url)),
).href;
const errorsUrl = pathToFileURL(
  fileURLToPath(new URL('../../src/errors/index.js', import.meta.url)),
).href;

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

// A module-load hook that records every module URL a process loads into the
// file named by LOADED_REPORT when the process exits.
const recordLoadsHook = join(fixturesRoot, 'record-loads.mjs');
writeFileSync(
  recordLoadsHook,
  [
    "import { registerHooks } from 'node:module';",
    "import { writeFileSync } from 'node:fs';",
    'const loaded = [];',
    'registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });',
    "process.on('exit', () => writeFileSync(process.env.LOADED_REPORT, JSON.stringify(loaded)));",
    '',
  ].join('\n'),
);

/**
 * Run the CLI in `dir` under {@link recordLoadsHook} and return the result, every
 * module URL the process loaded, and the third-party packages among them.
 * `label` names the report file, unique per concurrent run in one `dir`.
 */
async function runRecordingLoads(
  args: readonly string[],
  dir: string,
  label: string,
): Promise<{ result: ProcessResult; loaded: string[]; packages: Set<string> }> {
  const reportPath = join(dir, `loaded-${label.replace(/[^\w-]/g, '-')}.json`);
  const result = await spawnCli(args, {
    cwd: dir,
    env: { ...process.env, LOADED_REPORT: reportPath },
    nodeArgs: ['--import', pathToFileURL(recordLoadsHook).href],
  });
  const loaded = JSON.parse(readFileSync(reportPath, 'utf8')) as string[];
  assert.ok(
    loaded.some((url) => url.endsWith('/src/cli/index.js')),
    `jsails ${args.join(' ')}: the hook saw the CLI`,
  );
  const packages = new Set(
    loaded.flatMap((url) => {
      const match = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
      return match?.[1] === undefined ? [] : [match[1]];
    }),
  );
  return { result, loaded, packages };
}

/** Write a built app command under `dir/dist/commands/<filename>` (creates parents). */
function writeAppCommand(dir: string, filename: string, body: string): void {
  const filePath = join(dir, 'dist', 'commands', filename);
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
    assert.match(result.stdout, /^ {2}create\s+Scaffold a fresh JSails application$/m);
    assert.match(result.stdout, /^ {2}dev\s/m);
    assert.match(result.stdout, /^App commands \(dist\/commands\/\):\n {2}none$/m);
  });

  it('reports a missing database config without loading the database layer', async () => {
    // The config is loaded and checked before the schema layer is imported, so
    // the failure costs the config loader alone and reads as it always has.
    const dir = emptyDir('db-no-config');
    await Promise.all(
      ['db:diff', 'db:push'].map(async (command) => {
        const { result, packages, loaded } = await runRecordingLoads([command], dir, command);
        assert.equal(result.status, 1, `${command}: ${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^jsails: config jsails\.database\.js was not found\n  hint: /);
        assert.equal(result.stderr.split('\n').filter(Boolean).length, 2, result.stderr);
        assert.deepEqual([...packages], [], `${command} loaded third-party packages`);
        assert.equal(
          loaded.some((url) => /\/src\/(?:migrations\/|cli\/commands\/db-schema\.js)/.test(url)),
          false,
          `${command} loaded the schema layer`,
        );
      }),
    );
  });

  it('builds a static site without loading the HTTP pipeline or the node server', async () => {
    const dir = emptyDir('build-modules');
    writeFileSync(join(dir, 'jsails.app.js'), 'export default {};\n');
    mkdirSync(join(dir, 'pages'));
    writeFileSync(
      join(dir, 'pages', 'index.js'),
      "import { h } from 'preact';\nexport default function Home() { return h('p', null, 'home'); }\n",
    );
    const { result, packages, loaded } = await runRecordingLoads(['build'], dir, 'build');
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(dir, 'out', 'index.html'), 'utf8'), /<p>home<\/p>/);
    assert.deepEqual(
      [...packages].filter((name) => name === 'hono' || name.startsWith('@hono/')),
      [],
      'build loaded the server stack',
    );
    assert.equal(
      loaded.some((url) => /\/src\/(?:app\/(?:http-pipeline|serve)|server\/app)\.js$/.test(url)),
      false,
      'build loaded the HTTP pipeline',
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
    assert.match(result.stderr, /^jsails: unknown option --bogus$/m);
  });

  it('prints the global help without a command', async () => {
    const result = await runCli([], fixturesRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Commands:$/m);
  });

  it('rejects the push-only flags on db:diff as unknown options', async () => {
    for (const flag of ['--allow-destructive', '--dry-run']) {
      const result = await runCli(['db:diff', flag], fixturesRoot);
      assert.equal(result.status, 2);
      assert.match(result.stderr, new RegExp(`unknown option ${flag}`));
    }
  });

  it('rejects unexpected positional arguments without echoing them', async () => {
    const result = await runCli(['db:push', 'extra'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /db:push takes no arguments/);
    assert.doesNotMatch(result.stderr, /extra/);
  });

  it('answers --help of the flag-only commands without running them', async () => {
    const commands = ['build:meta', 'inject:auto-imports', 'test'];
    await Promise.all(
      commands.map(async (command) => {
        const dir = emptyDir(`own-help-${command.replace(':', '-')}`);
        const result = await runCli([command, '--help'], dir);
        assert.equal(result.status, 0, `${command}: ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`^jsails ${command} - `), command);
        assert.match(result.stdout, new RegExp(`Usage:\\n  jsails ${command}`), command);
        assert.equal(existsSync(join(dir, '.jsails')), false, `${command} wrote .jsails/`);
      }),
    );
  });

  it('rejects an unknown flag or an argument to a flag-only command before running it', async () => {
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['build:meta', '--bogus'], /unknown option --bogus/],
      [['build:meta', 'extra'], /build:meta takes no arguments/],
      [['build:meta', '--dir'], /--dir requires a value/],
      [['inject:auto-imports', '--bogus'], /unknown option --bogus/],
      [['test', '--bogus'], /unknown option --bogus/],
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
    assert.match(result.stderr, /config nope\.js was not found/);
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
    assert.match(result.stderr, /failed to load config jsails\.database\.js/);
    assert.doesNotMatch(result.stderr, /deliberate config failure/);
    assert.doesNotMatch(result.stderr, /super-secret-123/);
    assert.doesNotMatch(result.stderr, /secret-user/);
  });
});

describe(
  'cli: commands of dependencies and of the app',
  { concurrency: CLI_SUITE_CONCURRENCY },
  () => {
    it('runs an app command by its path, with its values, positionals and environment', async () => {
      const dir = emptyDir('app-command-run');
      writeAppCommand(
        dir,
        'invoices/send.js',
        `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  summary: 'Send one invoice',
  options: { force: { type: 'boolean', summary: 'Send it again' } },
  positionals: [{ name: 'id', summary: 'The invoice id' }],
  run(ctx) {
    ctx.stdout(JSON.stringify({
      name: ctx.name,
      force: ctx.values.force === true,
      positionals: ctx.positionals,
      environment: ctx.environment,
      nodeEnv: ctx.env.NODE_ENV,
    }));
    return 3;
  },
});
`,
      );

      const result = await runCli(['--env', 'test', 'invoices:send', '42', '--force'], dir);

      assert.equal(result.status, 3, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        name: 'invoices:send',
        force: true,
        positionals: ['42'],
        environment: 'test',
        nodeEnv: 'test',
      });
    });

    it('caches the summary of an app command it ran, for help, until the file changes', async () => {
      const dir = emptyDir('app-command-summary');
      const body = (summary: string) => `import { defineCommand } from '${indexUrl}';
export default defineCommand({ summary: '${summary}', run() {} });
`;
      writeAppCommand(dir, 'hello.js', body('Say hello'));

      const before = await runCli(['--help'], dir);
      assert.match(before.stdout, /^ {2}hello$/m);
      assert.equal((await runCli(['hello'], dir)).status, 0);
      const after = await runCli(['--help'], dir);
      assert.match(after.stdout, /^ {2}hello {17}Say hello$/m);

      writeAppCommand(dir, 'hello.js', body('Say hello again'));
      const stale = await runCli(['--help'], dir);
      assert.match(stale.stdout, /^ {2}hello$/m, 'an edited command shows no stale summary');
    });

    it('fails a question under --no-interaction instead of blocking', async () => {
      const dir = emptyDir('app-command-no-interaction');
      writeAppCommand(
        dir,
        'ask.js',
        `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  summary: 'Ask for input',
  async run(ctx) { await ctx.prompter.text('Name?'); },
});
`,
      );

      const result = await runCli(['ask', '--no-interaction'], dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /^jsails: the command asked a question, but it runs without interaction/m,
      );
    });

    it("echoes no message of an app command's own error", async () => {
      const dir = emptyDir('app-command-throws');
      writeAppCommand(
        dir,
        'leak.js',
        `import { defineCommand } from '${indexUrl}';
export default defineCommand({ summary: 'Leak', run() { throw new Error('password=hunter2'); } });
`,
      );

      const result = await runCli(['leak'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^jsails: the command failed$/m);
      assert.doesNotMatch(result.stderr, /hunter2/);
    });

    it('refuses an exit code that is no integer from 0 to 255', async () => {
      const dir = emptyDir('app-command-exit-code');
      writeAppCommand(
        dir,
        'odd.js',
        `import { defineCommand } from '${indexUrl}';
export default defineCommand({ summary: 'Odd', run() { return 256; } });
`,
      );

      const result = await runCli(['odd'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^jsails: command odd from app returned an invalid exit code/m);
    });

    /**
     * A project whose one plugin fails to close, and an app command `name`
     * over `needs` whose run throws `run_failed` when `fail` is set. Both
     * errors come from one registry, so the report may print both messages.
     */
    function teardownProject(name: string, needs: string, fail: boolean): string {
      const dir = emptyDir(`teardown-${name}`);
      const plugin = join(dir, 'teardown-plugin.mjs');
      writeFileSync(
        plugin,
        `import { definePlugin } from '${kernelUrl}';
import { defineErrors } from '${errorsUrl}';
export const TeardownErrors = defineErrors('teardown_fixture', {
  run_failed: { kind: 'internal', message: 'the command hit its own failure' },
  close_failed: { kind: 'internal', message: 'the plugin failed to close' },
});
export default definePlugin({
  name: 'teardown-fixture',
  setup() {
    return () => { throw new TeardownErrors.Error('close_failed'); };
  },
});
`,
      );
      writeFileSync(
        join(dir, 'jsails.app.js'),
        `export default { plugins: { use: [${JSON.stringify(pathToFileURL(plugin).href)}] } };\n`,
      );
      writeAppCommand(
        dir,
        `${name}.js`,
        `import { defineCommand } from '${indexUrl}';
import { TeardownErrors } from ${JSON.stringify(pathToFileURL(plugin).href)};
export default defineCommand({
  summary: 'Fail',
  needs: ${needs},
  run(ctx) {
    ctx.stdout('ran');
    ${fail ? "throw new TeardownErrors.Error('run_failed');" : ''}
  },
});
`,
      );
      return dir;
    }

    it("reports a failed teardown alongside the run's own failure, never in its place", async () => {
      for (const needs of ['{ services: [] }', '{ kernel: [] }']) {
        const name = needs.includes('kernel') ? 'kernel' : 'services';
        const result = await runCli([name], teardownProject(name, needs, true));
        assert.equal(result.status, 1, `${needs}: ${result.stderr}`);
        assert.equal(result.stdout, 'ran\n', needs);
        assert.match(result.stderr, /the command hit its own failure/, needs);
        assert.match(result.stderr, /the plugin failed to close/, needs);
      }
    });

    it("fails a command whose teardown fails, a kernel's shutdown report included", async () => {
      for (const needs of ['{ services: [] }', '{ kernel: [] }']) {
        const name = needs.includes('kernel') ? 'kernel-ok' : 'services-ok';
        const result = await runCli([name], teardownProject(name, needs, false));
        assert.equal(result.status, 1, `${needs}: ${result.stderr}`);
        assert.equal(result.stdout, 'ran\n', needs);
        assert.match(result.stderr, /the plugin failed to close/, needs);
      }
    });

    it("runs a dependency's command from its jsails.commands, with the app's services set up", async () => {
      const dir = emptyDir('dependency-command');
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { 'greeting-tools': '1.0.0' } }),
      );
      const pkg = join(dir, 'node_modules', 'greeting-tools');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: 'greeting-tools',
          type: 'module',
          exports: { './greet': './greet.js' },
          jsails: {
            commands: [
              { name: 'greet', summary: 'Greet from the app', module: 'greeting-tools/greet' },
            ],
          },
        }),
      );
      writeFileSync(
        join(pkg, 'greet.js'),
        `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  summary: 'Greet from the app',
  needs: { services: [] },
  run(ctx) { ctx.stdout(typeof ctx.services.registry.get + ' ' + ctx.app.config.rootDir); },
});
`,
      );
      writeFileSync(join(dir, 'jsails.app.js'), 'export default {};\n');

      const help = await runCli(['--help'], dir);
      assert.match(help.stdout, /^ {2}greet {17}Greet from the app \(greeting-tools\)$/m);
      const result = await runCli(['greet'], dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `function ${dir}\n`);
    });
  },
);
