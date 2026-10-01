/**
 * Tests for `npmSpawn` (`cli/owned-process-tree.ts`): npm runs without a shell
 * on every platform. On Windows that is `node <npm-cli.js>`, found through
 * `npm_execpath` (npm's or npx's, never another package manager's) or beside
 * `node.exe`; `cmd.exe` is the last resort when no `npm-cli.js` exists.
 * Teardown (`killOwnedProcessTree`) is covered in `commands/create.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { npmSpawn } from '../../src/cli/owned-process-tree.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BUNDLED = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

/** An `exists` that knows only `files`. */
const only =
  (...files: string[]) =>
  (path: string): boolean =>
    files.includes(path);

describe('npmSpawn', () => {
  it('spawns npm directly on POSIX', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      assert.deepEqual(npmSpawn(['install'], { platform, env: {} }), {
        command: 'npm',
        args: ['install'],
      });
    }
  });

  it('runs the npm-cli.js npm exported, with this Node, on Windows', () => {
    const cli = 'D:\\tools\\npm\\bin\\npm-cli.js';
    assert.deepEqual(
      npmSpawn(['install'], {
        platform: 'win32',
        env: { npm_execpath: cli },
        execPath: NODE,
        exists: only(cli, BUNDLED),
      }),
      { command: NODE, args: [cli, 'install'] },
    );
  });

  it('takes npm-cli.js beside npx-cli.js when run through npx', () => {
    assert.deepEqual(
      npmSpawn(['install'], {
        platform: 'win32',
        env: { npm_execpath: 'D:\\npm\\bin\\npx-cli.js' },
        execPath: NODE,
        exists: only('D:\\npm\\bin\\npm-cli.js'),
      }),
      { command: NODE, args: ['D:\\npm\\bin\\npm-cli.js', 'install'] },
    );
  });

  it("ignores another package manager's entry and uses the npm beside node.exe", () => {
    for (const other of ['C:\\yarn\\bin\\yarn.js', 'C:\\pnpm\\bin\\pnpm.cjs']) {
      assert.deepEqual(
        npmSpawn(['install'], {
          platform: 'win32',
          env: { npm_execpath: other },
          execPath: NODE,
          exists: only(other, BUNDLED),
        }),
        { command: NODE, args: [BUNDLED, 'install'] },
      );
    }
  });

  it('falls back to cmd.exe from ComSpec, then SystemRoot, when no npm-cli.js exists', () => {
    const none = only();
    assert.deepEqual(
      npmSpawn(['install'], {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        execPath: NODE,
        exists: none,
      }),
      { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'npm install'] },
    );
    assert.deepEqual(
      npmSpawn(['install'], {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Win' },
        execPath: NODE,
        exists: none,
      }),
      { command: 'C:\\Win\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'npm install'] },
    );
  });
});
