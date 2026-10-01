/**
 * Tests for `jamal backup` and `jamal restore` over a fake server: the remote
 * commands in order, the deploy lock, the local file, and every refusal.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig, secret, type JamalConfig } from '../src/config/index.js';
import {
  BACKUP_EXIT,
  applyDatabaseArgv,
  discardStageArgv,
  dumpArgv,
  runningArgv,
  stageArgv,
  valkeyRestoreArgv,
} from '../src/production/backup.js';
import { checksumLine } from '../src/production/backup-file.js';
import { runBackup } from '../src/production/backup-run.js';
import type { CommandResult } from '../src/production/process-runner.js';
import { BACKUP_EXIT_VALKEY, decodeRemoteOp, remoteOpArgv } from '../src/production/remote-op.js';
import type { RemoteRunner } from '../src/production/transport.js';

/** The secret the config names; no remote argv and no output may carry it. */
const DB_SECRET = 'pw-$(never)-in-argv';

const SQL = Buffer.from(
  '/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump\nCREATE TABLE t (id int);\n',
);
const PG = Buffer.from('PGDMP\x01\x0f\x00custom-archive', 'latin1');
const RDB = Buffer.from('REDIS0011\xfadata', 'latin1');

const root = mkdtempSync(join(tmpdir(), 'jamal-backup-command-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function projectDir(): string {
  counter += 1;
  const dir = join(root, `project-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function config(): JamalConfig {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
    env: {
      DATABASE_PASSWORD: secret('DATABASE_PASSWORD'),
      DATABASE_USER: 'app',
      DATABASE_NAME: 'app',
    },
    services: {
      db: { type: 'mariadb' },
      pg: { type: 'postgres' },
      cache: { type: 'valkey' },
      mailpit: { type: 'mailpit' },
    },
    production: { server: '203.0.113.7' },
  });
}

interface Call {
  readonly argv: readonly string[];
  stdin?: Buffer;
}

interface FakeServer {
  /** The lock acquire script's exit status (1 is contention). */
  lockExit?: number;
  /** What the running check prints. */
  running?: string;
  /** What the dump writes to stdout, and its exit status. */
  dump?: Buffer;
  dumpExit?: number;
  dumpStderr?: string;
  /** Called while the dump streams, after its bytes were written. */
  duringDump?: () => void;
  stageExit?: number;
  /** Exit status for any other command, by its argv. */
  exitFor?: (argv: readonly string[]) => number | undefined;
}

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr };
}

/** Whether a remote argv is one of the deploy lock's own ops. */
function isLockCall(argv: readonly string[]): boolean {
  return decodeRemoteOp(argv)?.kind.startsWith('lock.') === true;
}

/**
 * A recording fake of the server: lock scripts, docker inspect, dump and
 * stage streams. A command fenced by the lock is recorded as its inner
 * command, its stdin without the token line.
 */
function fakeServer(options: FakeServer = {}): { remote: RemoteRunner; calls: Call[] } {
  const calls: Call[] = [];
  const remote: RemoteRunner = {
    async run(_server, remoteArgv, runOptions) {
      const decoded = decodeRemoteOp(remoteArgv);
      const fenced = decoded?.kind === 'fenced';
      const argv = decoded?.kind === 'fenced' ? remoteOpArgv(decoded.op) : remoteArgv;
      const call: Call = { argv: [...argv] };
      calls.push(call);
      const opts = typeof runOptions === 'string' ? {} : (runOptions ?? {});
      if (decoded?.kind === 'lock.acquire') {
        const exit = options.lockExit ?? 0;
        return result(exit, exit === 0 ? '1\n' : '');
      }
      if (isLockCall(argv)) return result(0);
      if (argv[1] === 'container' && argv[2] === 'inspect') {
        return result(0, `${options.running ?? 'true'}\n`);
      }
      if (opts.stdoutTo !== undefined) {
        const sink: Writable = opts.stdoutTo;
        await new Promise<void>((resolve) => sink.write(options.dump ?? SQL, () => resolve()));
        options.duringDump?.();
        await new Promise<void>((resolve) => sink.end(() => resolve()));
        return result(options.dumpExit ?? 0, '', options.dumpStderr ?? '');
      }
      if (opts.stdinFrom !== undefined) {
        const chunks: Buffer[] = [];
        for await (const chunk of opts.stdinFrom) chunks.push(chunk as Buffer);
        const stdin = Buffer.concat(chunks);
        call.stdin = fenced ? stdin.subarray(stdin.indexOf(0x0a) + 1) : stdin;
        return result(options.stageExit ?? 0);
      }
      return result(options.exitFor?.(argv) ?? 0);
    },
  };
  return { remote, calls };
}

interface Harness {
  deps: JamalDeps;
  out: string[];
  err: string[];
  cwd: string;
}

function harness(
  remote: RemoteRunner,
  overrides: Partial<Pick<JamalDeps, 'platform' | 'prompt' | 'loadJamalConfig'>> = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = projectDir();
  const deps: JamalDeps = {
    loadJamalConfig: async () => config(),
    remoteRunner: remote,
    loadSecrets: () => {
      throw new Error('backup and restore must not load the secrets files');
    },
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { deps, out, err, cwd };
}

/** The calls with the lock scripts left out: what touched the accessory. */
function accessoryCalls(calls: readonly Call[]): (readonly string[])[] {
  return calls.filter((call) => !isLockCall(call.argv)).map((call) => call.argv);
}

function lockCalls(calls: readonly Call[]): string[] {
  return calls
    .filter((call) => isLockCall(call.argv))
    .map((call) => (decodeRemoteOp(call.argv)?.kind === 'lock.acquire' ? 'acquire' : 'release'));
}

function assertNoSecret(calls: readonly Call[], h: Harness): void {
  for (const call of calls) {
    assert.ok(!call.argv.some((token) => token.includes(DB_SECRET)), 'no argv carries the secret');
  }
  assert.doesNotMatch(
    [...h.out, ...h.err].join('\n'),
    new RegExp(DB_SECRET.replace(/[$()]/g, '\\$&')),
  );
}

/** Write a backup file and its sidecar into the project. */
function backupFile(
  h: Harness,
  name: string,
  data: Buffer,
  line = checksumLine(sha256(data), name),
): string {
  const dir = join(h.cwd, 'backups');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  writeFileSync(join(dir, `${name}.sha256`), line);
  return `backups/${name}`;
}

/**
 * `jamal backup` and `jamal restore` are server-facing verbs, which Windows
 * refuses with `unsupported_platform` (`platform.ts`), so the tests of what
 * they do run on POSIX only; the refusal itself is tested on every platform.
 */
const serverVerb = {
  skip: process.platform === 'win32' && 'a server-facing jamal verb, which Windows refuses',
};

describe('jamal backup', serverVerb, () => {
  it('prints its usage without loading the config', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote, {
      loadJamalConfig: async () => {
        throw new Error('help must not load the config');
      },
    });
    assert.equal(await runJamalCommand(['backup', '--help'], h.deps), 0);
    assert.match(h.out.join('\n'), /jamal backup - dump one accessory/);
    assert.match(h.out.join('\n'), /--out <dir>/);
    assert.equal(calls.length, 0);
  });

  it('dumps under the lock into .jamal/backups with a sidecar, credentials kept off every argv', async () => {
    const { remote, calls } = fakeServer({ dump: SQL });
    const h = harness(remote);

    const code = await runJamalCommand(['backup', 'db'], h.deps);

    assert.equal(code, 0, h.err.join('\n'));
    assert.deepEqual(lockCalls(calls), ['acquire', 'release']);
    assert.deepEqual(accessoryCalls(calls), [runningArgv('db'), dumpArgv('mariadb', 'db')]);
    const acquire = decodeRemoteOp(calls[0]!.argv);
    assert.ok(acquire?.kind === 'lock.acquire');
    assert.match(acquire.owner, /"for":"backup db"\}$/, 'the lock owner names the backup');
    const dir = join(h.cwd, '.jamal', 'backups');
    const [dumpName = '', sidecarName = '', ...rest] = readdirSync(dir).sort();
    assert.deepEqual(rest, []);
    assert.match(dumpName, /^myapp-db-\d{8}T\d{6}Z\.sql$/);
    assert.equal(sidecarName, `${dumpName}.sha256`);
    assert.deepEqual(readFileSync(join(dir, dumpName)), SQL);
    assert.equal(readFileSync(join(dir, sidecarName), 'utf8'), checksumLine(sha256(SQL), dumpName));
    assert.match(
      h.out.join('\n'),
      new RegExp(
        `Wrote \\.jamal/backups/${dumpName} \\(${SQL.length} bytes, sha256 ${sha256(SQL)}\\)`,
      ),
    );
    assertNoSecret(calls, h);
  });

  it('writes under --out and names each kind by its extension', async () => {
    for (const [name, data, ext] of [
      ['pg', PG, 'dump'],
      ['cache', RDB, 'rdb'],
    ] as const) {
      const { remote } = fakeServer({ dump: data });
      const h = harness(remote);
      assert.equal(
        await runJamalCommand(['backup', name, '--out', 'dumps/here'], h.deps),
        0,
        h.err.join('\n'),
      );
      const files = readdirSync(join(h.cwd, 'dumps', 'here'));
      assert.ok(
        files.some((file) => new RegExp(`^myapp-${name}-\\d{8}T\\d{6}Z\\.${ext}$`).test(file)),
        files.join(),
      );
    }
  });

  it('stops at a held deploy lock before touching the accessory', async () => {
    const { remote, calls } = fakeServer({ lockExit: 1 });
    const h = harness(remote);

    assert.equal(await runJamalCommand(['backup', 'db'], h.deps), 1);

    assert.match(h.err.join('\n'), /backup failed: the deploy lock is already held/);
    assert.deepEqual(accessoryCalls(calls), []);
    assert.equal(existsSync(join(h.cwd, '.jamal')), false);
  });

  it('refuses an accessory that is not running and releases the lock', async () => {
    const { remote, calls } = fakeServer({ running: 'false' });
    const h = harness(remote);

    assert.equal(await runJamalCommand(['backup', 'db'], h.deps), 1);

    assert.match(h.err.join('\n'), /the accessory container is not running/);
    assert.deepEqual(lockCalls(calls), ['acquire', 'release']);
    assert.deepEqual(accessoryCalls(calls), [runningArgv('db')]);
  });

  it('keeps nothing from a failed dump and forwards the tool error', async () => {
    const { remote } = fakeServer({
      dump: SQL.subarray(0, 20),
      dumpExit: 2,
      dumpStderr: 'mariadb-dump: Got error 2002\n',
    });
    const h = harness(remote);

    assert.equal(await runJamalCommand(['backup', 'db'], h.deps), 1);

    assert.deepEqual(readdirSync(join(h.cwd, '.jamal', 'backups')), []);
    assert.match(h.err.join('\n'), /mariadb-dump: Got error 2002/);
    assert.match(h.err.join('\n'), /backup failed: the dump exited with code 2/);
  });

  it("maps the scripts' own exit statuses to their errors", async () => {
    for (const [exit, message] of [
      [BACKUP_EXIT.noCredentials, /no database, user, or password/],
      [BACKUP_EXIT.timedOut, /did not finish its save in time/],
      [BACKUP_EXIT.saveFailed, /reported a failed save/],
      [255, /could not be reached over ssh/],
    ] as const) {
      const { remote } = fakeServer({ dump: Buffer.alloc(0), dumpExit: exit });
      const h = harness(remote);
      assert.equal(await runJamalCommand(['backup', 'db'], h.deps), 1);
      assert.match(h.err.join('\n'), message);
    }
  });

  it('refuses output that is not a dump of the accessory kind', async () => {
    const { remote } = fakeServer({ dump: Buffer.from('Usage: mariadb-dump [OPTIONS]\n') });
    const h = harness(remote);
    assert.equal(await runJamalCommand(['backup', 'db'], h.deps), 1);
    assert.match(h.err.join('\n'), /is not a mariadb dump/);
    assert.deepEqual(readdirSync(join(h.cwd, '.jamal', 'backups')), []);
  });

  it('rejects a missing, unknown, or dev-tool accessory as a usage error', async () => {
    for (const args of [
      ['backup'],
      ['backup', 'nope'],
      ['backup', 'mailpit'],
      ['backup', 'db', 'extra'],
    ]) {
      const { remote, calls } = fakeServer();
      const h = harness(remote);
      assert.equal(await runJamalCommand(args, h.deps), 2, args.join(' '));
      assert.equal(calls.length, 0);
    }
  });

  it('requires config.production', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote, {
      loadJamalConfig: async () =>
        normalizeJamalConfig({
          service: 'myapp',
          image: 'x',
          services: { db: { type: 'mariadb' } },
        }),
    });
    assert.equal(await runJamalCommand(['backup', 'db'], h.deps), 1);
    assert.match(h.err.join('\n'), /config\.production is required for `jamal backup`/);
    assert.equal(calls.length, 0);
  });

  it('removes the partial file when interrupted, then releases the lock', async () => {
    const dir = join(projectDir(), 'out');
    const signals = new EventEmitter();
    const interrupted: string[] = [];
    let partialSeen = false;
    const { remote, calls } = fakeServer({
      dump: SQL,
      duringDump: () => {
        partialSeen = readdirSync(dir).some((file) => file.endsWith('.partial'));
        signals.emit('SIGINT');
      },
      dumpExit: 130,
    });

    await assert.rejects(
      runBackup({
        remoteRunner: remote,
        server: 'host',
        service: 'myapp',
        destination: undefined,
        accessory: 'db',
        kind: 'mariadb',
        logger: { info: () => {}, warn: () => {} },
        dir,
        app: 'myapp',
        lockOwner: { who: 'tester', host: 'box', since: '2026-11-23T10:00:00.000Z' },
        signals,
        onInterrupted: (signal) => interrupted.push(signal),
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(partialSeen, 'the dump streamed into a partial file');
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(interrupted, ['SIGINT']);
    assert.deepEqual(lockCalls(calls), ['acquire', 'release']);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  });
});

describe('jamal restore', serverVerb, () => {
  it('stages the verified file, replaces the database under the lock, and keeps credentials off every argv', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(h, 'myapp-db-20261121T000000Z.sql', SQL);

    const code = await runJamalCommand(['restore', 'db', file, '--yes'], h.deps);

    assert.equal(code, 0, h.err.join('\n'));
    assert.deepEqual(lockCalls(calls), ['acquire', 'release']);
    assert.match(calls[0]!.argv[5]!, /"for":"restore db"\}$/);
    assert.deepEqual(accessoryCalls(calls), [
      runningArgv('db'),
      stageArgv('mariadb', 'db', sha256(SQL)),
      applyDatabaseArgv('mariadb', 'db'),
    ]);
    assert.deepEqual(calls.find((call) => call.stdin !== undefined)?.stdin, SQL);
    assert.match(
      h.out.join('\n'),
      /Restored the mariadb accessory db from backups\/myapp-db-20261121T000000Z\.sql\./,
    );
    assertNoSecret(calls, h);
  });

  it('restores PostgreSQL the same way', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(h, 'p.dump', PG);
    assert.equal(
      await runJamalCommand(['restore', 'pg', file, '--yes'], h.deps),
      0,
      h.err.join('\n'),
    );
    assert.deepEqual(accessoryCalls(calls).slice(1), [
      stageArgv('postgres', 'pg', sha256(PG)),
      applyDatabaseArgv('postgres', 'pg'),
    ]);
  });

  it('replaces a Valkey accessory in one host-side command, then probes it', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(h, 'c.rdb', RDB);
    const argv = valkeyRestoreArgv('cache');

    assert.equal(
      await runJamalCommand(['restore', 'cache', file, '--yes'], h.deps),
      0,
      h.err.join('\n'),
    );

    assert.deepEqual(accessoryCalls(calls), [
      runningArgv('cache'),
      stageArgv('valkey', 'cache', sha256(RDB)),
      argv.replace,
      argv.ping,
    ]);
  });

  it("reports each outcome of the Valkey replacement by the host script's status", async () => {
    const argv = valkeyRestoreArgv('cache');
    const cases: readonly [number, RegExp][] = [
      [BACKUP_EXIT_VALKEY.stopFailed, /could not be stopped; nothing was replaced/],
      [
        BACKUP_EXIT_VALKEY.swapFailed,
        /could not be replaced; the accessory was started on its previous data/,
      ],
      [BACKUP_EXIT_VALKEY.startFailed, /replaced, but the accessory could not be started/],
      [BACKUP_EXIT_VALKEY.nothingStarted, /could not be replaced, and the accessory could not/],
      [9, /exited with code 9/],
    ];
    for (const [status, message] of cases) {
      const { remote, calls } = fakeServer({
        exitFor: (a) => (a[2] === argv.replace[2] ? status : undefined),
      });
      const h = harness(remote);
      const file = backupFile(h, 'c.rdb', RDB);

      assert.equal(await runJamalCommand(['restore', 'cache', file, '--yes'], h.deps), 1);

      assert.match(h.err.join('\n'), message);
      assert.deepEqual(accessoryCalls(calls).slice(2), [
        argv.replace,
        discardStageArgv('valkey', 'cache'),
      ]);
      assert.deepEqual(lockCalls(calls), ['acquire', 'release']);
    }
  });

  it('refuses a file that does not match its sidecar before contacting the server', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(
      h,
      'x.sql',
      Buffer.concat([SQL, Buffer.from('x')]),
      checksumLine(sha256(SQL), 'x.sql'),
    );

    assert.equal(await runJamalCommand(['restore', 'db', file, '--yes'], h.deps), 1);

    assert.match(h.err.join('\n'), /does not match its \.sha256 file/);
    assert.equal(calls.length, 0);
  });

  it('refuses a file without a sidecar before contacting the server', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(h, 'y.sql', SQL);
    rmSync(join(h.cwd, `${file}.sha256`));
    assert.equal(await runJamalCommand(['restore', 'db', file, '--yes'], h.deps), 1);
    assert.match(h.err.join('\n'), /has no \.sha256 file beside it/);
    assert.equal(calls.length, 0);
  });

  it('refuses a dump of another kind before contacting the server', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(h, 'misnamed.sql', PG);

    assert.equal(await runJamalCommand(['restore', 'db', file, '--yes'], h.deps), 1);

    assert.match(
      h.err.join('\n'),
      /the backup file is a postgres dump, and the accessory is mariadb/,
    );
    assert.equal(calls.length, 0);
  });

  it('requires --yes when no terminal can confirm', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    const file = backupFile(h, 'z.sql', SQL);

    assert.equal(await runJamalCommand(['restore', 'db', file], h.deps), 1);

    assert.match(h.err.join('\n'), /needs confirmation\n {2}hint: Pass --yes/);
    assert.equal(calls.length, 0);
  });

  it('proceeds only when the accessory name is typed back', async () => {
    const questions: string[] = [];
    for (const [answer, expected] of [
      ['nope', 1],
      [' db\n', 0],
    ] as const) {
      const { remote, calls } = fakeServer();
      const h = harness(remote, {
        prompt: async (question) => {
          questions.push(question);
          return answer;
        },
      });
      const file = backupFile(h, 'w.sql', SQL);
      assert.equal(await runJamalCommand(['restore', 'db', file], h.deps), expected, answer);
      if (expected === 1) {
        assert.match(h.err.join('\n'), /restore cancelled/);
        assert.equal(calls.length, 0);
      } else {
        assert.ok(calls.length > 0);
      }
    }
    assert.match(questions[0]!, /replaces all data of the mariadb accessory "db"/);
    assert.doesNotMatch(questions[0]!, /203\.0\.113\.7/, 'the prompt does not name the server');
  });

  it('replaces nothing when the staged copy fails its check on the server', async () => {
    const { remote, calls } = fakeServer({ stageExit: BACKUP_EXIT.checksumMismatch });
    const h = harness(remote);
    const file = backupFile(h, 's.sql', SQL);

    assert.equal(await runJamalCommand(['restore', 'db', file, '--yes'], h.deps), 1);

    assert.match(
      h.err.join('\n'),
      /arrived on the server incomplete or altered; nothing was replaced/,
    );
    assert.deepEqual(accessoryCalls(calls), [
      runningArgv('db'),
      stageArgv('mariadb', 'db', sha256(SQL)),
    ]);
    assert.deepEqual(lockCalls(calls), ['acquire', 'release']);
  });

  it('reports a failed PostgreSQL swap as keeping the live database, and discards the staged dump', async () => {
    const { remote, calls } = fakeServer({
      exitFor: (argv) =>
        argv.includes('/tmp/jamal-restore') && argv[3] === 'sh'
          ? BACKUP_EXIT.swapFailed
          : undefined,
    });
    const h = harness(remote);
    const file = backupFile(h, 'p.dump', PG);

    assert.equal(await runJamalCommand(['restore', 'pg', file, '--yes'], h.deps), 1);

    assert.match(h.err.join('\n'), /could not be swapped in; the live database was kept/);
    assert.deepEqual(accessoryCalls(calls).at(-1), discardStageArgv('postgres', 'pg'));
  });

  it('stops at a held deploy lock after the local checks', async () => {
    const { remote, calls } = fakeServer({ lockExit: 1 });
    const h = harness(remote);
    const file = backupFile(h, 'l.sql', SQL);
    assert.equal(await runJamalCommand(['restore', 'db', file, '--yes'], h.deps), 1);
    assert.match(h.err.join('\n'), /restore failed: the deploy lock is already held/);
    assert.deepEqual(accessoryCalls(calls), []);
  });

  it('rejects a missing file argument as a usage error', async () => {
    const { remote, calls } = fakeServer();
    const h = harness(remote);
    assert.equal(await runJamalCommand(['restore', 'db'], h.deps), 2);
    assert.equal(await runJamalCommand(['restore', 'db', 'a', 'b'], h.deps), 2);
    assert.equal(calls.length, 0);
  });
});

describe('jamal backup and restore on Windows', () => {
  it('refuse with unsupported_platform before loading the config or contacting the server', async () => {
    for (const args of [
      ['backup', 'db'],
      ['restore', 'db', 'file.sql', '--yes'],
    ]) {
      const { remote, calls } = fakeServer();
      const h = harness(remote, {
        platform: 'win32',
        loadJamalConfig: async () => {
          throw new Error('a refused verb must not load the config');
        },
      });
      assert.equal(await runJamalCommand(args, h.deps), 1, args.join(' '));
      assert.match(h.err.join('\n'), /does not run on Windows/);
      assert.equal(calls.length, 0);
    }
  });

  it('still print their help', async () => {
    const { remote } = fakeServer();
    const h = harness(remote, { platform: 'win32' });
    assert.equal(await runJamalCommand(['restore', '--help'], h.deps), 0);
    assert.match(h.out.join('\n'), /jamal restore - replace one accessory's data/);
  });
});
