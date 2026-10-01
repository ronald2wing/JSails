/**
 * The fake host held against a real shell: each case runs the same file,
 * lock, fence, and host-state ops through `testing/fake-host.ts` and through
 * the actual script text of `production/remote-op.ts` in a real `sh` inside
 * a temporary home, and
 * requires the same exit statuses, the same output, and the same tree (paths,
 * contents, and modes) on both. This is the counterweight to a model that is
 * too forgiving: when a script changes, the model must change with it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { remoteWriteFileStdin } from '../../src/production/remote-file.js';
import { remoteOpArgv, type RemoteOp, type RemoteOpOf } from '../../src/production/remote-op.js';
import type { FakeTreeSnapshot } from '../../src/testing/fake-file-system.js';
import { FakeHost } from '../../src/testing/fake-host.js';
import { FakeRegistry } from '../../src/testing/fake-registry.js';

/** One command of a case: the op and the bytes on its stdin. */
interface Step {
  readonly op: RemoteOp;
  readonly stdin?: Buffer;
}

/** What one step produced. */
interface Outcome {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Run `steps` in a real `sh` under `umask 022` (the usual login umask the
 * scripts rely on) inside a fresh home, then read the tree back.
 */
function runReal(steps: readonly Step[]): {
  outcomes: Outcome[];
  tree: FakeTreeSnapshot;
  home: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'jamal-real-shell-'));
  try {
    const outcomes = steps.map((step) => {
      const result = spawnSync(
        '/bin/sh',
        ['-c', 'umask 022; exec "$@"', 'sh', ...remoteOpArgv(step.op)],
        { cwd: home, input: step.stdin ?? Buffer.alloc(0) },
      );
      return { exitCode: result.status ?? -1, stdout: result.stdout.toString('utf8') };
    });
    return { outcomes, tree: realTree(home), home: realpathSync(home) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function realTree(home: string): FakeTreeSnapshot {
  const directories: Record<string, number> = {};
  const files: Record<string, { mode: number; text: string }> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = relative(home, path);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        directories[key] = stat.mode & 0o777;
        walk(path);
      } else {
        files[key] = { mode: stat.mode & 0o777, text: readFileSync(path, 'utf8') };
      }
    }
  };
  walk(home);
  return { directories, files };
}

/** Run `steps` on a fake host whose home is `home` (the real run's, links resolved). */
async function runFake(
  steps: readonly Step[],
  home: string,
): Promise<{ outcomes: Outcome[]; tree: FakeTreeSnapshot }> {
  const host = new FakeHost({ registry: new FakeRegistry(), home });
  const outcomes: Outcome[] = [];
  for (const step of steps) {
    const result = await host.run(
      'server',
      remoteOpArgv(step.op),
      step.stdin === undefined ? undefined : { stdinFrom: Readable.from([step.stdin]) },
    );
    outcomes.push({ exitCode: result.exitCode, stdout: result.stdout });
  }
  return { outcomes, tree: host.fs.snapshot() };
}

const PATH = '.jamal/apps/myapp/releases/r1/secrets/secrets.json';
const LOCK = '.jamal/apps/myapp/lock';
const TOKEN = 'a'.repeat(32);
const OTHER_TOKEN = 'b'.repeat(32);

/** The owner document's tail the client sends: the rest of a JSON object. */
function owner(who: string): string {
  return `"who":"${who}","host":"laptop","since":"2026-11-23T10:00:00.000Z"}`;
}

/** The op of a write to `path`, as the secrets file is written unless `options` says otherwise. */
function writeOp(
  options: {
    path?: string;
    mode?: number;
    directoryMode?: number;
    lockDir?: string;
    expect?: string;
  } = {},
): RemoteOpOf<'file.write'> {
  return {
    kind: 'file.write',
    path: options.path ?? PATH,
    mode: options.mode ?? 0o444,
    directoryMode: 'directoryMode' in options ? options.directoryMode : 0o755,
    lockDir: options.lockDir,
    expect: options.expect,
  };
}

