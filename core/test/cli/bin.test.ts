/**
 * The `jsails` and `create-jsails` executables (`bin.cjs`,
 * `create-bin.cjs`), run as child processes: under a Node release older
 * than the floor (a preload stubs `process.versions.node`) each prints the
 * fixed floor message and exits 1 without loading the CLI; on this release
 * `jsails --version` prints core's version and `create-jsails --help` the
 * help of `create`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { cliPath, runCli, runProcess } from './spawn-cli.js';

const dir = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'cli-bin-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const createBin = fileURLToPath(new URL('../../src/cli/create-bin.cjs', import.meta.url));
const version = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** A CommonJS preload that makes the process report Node `running`. */
function stubNode(running: string): string {
  const file = join(dir, `node-${running}.cjs`);
  writeFileSync(
    file,
    `Object.defineProperty(process, 'versions', { value: Object.freeze({ ...process.versions, node: ${JSON.stringify(running)} }), configurable: true });\n`,
  );
  return file;
}

describe('the bins on a Node release below the floor', () => {
  for (const running of ['20.11.1', '25.9.0']) {
    it(`refuse Node ${running} with the floor message, before loading the CLI`, async () => {
      const preload = stubNode(running);
      const [jsails, create] = await Promise.all([
        runCli(['--version'], { cwd: dir, nodeArgs: ['--require', preload] }),
        runProcess(process.execPath, ['--require', preload, createBin, 'app'], { cwd: dir }),
      ]);
      assert.equal(jsails.status, 1);
      assert.equal(jsails.stdout, '');
      assert.equal(
        jsails.stderr,
        `jsails: Node.js 26 or later is required; this is Node.js ${running}\n`,
      );
      assert.equal(create.status, 1);
      assert.equal(create.stdout, '');
      assert.equal(
        create.stderr,
        `create-jsails: Node.js 26 or later is required; this is Node.js ${running}\n`,
      );
    });
  }
});

describe('the bins on this release', () => {
  it('jsails --version prints the version of core', async () => {
    const result = await runCli(['--version'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, '');
  });

  it('create-jsails --help prints the help of create', async () => {
    const result = await runProcess(process.execPath, [createBin, '--help'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^jsails create - Scaffold a fresh JSails application\n/);
  });

  it('run as the package names them', () => {
    assert.ok(cliPath.endsWith(join('src', 'cli', 'bin.cjs')));
  });
});
