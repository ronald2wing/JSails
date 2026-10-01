/**
 * Tests for the Sail-style dev-container shortcuts (`jamal npm`, `jamal
 * jsails`, `jamal test`, `jamal shell`, ...): each materializes the local plan
 * and runs one command in a fresh app container, passing arguments verbatim.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { hostUserOption } from '../../src/jamal/deps.js';
import { defaultDockerCommandRunner } from '../../src/jamal/docker.js';
import { normalizeJamalConfig, type JamalConfig } from '../../src/jamal/config/index.js';

const root = mkdtempSync(join(tmpdir(), 'jamal-shortcuts-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const DEV_CONFIG = normalizeJamalConfig({
  service: 'myapp',
  image: 'img',
  services: { db: { type: 'mariadb' } },
  local: { app: 'dev' },
  production: { server: '1.2.3.4' },
});

function project(config: JamalConfig = DEV_CONFIG) {
  const dir = join(root, `case-${seq++}`);
  const out: string[] = [];
  const err: string[] = [];
  const calls: (readonly string[])[] = [];
  const deps: JamalDeps = {
    createRegistry: () => {
      throw new Error('shortcuts never build the registry');
    },
    cwd: dir,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    loadJamalConfig: async () => config,
    runCommand: async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    remoteRunner: {
      run: async () => {
        throw new Error('shortcuts never reach the server');
      },
    },
  };
  return { dir, out, err, calls, deps };
}

const RUN_PREFIX = ['docker', 'compose', '-f', '.jamal/compose.yml', '-p', 'myapp', 'run', '--rm'];

describe('jamal dev-container shortcuts', () => {
  it('runs npm in a fresh app container with its arguments verbatim', async () => {
    const { dir, err, calls, deps } = project();
    const code = await runJamalCommand(['npm', 'install', '--save-dev', 'left-pad'], deps);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(calls, [[...RUN_PREFIX, 'app', 'npm', 'install', '--save-dev', 'left-pad']]);
    // The plan is materialized first, so `run` builds from current files.
    assert.ok(existsSync(join(dir, '.jamal', 'compose.yml')));
    assert.ok(existsSync(join(dir, '.jamal', 'dev.Dockerfile')));
    // Created before Docker would create it as root.
    assert.ok(existsSync(join(dir, 'node_modules')));
  });

  it('maps each shortcut to its command', async () => {
    const cases: [string[], string[]][] = [
      [
        ['jsails', 'db:push', '--allow-destructive'],
        ['node_modules/.bin/jsails', 'db:push', '--allow-destructive'],
      ],
      [
        ['npx', 'tsc', '--noEmit'],
        ['npx', 'tsc', '--noEmit'],
      ],
      [
        ['node', '-e', '1'],
        ['node', '-e', '1'],
      ],
      [['test'], ['npm', 'test']],
      [
        ['test', '--test-name-pattern', 'auth'],
        ['npm', 'test', '--', '--test-name-pattern', 'auth'],
      ],
      [['shell'], ['bash']],
      [
        ['npm', '--', '--version'],
        ['npm', '--version'],
      ],
    ];
    for (const [args, command] of cases) {
      const { err, calls, deps } = project();
      assert.equal(await runJamalCommand(args, deps), 0, err.join('\n'));
      assert.deepEqual(calls[0], [...RUN_PREFIX, 'app', ...command], args.join(' '));
    }
  });

  it('refuses when the app does not run in the dev container', async () => {
    for (const app of ['host', 'image'] as const) {
      const { err, calls, deps } = project(
        normalizeJamalConfig({ service: 'myapp', image: 'img', local: { app } }),
      );
      assert.equal(await runJamalCommand(['npm', 'install'], deps), 1);
      assert.match(err.join('\n'), /set local\.app to "dev"/);
      assert.equal(calls.length, 0);
    }
  });

  it('refuses arguments to shell', async () => {
    const { calls, deps } = project();
    assert.equal(await runJamalCommand(['shell', 'rm'], deps), 2);
    assert.equal(calls.length, 0);
  });

  it('writes the host user into the dev image build', async () => {
    const { dir, deps } = project();
    await runJamalCommand(['node', '--version'], deps);
    const compose = readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8');
    const uid = process.getuid?.() ?? 1000;
    assert.ok(compose.includes(`        UID: '${uid}'`));
  });
});

describe('jamal dev --write', () => {
  it('creates the node_modules mount point before Docker would create it as root', async () => {
    const { dir, err, deps } = project();
    assert.equal(await runJamalCommand(['dev', '--write'], deps), 0, err.join('\n'));
    assert.ok(existsSync(join(dir, 'node_modules')));
    assert.ok(existsSync(join(dir, '.jamal', 'dev.Dockerfile')));
  });
});

describe('dev container user', () => {
  it('takes JAMAL_DEV_UID and JAMAL_DEV_GID over the host ids', () => {
    assert.deepEqual(hostUserOption({ JAMAL_DEV_UID: '0', JAMAL_DEV_GID: '0' }), {
      hostUser: { uid: 0, gid: 0 },
    });
  });

  it('rejects an id that is not a non-negative integer, without echoing it', () => {
    assert.throws(
      () => hostUserOption({ JAMAL_DEV_UID: '-1; rm' }),
      (error: unknown) => error instanceof Error && !error.message.includes('rm'),
    );
  });
});

describe('docker command runner', () => {
  it('sets PWD to the working directory, so $PWD volume sources resolve in the project', async () => {
    const dir = mkdtempSync(join(root, 'pwd-'));
    const result = await defaultDockerCommandRunner(
      [process.execPath, '-e', `process.exit(process.env.PWD === ${JSON.stringify(dir)} ? 0 : 3)`],
      { cwd: dir },
    );
    assert.equal(result.exitCode, 0);
  });
});