function write(contents: string, fence?: { dir: string; token: string }): Step {
  return {
    op: writeOp(fence === undefined ? {} : { lockDir: fence.dir }),
    stdin: remoteWriteFileStdin(Buffer.from(contents, 'utf8'), fence),
  };
}

/** A write to `path` that must find `expect` there. */
function writeExpecting(path: string, contents: string, expect: string): Step {
  return {
    op: writeOp({ path, mode: 0o600, directoryMode: 0o700, expect }),
    stdin: remoteWriteFileStdin(Buffer.from(contents, 'utf8')),
  };
}

/** `op` fenced by the lock, with `token` on the first stdin line before `stdin`. */
function fenced(op: RemoteOp, token: string, stdin: Buffer = Buffer.alloc(0)): Step {
  return {
    op: { kind: 'fenced', lockDir: LOCK, op },
    stdin: Buffer.concat([Buffer.from(`${token}\n`), stdin]),
  };
}

const STATE = '.jamal/apps/myapp/state.json';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const CASES: Readonly<Record<string, readonly Step[]>> = {
  'the home is the absolute directory the session starts in, links resolved, and stays so': [
    { op: { kind: 'host.home' } },
    write('{"v":1,"values":{}}\n'),
    { op: { kind: 'host.home' } },
  ],
  'a first write creates private directories, the given directory mode and file mode': [
    write('{"v":1,"values":{}}\n'),
  ],
  'a second write replaces the first': [
    write('{"v":1,"values":{}}\n'),
    write('{"v":1,"values":{"B":"ünïcødé\\n"}}\n'),
  ],
  'a write without a directory mode leaves a created directory private': [
    {
      op: writeOp({
        path: '.jamal/apps/myapp/accessories/db.env',
        mode: 0o600,
        directoryMode: undefined,
      }),
      stdin: remoteWriteFileStdin(Buffer.from('A=1\n')),
    },
  ],
  'a write with no header line is refused': [{ op: writeOp(), stdin: Buffer.from('no newline') }],
  'a write whose payload is short is refused and leaves the old file': [
    write('A=1\n'),
    { op: writeOp(), stdin: remoteWriteFileStdin(Buffer.from('A=2\n')).subarray(0, -2) },
  ],
  'a write whose payload was altered is refused': [
    {
      op: writeOp(),
      stdin: Buffer.from(
        remoteWriteFileStdin(Buffer.from('A=2\n')).toString('utf8').replace('A=2', 'A=3'),
      ),
    },
  ],
  'a create-only write lands once and is refused when the file exists': [
    writeExpecting(STATE, 'one\n', 'absent'),
    writeExpecting(STATE, 'two\n', 'absent'),
  ],
  'a compare-and-replace write lands on the bytes it names and is refused on others': [
    writeExpecting(STATE, 'one\n', 'absent'),
    writeExpecting(STATE, 'two\n', sha256('one\n')),
    writeExpecting(STATE, 'three\n', sha256('one\n')),
    writeExpecting('.jamal/apps/myapp/missing.json', 'x\n', sha256('one\n')),
  ],
  'a fenced write lands while the lock holds its token': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    write('A=1\n', { dir: LOCK, token: TOKEN }),
  ],
  'a fenced write is refused once another token holds the lock': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    write('A=1\n', { dir: LOCK, token: TOKEN }),
    { op: { kind: 'lock.force-release', dir: LOCK } },
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ben'), token: OTHER_TOKEN } },
    write('A=2\n', { dir: LOCK, token: TOKEN }),
  ],
  'a fenced write is refused when the lock is gone, or its header has no token': [
    write('A=1\n', { dir: LOCK, token: TOKEN }),
    { op: writeOp({ lockDir: LOCK }), stdin: remoteWriteFileStdin(Buffer.from('A=1\n')) },
  ],
  'a free lock is taken once and contended after': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ben'), token: OTHER_TOKEN } },
    { op: { kind: 'lock.status', dir: LOCK } },
  ],
  'each acquisition is handed the next sequence number, across releases': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.release', dir: LOCK, token: TOKEN } },
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ben'), token: OTHER_TOKEN } },
    { op: { kind: 'lock.force-release', dir: LOCK } },
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('cy'), token: TOKEN } },
    { op: { kind: 'lock.status', dir: LOCK } },
  ],
  'a damaged sequence file fails the acquisition and leaves no lock': [
    writeExpecting('.jamal/apps/myapp/lock.seq', '007\n', 'absent'),
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.status', dir: LOCK } },
  ],
  'a release under another token leaves the lock': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.release', dir: LOCK, token: OTHER_TOKEN } },
    { op: { kind: 'lock.status', dir: LOCK } },
  ],
  'a release with the token removes the lock, and again is a no-op': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.release', dir: LOCK, token: TOKEN } },
    { op: { kind: 'lock.release', dir: LOCK, token: TOKEN } },
    { op: { kind: 'lock.status', dir: LOCK } },
  ],
  'a forced release removes any lock, and a missing one is no error': [
    { op: { kind: 'lock.force-release', dir: LOCK } },
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.force-release', dir: LOCK } },
    { op: { kind: 'lock.status', dir: LOCK } },
  ],
  'a fenced op runs while the lock holds its token, with the rest of stdin as its own': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    fenced({ kind: 'host.home' }, TOKEN),
    fenced(writeOp(), TOKEN, remoteWriteFileStdin(Buffer.from('{"v":1,"values":{}}\n'))),
  ],
  'a fenced op is refused, and does not run, once the lock holds another token or none': [
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ana'), token: TOKEN } },
    { op: { kind: 'lock.force-release', dir: LOCK } },
    fenced(writeOp(), TOKEN, remoteWriteFileStdin(Buffer.from('{"v":1,"values":{}}\n'))),
    { op: { kind: 'lock.acquire', dir: LOCK, owner: owner('ben'), token: OTHER_TOKEN } },
    fenced(writeOp(), TOKEN, remoteWriteFileStdin(Buffer.from('{"v":1,"values":{}}\n'))),
    fenced({ kind: 'host.home' }, ''),
    { op: { kind: 'fenced', lockDir: LOCK, op: { kind: 'host.home' } }, stdin: Buffer.from(TOKEN) },
  ],
  'the host state is read framed: state, manifests, secrets markers, then extra files': [
    { op: { kind: 'host.read-state', dir: '.jamal/apps/myapp', extra: [] } },
    writeExpecting(STATE, '{"v":1}\n', 'absent'),
    write('{"v":1,"values":{"A":"x"}}\n'),
    writeExpecting('.jamal/apps/myapp/releases/r1/manifest.json', 'manifest ünï\n', 'absent'),
    writeExpecting('.jamal/apps/myapp/releases/r0/manifest.json', '{}\n', 'absent'),
    writeExpecting('.jamal/cache-proxy/default.vcl', 'vcl 4.1;\n', 'absent'),
    {
      op: {
        kind: 'host.read-state',
        dir: '.jamal/apps/myapp',
        extra: ['.jamal/cache-proxy/default.vcl', '.jamal/cache-proxy/missing.vcl'],
      },
    },
  ],
};

describe(
  'the fake host agrees with a real shell',
  {
    skip: process.platform === 'win32' && 'the remote scripts need a POSIX shell',
  },
  () => {
    for (const [name, steps] of Object.entries(CASES)) {
      it(name, async () => {
        const real = runReal(steps);
        const fake = await runFake(steps, real.home);
        assert.deepEqual(fake.outcomes, real.outcomes);
        assert.deepEqual(fake.tree, real.tree);
      });
    }

    it('every truncation of a write agrees', async () => {
      const stdin = remoteWriteFileStdin(
        Buffer.from('{"v":1,"values":{"B":"ünïcødé \\"x\\" $y"}}\n'),
      );
      for (let at = 0; at < stdin.length; at += 1) {
        const steps = [{ op: writeOp(), stdin: stdin.subarray(0, at) }];
        const { home, ...real } = runReal(steps);
        const fake = await runFake(steps, home);
        assert.deepEqual(fake, real, `truncated at byte ${at}`);
      }
    });
  },
);
