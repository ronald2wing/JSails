/**
 * Tests for the backup and restore commands: their argv, the per-kind
 * scripts' credential handling, dump-kind detection, and backup file names.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BACKUP_EXIT,
  applyDatabaseArgv,
  backupFileName,
  detectBackupKind,
  discardStageArgv,
  dumpArgv,
  runningArgv,
  stageArgv,
  stagePath,
  valkeyRestoreArgv,
  type BackupKind,
} from '../../src/production/backup.js';
import { BACKUP_EXIT_VALKEY } from '../../src/production/remote-op.js';
import { SERVICE_CONVENTIONS } from '../../src/service-conventions.js';

const KINDS: readonly BackupKind[] = ['mariadb', 'postgres', 'valkey'];

/** The script of a `docker exec <name> sh -c <script> ...` argv. */
function scriptOf(argv: readonly string[]): string {
  const at = argv.indexOf('-c');
  assert.ok(at > 0, 'the argv runs a sh -c script');
  return argv[at + 1]!;
}

/** The swap script the Valkey replacement runs in its throwaway container. */
function swapScript(): string {
  return valkeyRestoreArgv('x').replace.at(-1)!;
}

/** Whether `sh -n` accepts a script: every script must at least parse. */
function parses(script: string): boolean {
  return spawnSync('sh', ['-n', '-c', script]).status === 0;
}

