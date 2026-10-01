/**
 * Tests for the local backup file: the atomic write with its SHA-256 sidecar,
 * and the checks a file passes before it is restored.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BackupError } from '../../src/production/backup.js';
import {
  checksumLine,
  openBackupSink,
  verifyBackupFile,
} from '../../src/production/backup-file.js';

const root = mkdtempSync(join(tmpdir(), 'jamal-backup-file-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function scratch(): string {
  counter += 1;
  return join(root, `case-${counter}`);
}

const SQL = Buffer.from(
  '/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump\nCREATE TABLE t (id int);\n',
);

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Write `chunks` into the sink's stream and wait for it to finish. */
async function feed(stream: NodeJS.WritableStream, chunks: readonly Buffer[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', resolve);
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}

function isBackupError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BackupError && error.code === code;
}

/** POSIX file modes are not Windows facts. */
const posixModes = { skip: process.platform === 'win32' && 'POSIX file modes' };

describe('openBackupSink', () => {
  it('publishes the dump only on commit, with a sha256sum sidecar', async () => {
    const dir = scratch();
    const sink = await openBackupSink(dir, 'app-db-20261121T000000Z.sql');
    await feed(sink.stream, [SQL.subarray(0, 10), SQL.subarray(10)]);

    assert.deepEqual(readdirSync(dir), ['.app-db-20261121T000000Z.sql.partial']);

    const written = await sink.commit('mariadb');
    assert.equal(written.path, join(dir, 'app-db-20261121T000000Z.sql'));
    assert.equal(written.bytes, SQL.length);
    assert.equal(written.sha256, sha256(SQL));
    assert.deepEqual(readdirSync(dir).sort(), [
      'app-db-20261121T000000Z.sql',
      'app-db-20261121T000000Z.sql.sha256',
    ]);
    assert.deepEqual(readFileSync(written.path), SQL);
    assert.equal(
      readFileSync(`${written.path}.sha256`, 'utf8'),
      `${sha256(SQL)}  app-db-20261121T000000Z.sql\n`,
    );
  });

  it('creates the directory 0700 and both files 0600', posixModes, async () => {
    const dir = scratch();
    const sink = await openBackupSink(dir, 'a.sql');
    await feed(sink.stream, [SQL]);
    const written = await sink.commit('mariadb');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(written.path).mode & 0o777, 0o600);
    assert.equal(statSync(`${written.path}.sha256`).mode & 0o777, 0o600);
  });

  it('writes a sidecar sha256sum itself accepts', posixModes, async (t) => {
    if (spawnSync('sha256sum', ['--version']).status !== 0) {
      t.skip('sha256sum is not installed');
      return;
    }
    const dir = scratch();
    const sink = await openBackupSink(dir, 'b.sql');
    await feed(sink.stream, [SQL]);
    await sink.commit('mariadb');
    assert.equal(spawnSync('sha256sum', ['-c', 'b.sql.sha256'], { cwd: dir }).status, 0);
  });

  it('refuses an empty dump and keeps nothing', async () => {
    const dir = scratch();
    const sink = await openBackupSink(dir, 'c.sql');
    await feed(sink.stream, []);
    await assert.rejects(sink.commit('mariadb'), isBackupError('empty_dump'));
    await sink.discard();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('refuses output that is not a dump of the kind and keeps nothing', async () => {
    const dir = scratch();
    const sink = await openBackupSink(dir, 'd.dump');
    await feed(sink.stream, [SQL]);
    await assert.rejects(sink.commit('postgres'), isBackupError('unknown_format'));
    await sink.discard();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('never overwrites an existing backup', async () => {
    const dir = scratch();
    const first = await openBackupSink(dir, 'e.sql');
    await feed(first.stream, [SQL]);
    await first.commit('mariadb');

    const second = await openBackupSink(dir, 'e.sql');
    await feed(second.stream, [Buffer.concat([SQL, Buffer.from('more')])]);
    await assert.rejects(second.commit('mariadb'), isBackupError('exists'));
    await second.discard();
    assert.deepEqual(readFileSync(join(dir, 'e.sql')), SQL);
    assert.equal(
      readFileSync(join(dir, 'e.sql.sha256'), 'utf8'),
      checksumLine(sha256(SQL), 'e.sql'),
    );
    assert.deepEqual(readdirSync(dir).sort(), ['e.sql', 'e.sql.sha256']);
  });

  it('refuses a second writer of the same partial file', async () => {
    const dir = scratch();
    const first = await openBackupSink(dir, 'f.sql');
    await assert.rejects(openBackupSink(dir, 'f.sql'), isBackupError('exists'));
    await first.discard();
    assert.equal(existsSync(first.partialPath), false);
  });
});

describe('verifyBackupFile', () => {
  function backup(name: string, data: Buffer, line?: string): string {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, data);
    if (line !== undefined) writeFileSync(`${path}.sha256`, line);
    return path;
  }

  it('accepts a file that matches its sidecar and names its kind', async () => {
    const path = backup('g.sql', SQL, checksumLine(sha256(SQL), 'g.sql'));
    assert.deepEqual(await verifyBackupFile(path), {
      kind: 'mariadb',
      sha256: sha256(SQL),
      bytes: SQL.length,
    });
  });

  it('refuses a file without a sidecar', async () => {
    const path = backup('h.sql', SQL);
    await assert.rejects(verifyBackupFile(path), isBackupError('missing_checksum'));
  });

  it('refuses a sidecar that is malformed or names another file', async () => {
    for (const line of ['nonsense\n', `${sha256(SQL)}  other.sql\n`, `${sha256(SQL)}\n`]) {
      const path = backup('i.sql', SQL, line);
      await assert.rejects(verifyBackupFile(path), isBackupError('invalid_checksum'), line);
    }
  });

  it('refuses a file whose content no longer matches, without echoing either digest', async () => {
    const path = backup(
      'j.sql',
      Buffer.concat([SQL, Buffer.from('tampered')]),
      checksumLine(sha256(SQL), 'j.sql'),
    );
    await assert.rejects(verifyBackupFile(path), (error: unknown) => {
      assert.ok(isBackupError('checksum_mismatch')(error));
      assert.doesNotMatch((error as Error).message, /[0-9a-f]{64}|j\.sql/);
      return true;
    });
  });

  it('refuses content that is not a dump jamal recognizes', async () => {
    const data = Buffer.from('just text\n');
    const path = backup('k.sql', data, checksumLine(sha256(data), 'k.sql'));
    await assert.rejects(verifyBackupFile(path), isBackupError('unknown_format'));
  });

  it('accepts the binary-mode marker sha256sum -b writes', async () => {
    const data = Buffer.from('PGDMP\x01\x0f');
    const path = backup('l.dump', data, `${sha256(data)} *l.dump\n`);
    assert.equal((await verifyBackupFile(path)).kind, 'postgres');
  });
});
