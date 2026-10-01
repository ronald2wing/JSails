/**
 * What listing commands and printing help load, recorded by a module hook in
 * a child process:
 *
 * - `jsails --help`, in a project with a dependency command and app commands
 *   whose modules throw (and write a marker) when imported, lists every one
 *   of them and loads nothing but `node:` builtins and `core/dist`: no
 *   third-party package and no module of the project. The project lives in
 *   the system temporary directory, outside the core tree, so a module of the
 *   project is never mistaken for one of core's; a positive control proves
 *   the check sees one that loads;
 * - every built-in's `--help`, a usage error and an unknown command load no
 *   third-party package either.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { BUILTIN_COMMANDS } from '../../src/cli/manifest.js';
import { CLI_SUITE_CONCURRENCY, runCli, type ProcessResult } from './spawn-cli.js';

/** The hook and its reports; the hook is the test's own module, not the CLI's. */
const root = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'cli-help-modules-'));
/**
 * The projects, outside the core tree: under `core/dist` every module of a
 * project would pass for one of core's. No check compares a project path's
 * spelling (`/var` against `/private/var`, an 8.3 short name), so it needs no
 * real path: a module of the project only has to fall outside `coreDist`.
 */
const projects = mkdtempSync(join(tmpdir(), 'jsails-help-modules-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
});

/**
 * The built framework, whose modules are the only ones help may load. It is
 * read off this module's own URL, which the loader spelled as it spells the
 * child's, so the two compare as strings.
 */
const coreDist = new URL('../../', import.meta.url).href;

const hook = join(root, 'record-loads.mjs');
writeFileSync(
  hook,
  [
    "import { registerHooks } from 'node:module';",
    "import { writeFileSync } from 'node:fs';",
    'const loaded = [];',
    'registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });',
    "process.on('exit', () => writeFileSync(process.env.LOADED_REPORT, JSON.stringify(loaded)));",
    '',
  ].join('\n'),
);

let seq = 0;

/** Run the CLI under the hook; resolves with its result and every module URL it loaded. */
async function recording(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly result: ProcessResult; readonly loaded: readonly string[] }> {
  const report = join(root, `loaded-${seq++}.json`);
  const result = await runCli(args, {
    cwd,
    env: { ...process.env, LOADED_REPORT: report },
    nodeArgs: ['--import', pathToFileURL(hook).href],
  });
  const loaded = JSON.parse(readFileSync(report, 'utf8')) as string[];
  assert.ok(
    loaded.some((url) => url.endsWith('/src/cli/index.js')),
    'the hook saw the CLI',
  );
  return { result, loaded };
}

/**
 * The modules among `loaded` that are neither `node:` builtins nor core's.
 * The hook passes because `root` is under `core/dist`, next to this test.
 */
function outsideCore(loaded: readonly string[]): string[] {
  return loaded.filter((url) => !url.startsWith('node:') && !url.startsWith(coreDist));
}

/** The third-party packages among `loaded`. */
function packagesOf(loaded: readonly string[]): string[] {
  return loaded.flatMap((url) => {
    const match = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** A module that leaves `marker` behind and throws, if anything imports it. */
function booby(marker: string): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(new URL('${marker}', import.meta.url), 'imported');`,
    "throw new Error('imported at help time');",
    '',
  ].join('\n');
}

describe('jsails --help in a project with commands', () => {
  it('lists every command, imports none of them, and loads only node: and core/dist', async () => {
    const dir = join(projects, 'project');
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'p', dependencies: { 'sync-tools': '1.0.0' } }),
    );
    write(
      dir,
      'node_modules/sync-tools/package.json',
      JSON.stringify({
        name: 'sync-tools',
        exports: { './run': './run.js' },
        jsails: {
          commands: [{ name: 'sync:run', summary: 'Run a sync', module: 'sync-tools/run' }],
        },
      }),
    );
    write(dir, 'node_modules/sync-tools/run.js', booby('./dependency.marker'));
    write(dir, 'dist/commands/boom.js', booby('../../boom.marker'));
    write(dir, 'dist/commands/db/seed-demo.js', booby('../../../seed.marker'));
    write(dir, 'commands/pending.ts', 'export {};\n');
    write(dir, 'jsails.app.js', booby('./app.marker'));

    const { result, loaded } = await recording(['--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^Commands from dependencies:\n {2}sync:run {14}Run a sync \(sync-tools\)$/m,
    );
    assert.match(result.stdout, /^ {2}boom$/m);
    assert.match(result.stdout, /^ {2}db:seed-demo$/m);
    assert.match(result.stdout, /^ {2}pending {15}not built: run the build first$/m);
    for (const marker of ['dependency.marker', 'boom.marker', 'seed.marker', 'app.marker']) {
      assert.equal(existsSync(join(dir, marker)), false, `${marker}: help imported it`);
    }
    assert.deepEqual(
      outsideCore(loaded),
      [],
      'jsails --help loaded modules outside node: and core/dist',
    );
  });

  it('sees a module of the project when one loads (the positive control)', async () => {
    const dir = join(projects, 'control');
    write(dir, 'dist/commands/visible.js', 'export default 1;\n');

    const { result, loaded } = await recording(['visible', '--help'], dir);

    assert.equal(result.status, 1, 'the module is no defineCommand value');
    assert.ok(
      outsideCore(loaded).some((url) => url.endsWith('/dist/commands/visible.js')),
      'the check missed a module of the project',
    );
  });
});

describe(
  'help and usage errors load no third-party package',
  { concurrency: CLI_SUITE_CONCURRENCY },
  () => {
    const dir = join(root, 'empty');
    mkdirSync(dir, { recursive: true });
    const invocations: readonly (readonly [readonly string[], number])[] = [
      [['--help'], 0],
      [[], 0],
      [['--no-such-flag'], 2],
      [['no-such-command'], 2],
      [['db:push', '--bogus'], 2],
      ...BUILTIN_COMMANDS.filter((command) => command.passthrough !== true).map(
        (command) => [[command.name, '--help'], 0] as const,
      ),
    ];
    for (const [args, status] of invocations) {
      it(`jsails ${args.join(' ')}`, async () => {
        const { result, loaded } = await recording(args, dir);
        assert.equal(result.status, status, result.stderr);
        assert.deepEqual(packagesOf(loaded), []);
      });
    }
  },
);