describe('backup argv', () => {
  it('dumps inside the accessory container with a fixed script and no arguments', () => {
    for (const kind of KINDS) {
      const argv = dumpArgv(kind, 'db');
      assert.deepEqual(argv.slice(0, 5), ['docker', 'exec', 'db', 'sh', '-c'], kind);
      assert.equal(argv.length, 6, `${kind}: nothing but the script follows`);
    }
  });

  it('reads every credential from the container environment, never from an argument', () => {
    const mariadb = scriptOf(dumpArgv('mariadb', 'db'));
    assert.match(mariadb, /export MYSQL_PWD="\$MARIADB_PASSWORD"/);
    assert.match(mariadb, /--user="\$MARIADB_USER"/);
    assert.doesNotMatch(mariadb, /--password|-p"|-p\$/, 'no password option, which ps would show');
    assert.match(mariadb, /--single-transaction --routines --triggers --events/);
    assert.match(mariadb, new RegExp(`exit ${BACKUP_EXIT.noCredentials}`));

    const postgres = scriptOf(dumpArgv('postgres', 'db'));
    assert.match(
      postgres,
      /pg_dump --username="\$u" --dbname="\$\{POSTGRES_DB:-\$u\}" --format=custom/,
    );
    assert.doesNotMatch(postgres, /PASSWORD/, 'the local socket needs no password');

    const valkey = scriptOf(dumpArgv('valkey', 'cache'));
    assert.doesNotMatch(valkey, /-a |--pass|AUTH /, 'valkey-cli reads REDISCLI_AUTH itself');
    assert.match(valkey, /BGSAVE SCHEDULE/);
    assert.match(valkey, /rdb_saves/);
    assert.match(valkey, /rdb_last_bgsave_status/);
    assert.match(valkey, /exec cat \/data\/dump\.rdb$/);
  });

  it('writes scripts that parse', { skip: process.platform === 'win32' && 'no POSIX sh' }, () => {
    const scripts = [
      ...KINDS.map((kind) => scriptOf(dumpArgv(kind, 'x'))),
      scriptOf(stageArgv('mariadb', 'x', 'a'.repeat(64))),
      scriptOf(applyDatabaseArgv('mariadb', 'x')),
      scriptOf(applyDatabaseArgv('postgres', 'x')),
      swapScript(),
      scriptOf(valkeyRestoreArgv('x').replace),
    ];
    for (const script of scripts) {
      assert.ok(parses(script), script);
    }
  });

  it('checks a running container by its state', () => {
    assert.deepEqual(runningArgv('db'), [
      'docker',
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      'db',
    ]);
  });
});

describe('restore argv', () => {
  it('stages the dump with its digest as the only data argument', () => {
    const digest = 'f'.repeat(64);
    const argv = stageArgv('postgres', 'db', digest);
    assert.deepEqual(argv.slice(0, 6), ['docker', 'exec', '-i', 'db', 'sh', '-c']);
    assert.deepEqual(argv.slice(7), ['sh', '/tmp/jamal-restore', digest]);
    assert.match(scriptOf(argv), /umask 077/);
    assert.match(scriptOf(argv), new RegExp(`exit ${BACKUP_EXIT.checksumMismatch}`));
  });

  it('stages a Valkey dump on its data volume, which the swap container shares', () => {
    assert.equal(stagePath('valkey'), `${SERVICE_CONVENTIONS.valkey.dataDir}/.jamal-restore.rdb`);
    assert.deepEqual(discardStageArgv('valkey', 'cache'), [
      'docker',
      'exec',
      'cache',
      'rm',
      '-f',
      '--',
      '/data/.jamal-restore.rdb',
    ]);
  });

  it('replaces a MariaDB database as the app user, quoting its name in the script', () => {
    const argv = applyDatabaseArgv('mariadb', 'db');
    assert.deepEqual(argv.slice(-2), ['sh', '/tmp/jamal-restore']);
    const script = scriptOf(argv);
    assert.match(script, /export MYSQL_PWD="\$MARIADB_PASSWORD"/);
    assert.match(script, /DROP DATABASE IF EXISTS `%s`;\\nCREATE DATABASE `%s`;/);
    assert.match(script, /sed 's\/`\/``\/g'/);
    assert.match(script, /trap 'rm -f -- "\$1"' EXIT/);
    assert.match(
      script,
      /mariadb --user="\$MARIADB_USER" --sandbox -- "\$MARIADB_DATABASE" < "\$1"$/,
      'the dump loads with client shell and file commands disabled',
    );
  });

  it('restores PostgreSQL into a scratch database and swaps it in one transaction', () => {
    const script = scriptOf(applyDatabaseArgv('postgres', 'db'));
    assert.match(script, /CREATE DATABASE jamal_restore TEMPLATE template0 OWNER :"u";/);
    assert.match(script, /pg_restore .*--dbname=jamal_restore .*--single-transaction "\$1"/);
    assert.match(
      script,
      /BEGIN;\nALTER DATABASE :"db" RENAME TO jamal_replaced;\nALTER DATABASE jamal_restore RENAME TO :"db";\nCOMMIT;/,
    );
    assert.match(script, /ALTER DATABASE :"db" WITH ALLOW_CONNECTIONS true;/);
    assert.match(script, new RegExp(`exit ${BACKUP_EXIT.swapFailed}`));
  });

  it('stops, swaps, and starts Valkey in one host-side command', () => {
    const argv = valkeyRestoreArgv('cache');
    const convention = SERVICE_CONVENTIONS.valkey;
    assert.deepEqual(argv.ping, ['docker', 'exec', 'cache', 'valkey-cli', 'ping']);
    assert.deepEqual(argv.replace.slice(0, 2), ['sh', '-c']);
    assert.deepEqual(argv.replace.slice(3, 7), [
      'sh',
      'cache',
      `${convention.volume}:${convention.dataDir}`,
      convention.image,
    ]);
    const host = scriptOf(argv.replace);
    assert.match(host, /^trap '' HUP PIPE\n/, 'a dropped connection cannot stop it midway');
    assert.match(host, /docker run --rm --network none -v "\$2" --entrypoint sh "\$3" -c "\$4"/);
    const script = swapScript();
    assert.match(script, /file appendonly\.aof\.1\.base\.rdb seq 1 type b/);
    assert.match(script, /mv \.jamal-aof appendonlydir/);
    assert.match(script, /ln \.jamal-restore\.rdb \.jamal-aof\/appendonly\.aof\.1\.base\.rdb/);
    assert.match(script, /mv -f \.jamal-restore\.rdb dump\.rdb\nrm -rf \.jamal-aof-old$/);
  });

  it(
    'always starts Valkey again once it was stopped, and says what happened',
    { skip: process.platform === 'win32' && 'no POSIX sh' },
    () => {
      const argv = valkeyRestoreArgv('cache');
      /** Run the host script with a fake docker failing the named verbs; returns status and its log. */
      function replace(failing: readonly string[]): { status: number | null; log: string } {
        const dir = mkdtempSync(join(tmpdir(), 'jamal-valkey-replace-'));
        try {
          const docker = join(dir, 'docker');
          writeFileSync(
            docker,
            `#!/bin/sh\necho "$1" >> "${dir}/log"\ncase " $FAILING " in *" $1 "*) echo "$1 broke" >&2; exit 1 ;; esac\necho noise\n`,
          );
          chmodSync(docker, 0o755);
          const result = spawnSync(argv.replace[0]!, argv.replace.slice(1), {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH ?? ''}`,
              FAILING: failing.join(' '),
            },
            encoding: 'utf8',
          });
          assert.doesNotMatch(
            result.stdout,
            /noise/,
            "docker's own output stays off the connection",
          );
          if (failing.length > 0) assert.match(result.stderr, /broke/, 'the failure is forwarded');
          return { status: result.status, log: readFileSync(join(dir, 'log'), 'utf8') };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      assert.deepEqual(replace([]), { status: 0, log: 'stop\nrun\nstart\n' });
      assert.deepEqual(replace(['stop']), { status: BACKUP_EXIT_VALKEY.stopFailed, log: 'stop\n' });
      assert.deepEqual(replace(['run']), {
        status: BACKUP_EXIT_VALKEY.swapFailed,
        log: 'stop\nrun\nstart\n',
      });
      assert.deepEqual(replace(['start']), {
        status: BACKUP_EXIT_VALKEY.startFailed,
        log: 'stop\nrun\nstart\n',
      });
      assert.deepEqual(replace(['run', 'start']), {
        status: BACKUP_EXIT_VALKEY.nothingStarted,
        log: 'stop\nrun\nstart\n',
      });
    },
  );

  it(
    'runs the swap script on a scratch directory to a loadable layout',
    {
      skip: process.platform === 'win32' && 'no POSIX sh',
    },
    () => {
      const script = swapScript();
      const result = spawnSync(
        'sh',
        [
          '-c',
          'd=$(mktemp -d) && mkdir "$d/data" "$d/data/appendonlydir" && printf old > "$d/data/appendonlydir/old" && ' +
            'printf REDIS0011new > "$d/data/.jamal-restore.rdb" && ' +
            'sed "s#^cd /data#cd $d/data#" > "$d/swap.sh" && sh "$d/swap.sh" && ' +
            'ls -A "$d/data" "$d/data/appendonlydir" && cat "$d/data/appendonlydir/appendonly.aof.manifest" "$d/data/dump.rdb"; ' +
            'rc=$?; rm -rf "$d"; exit $rc',
        ],
        { input: script, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /appendonly\.aof\.1\.base\.rdb\nappendonly\.aof\.1\.incr\.aof\nappendonly\.aof\.manifest/,
      );
      assert.doesNotMatch(result.stdout, /\bold\b/, 'the previous append-only files are gone');
      assert.doesNotMatch(result.stdout, /\.jamal-restore\.rdb/, 'the staged file was moved');
      assert.doesNotMatch(result.stdout, /\.jamal-aof/, 'no build or old directory is left');
      assert.match(result.stdout, /type i\nREDIS0011new$/);
    },
  );

  it(
    'leaves the previous data in place when the swap cannot be prepared',
    {
      skip: process.platform === 'win32' && 'no POSIX sh',
    },
    () => {
      const script = swapScript();
      // No staged file: the preparation fails before anything is switched.
      const result = spawnSync(
        'sh',
        [
          '-c',
          'd=$(mktemp -d) && mkdir "$d/data" "$d/data/appendonlydir" && printf old > "$d/data/appendonlydir/old" && ' +
            'printf REDIS0011old > "$d/data/dump.rdb" && ' +
            'sed "s#^cd /data#cd $d/data#" > "$d/swap.sh"; sh "$d/swap.sh" 2>/dev/null; echo "swap=$?"; ' +
            'cat "$d/data/appendonlydir/old" "$d/data/dump.rdb"; rm -rf "$d"',
        ],
        { input: script, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^swap=[1-9]\d*\noldREDIS0011old$/);
    },
  );
});

describe('detectBackupKind', () => {
  it('recognizes each kind by its leading bytes', () => {
    assert.equal(detectBackupKind(Buffer.from('PGDMP\x01\x0f\x00')), 'postgres');
    assert.equal(detectBackupKind(Buffer.from('REDIS0011\xfa')), 'valkey');
    assert.equal(detectBackupKind(Buffer.from('VALKEY080')), 'valkey');
    assert.equal(
      detectBackupKind(Buffer.from('/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump')),
      'mariadb',
    );
    assert.equal(detectBackupKind(Buffer.from('-- MariaDB dump 10.19')), 'mariadb');
    assert.equal(detectBackupKind(Buffer.from('-- MySQL dump 10.13')), 'mariadb');
  });

  it('recognizes nothing else, whatever the file is called', () => {
    for (const head of ['', 'SELECT 1;', '\x1f\x8b\x08', 'PK\x03\x04', ' PGDMP']) {
      assert.equal(detectBackupKind(Buffer.from(head, 'latin1')), undefined, JSON.stringify(head));
    }
  });
});

describe('backupFileName', () => {
  it('names the app, the accessory, and the UTC time in basic ISO form', () => {
    const date = new Date('2026-11-21T16:40:12.345Z');
    assert.equal(backupFileName('shop', 'db', 'mariadb', date), 'shop-db-20261121T164012Z.sql');
    assert.equal(
      backupFileName('shop-staging', 'pg', 'postgres', date),
      'shop-staging-pg-20261121T164012Z.dump',
    );
    assert.equal(
      backupFileName('shop', 'cache', 'valkey', date),
      'shop-cache-20261121T164012Z.rdb',
    );
  });
});
