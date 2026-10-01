/**
 * A bound SQLite engine on a fresh file with one `notes` table, closed before
 * its directory is removed, with optional engine options (a short acquire
 * timeout, say), and the small statement helpers the transaction unit tests
 * share.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import {
  createEngine,
  resolveDatabaseConfig,
  type DatabaseOptions,
  type Engine,
} from '../../../src/engine/index.js';

export async function openNotesEngine(
  t: TestContext,
  options: DatabaseOptions = {},
): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'jsails-transaction-'));
  const engine = await createEngine(
    resolveDatabaseConfig({ ...options, file: join(directory, 'notes.sqlite') }, { env: {} }),
  );
  t.after(async () => {
    await engine.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const conn = await engine.lease();
  await conn.query('CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)');
  await conn.release();
  return engine;
}

/** Insert a note through a fresh lease. */
export async function note(engine: Engine, label: string): Promise<void> {
  const conn = await engine.lease();
  try {
    await conn.query('INSERT INTO notes (label) VALUES (?)', [label]);
  } finally {
    await conn.release();
  }
}

/** Every note label, sorted, through a fresh lease. */
export async function labels(engine: Engine): Promise<string[]> {
  const conn = await engine.lease();
  try {
    const { rows } = await conn.query('SELECT label FROM notes ORDER BY label');
    return rows.map((row) => String(row.label));
  } finally {
    await conn.release();
  }
}
