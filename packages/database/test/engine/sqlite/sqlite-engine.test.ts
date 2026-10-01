/**
 * The SQLite engine's concurrency model: the writer lock, the shared reader,
 * read-only transaction handles, the `:memory:` single handle, asynchronous
 * busy retry against another process, and atomicity when a process holding a
 * write transaction is killed.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, type TestContext } from 'node:test';

import {
  createEngine,
  isDatabaseError,
  MAX_READ_TRANSACTIONS,
  resolveDatabaseConfig,
  type DatabaseOptions,
  type Engine,
  type TransactionConn,
} from '../../../src/engine/index.js';

const CHILD = fileURLToPath(new URL('./fixtures/sqlite-child.js', import.meta.url));

/** An engine on a fresh file, closed before its directory is removed. */
async function openFileEngine(
  t: TestContext,
  options: DatabaseOptions = {},
): Promise<{ engine: Engine; file: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'jsails-sqlite-'));
  const file = join(directory, 'engine.sqlite');
  const engine = await createEngine(resolveDatabaseConfig({ ...options, file }, { env: {} }));
  t.after(async () => {
    await engine.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const conn = await engine.lease();
  await conn.query('CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  await conn.release();
  return { engine, file };
}

async function labels(engine: Engine): Promise<string[]> {
  const conn = await engine.lease();
  try {
    return (await conn.query('SELECT label FROM rows ORDER BY id')).rows.map((row) =>
      String(row.label),
    );
  } finally {
    await conn.release();
  }
}

async function insert(engine: Engine, label: string): Promise<void> {
  const conn = await engine.lease();
  try {
    await conn.query('INSERT INTO rows (label) VALUES (?)', [label]);
  } finally {
    await conn.release();
  }
}

/** Resolves with `'pending'` if `promise` has not settled after `ms`. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms).unref()),
  ]);
}

function startChild(args: readonly string[]): { child: ChildProcess; line: Promise<string> } {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('\n')) resolve(output.trim());
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('\n'))
        reject(new Error(`child exited with ${String(code)} before reporting`));
    });
  });
  return { child, line };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/**
 * Kill a child and wait for it to exit. A test calls this in `finally`, before
 * its `t.after` hooks close the engine and remove the directory: Windows
 * refuses to delete a file another process still has open, and a child left
 * running would keep the test process alive.
 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = exited(child);
  child.kill('SIGKILL');
  await exit;
}

describe('the SQLite engine', () => {
  it('opens the file in WAL mode with synchronous NORMAL and foreign keys on', async (t) => {
    const { engine } = await openFileEngine(t);
    const conn = await engine.lease();
    try {
      assert.equal((await conn.query('PRAGMA journal_mode')).rows[0]?.journal_mode, 'wal');
      assert.equal((await conn.query('PRAGMA synchronous')).rows[0]?.synchronous, 1);
      assert.equal((await conn.query('PRAGMA foreign_keys')).rows[0]?.foreign_keys, 1);
    } finally {
      await conn.release();
    }
  });

  it('queues autocommit writes behind an open write transaction, in order', async (t) => {
    const { engine } = await openFileEngine(t);
    const tx = await engine.begin();
    await tx.query("INSERT INTO rows (label) VALUES ('tx')");
    const later = insert(engine, 'after');
    assert.equal(await settledWithin(later, 50), 'pending');
    await tx.commit();
    await later;
    assert.deepEqual(await labels(engine), ['tx', 'after']);
  });

  it('serves autocommit reads from the last commit while a write transaction is open', async (t) => {
    const { engine } = await openFileEngine(t);
    await insert(engine, 'committed');
    const tx = await engine.begin();
    try {
      await tx.query("INSERT INTO rows (label) VALUES ('pending')");
      assert.deepEqual(await settledWithin(labels(engine), 500), ['committed']);
      await tx.commit();
    } finally {
      await tx.release();
    }
    assert.deepEqual(await labels(engine), ['committed', 'pending']);
  });

  it('sends a write that starts like a read to the writer', async (t) => {
    const { engine } = await openFileEngine(t);
    const conn = await engine.lease();
    try {
      const result = await conn.query(
        "WITH incoming (label) AS (VALUES ('via-with')) INSERT INTO rows (label) SELECT label FROM incoming",
      );
      assert.equal(result.affected, 1);
    } finally {
      await conn.release();
    }
    assert.deepEqual(await labels(engine), ['via-with']);
  });

  it('gives a read-only transaction a stable snapshot and refuses its writes', async (t) => {
    const { engine } = await openFileEngine(t);
    await insert(engine, 'before');
    const reader = await engine.begin({ readOnly: true });
    try {
      await insert(engine, 'after');
      const seen = await reader.query('SELECT label FROM rows ORDER BY id');
      assert.deepEqual(
        seen.rows.map((row) => row.label),
        ['before'],
      );
      await assert.rejects(reader.query("INSERT INTO rows (label) VALUES ('no')"), {
        code: 'read_only',
      });
    } finally {
      await reader.release();
    }
  });

  it(`holds at most ${MAX_READ_TRANSACTIONS} read-only transactions open, and queues the next`, async (t) => {
    const { engine } = await openFileEngine(t, { acquireTimeoutMs: 100 });
    const open: TransactionConn[] = [];
    for (let index = 0; index < MAX_READ_TRANSACTIONS; index += 1) {
      open.push(await engine.begin({ readOnly: true }));
    }
    await assert.rejects(engine.begin({ readOnly: true }), { code: 'acquire_timeout' });
    // Read-only transactions never wait for the writer, nor it for them.
    const writer = await engine.begin();
    await writer.query("INSERT INTO rows (label) VALUES ('w')");
    await writer.commit();
    const queued = engine.begin({ readOnly: true });
    await open.pop()?.commit();
    const next = await queued;
    assert.equal((await next.query('SELECT COUNT(*) AS n FROM rows')).rows[0]?.n, 1);
    await next.release();
    for (const tx of open) await tx.release();
  });

  it('runs everything on one handle behind the lock for :memory:', async () => {
    const engine = await createEngine(resolveDatabaseConfig({ file: ':memory:' }, { env: {} }));
    try {
      const conn = await engine.lease();
      await conn.query('CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      const tx = await engine.begin();
      await tx.query("INSERT INTO rows (label) VALUES ('tx')");
      const read = conn.query('SELECT COUNT(*) AS n FROM rows');
      assert.equal(await settledWithin(read, 50), 'pending');
      await tx.commit();
      assert.equal((await read).rows[0]?.n, 1);
      const reader = await engine.begin({ readOnly: true });
      await assert.rejects(reader.query("INSERT INTO rows (label) VALUES ('no')"), {
        code: 'read_only',
      });
      await reader.release();
      await conn.query("INSERT INTO rows (label) VALUES ('writable again')");
      assert.equal((await conn.query('SELECT COUNT(*) AS n FROM rows')).rows[0]?.n, 2);
      await conn.release();
    } finally {
      await engine.close();
    }
  });

  it('waits out another process holding the write lock without blocking the event loop', async (t) => {
    const { engine, file } = await openFileEngine(t);
    const tx = await engine.begin();
    await tx.query("INSERT INTO rows (label) VALUES ('parent')");
    const { child, line } = startChild(['write', file, 'child']);
    try {
      // The child retries asynchronously while this process keeps running.
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 10);
      await new Promise((resolve) => setTimeout(resolve, 400));
      clearInterval(ticker);
      assert.ok(ticks >= 10, 'the parent event loop kept running');
      assert.equal(child.exitCode, null, 'the child waits for the lock');
      await tx.commit();
      assert.equal(await line, 'written');
      assert.equal(await exited(child), 0);
      assert.deepEqual(await labels(engine), ['parent', 'child']);
    } finally {
      await stopChild(child);
    }
  });

  it('fails a write with busy after the busy timeout, and keeps reads working', async (t) => {
    const { engine, file } = await openFileEngine(t, { busyTimeoutMs: 200 });
    await insert(engine, 'committed');
    const { child, line } = startChild(['hold', file]);
    try {
      assert.equal(await line, 'holding');
      const started = Date.now();
      await assert.rejects(insert(engine, 'blocked'), (error: unknown) => {
        assert.ok(isDatabaseError(error, 'busy'));
        assert.equal(error.transient, true);
        return true;
      });
      assert.ok(Date.now() - started >= 150);
      assert.deepEqual(await labels(engine), ['committed']);
    } finally {
      await stopChild(child);
    }
  });

  it('leaves the file atomic when a process is killed inside a write transaction', async (t) => {
    const { engine, file } = await openFileEngine(t);
    await insert(engine, 'committed');
    const { child, line } = startChild(['hold', file]);
    try {
      assert.equal(await line, 'holding');
    } finally {
      await stopChild(child);
    }
    assert.deepEqual(await labels(engine), ['committed']);
    await insert(engine, 'after');
    const conn = await engine.lease();
    try {
      assert.equal((await conn.query('PRAGMA integrity_check')).rows[0]?.integrity_check, 'ok');
    } finally {
      await conn.release();
    }
    assert.deepEqual(await labels(engine), ['committed', 'after']);
  });

  it('rolls back an open write transaction on close and reopens the file cleanly', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'jsails-sqlite-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = resolveDatabaseConfig({ file: join(directory, 'close.sqlite') }, { env: {} });
    const first = await createEngine(config);
    await insertTable(first);
    const tx = await first.begin();
    await tx.query("INSERT INTO rows (label) VALUES ('lost')");
    await first.close();
    await assert.rejects(tx.commit(), { code: 'closed' });
    const second = await createEngine(config);
    try {
      assert.deepEqual(await labels(second), []);
    } finally {
      await second.close();
    }
  });
});

async function insertTable(engine: Engine): Promise<void> {
  const conn = await engine.lease();
  await conn.query('CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  await conn.release();
}
