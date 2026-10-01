/**
 * Tests for the platform part of `scripts/subprocess.mjs`: `spawnable` runs npm
 * as `node <npm-cli.js>` on Windows (no shell to re-split arguments), and
 * `windowsNpmCli` finds npm's entry through `npm_execpath` (npm's or npx's,
 * never another package manager's) or beside `node.exe`; and aborting a run
 * stops every process the child started, not the child alone.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { npm, run, spawnable, windowsNpmCli } from '../subprocess.mjs';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BUNDLED = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const only =
  (...files) =>
  (path) =>
    files.includes(path);

describe('spawnable', () => {
  it('returns every command unchanged on POSIX', () => {
    assert.deepEqual(spawnable(npm, ['ci'], { platform: 'linux', env: {} }), [npm, ['ci']]);
    assert.deepEqual(spawnable('git', ['status'], { platform: 'darwin', env: {} }), [
      'git',
      ['status'],
    ]);
  });

  it('runs npm with this Node and npm-cli.js on Windows, other commands unchanged', () => {
    const [command, args] = spawnable(npm, ['run', 'build', 'a b$c'], {
      platform: 'win32',
      env: {},
    });
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(1), ['run', 'build', 'a b$c']);
    assert.match(args[0], /npm-cli\.js$/);
    assert.deepEqual(spawnable('git', ['status'], { platform: 'win32', env: {} }), [
      'git',
      ['status'],
    ]);
  });
});

describe('windowsNpmCli', () => {
  it('prefers the npm-cli.js npm exported', () => {
    const cli = 'D:\\npm\\bin\\npm-cli.js';
    assert.equal(
      windowsNpmCli({ npm_execpath: cli }, { execPath: NODE, exists: only(cli, BUNDLED) }),
      cli,
    );
  });

  it('takes npm-cli.js beside npx-cli.js under npx', () => {
    assert.equal(
      windowsNpmCli(
        { npm_execpath: 'D:\\npm\\bin\\npx-cli.js' },
        { execPath: NODE, exists: only('D:\\npm\\bin\\npm-cli.js') },
      ),
      'D:\\npm\\bin\\npm-cli.js',
    );
  });

  it("ignores another package manager's entry and a missing file", () => {
    for (const npmExecpath of ['C:\\yarn\\bin\\yarn.js', 'C:\\gone\\npm-cli.js']) {
      assert.equal(
        windowsNpmCli({ npm_execpath: npmExecpath }, { execPath: NODE, exists: only(BUNDLED) }),
        BUNDLED,
      );
    }
  });
});

describe('run with an abort signal', () => {
  it('stops the processes a child started, not the child alone', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-subprocess-abort-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A parent that starts a grandchild and does not pass a termination on, as
    // dash does with `sh -c` and cmd.exe with the scripts npm runs.
    const parent = (marker) => {
      const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''), 1500)`;
      return `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); c.on('exit', () => process.exit(0));`;
    };

    // Control: left alone, the grandchild writes its marker.
    const control = join(dir, 'control');
    await run(process.execPath, ['-e', parent(control)], { capture: true });
    assert.equal(existsSync(control), true, 'the grandchild did not run');

    const marker = join(dir, 'aborted');
    const controller = new AbortController();
    const outcome = run(process.execPath, ['-e', parent(marker)], {
      signal: controller.signal,
      capture: true,
    });
    await delay(500);
    controller.abort();
    assert.deepEqual(await outcome.then(({ code, signal }) => ({ code, signal })), {
      code: null,
      signal: 'SIGTERM',
    });
    await delay(2000);
    assert.equal(existsSync(marker), false, 'the grandchild outlived the aborted child');
  });
});
