/**
 * A second process on the same SQLite file, for the multi-process tests of
 * sqlite-engine.test.ts. `write <file> <label>` inserts one row in autocommit
 * (waiting out a lock the parent holds) and prints `written`; `hold <file>`
 * opens a write transaction, inserts 500 rows, prints `holding`, and waits
 * until it is killed.
 */

import { createEngine, resolveDatabaseConfig } from '../../../../src/engine/index.js';

const [mode, file, label] = process.argv.slice(2);
if (file === undefined || (mode !== 'write' && mode !== 'hold')) {
  process.stderr.write('usage: sqlite-child.js write|hold <file> [label]\n');
  process.exitCode = 2;
} else {
  const engine = await createEngine(
    resolveDatabaseConfig({ file, busyTimeoutMs: 10_000 }, { env: {} }),
  );
  if (mode === 'write') {
    const conn = await engine.lease();
    await conn.query('INSERT INTO rows (label) VALUES (?)', [label ?? 'child']);
    await conn.release();
    await engine.close();
    process.stdout.write('written\n');
  } else {
    const tx = await engine.begin();
    for (let index = 0; index < 500; index += 1) {
      await tx.query('INSERT INTO rows (label) VALUES (?)', [`uncommitted-${index}`]);
    }
    process.stdout.write('holding\n');
    setInterval(() => undefined, 1000);
  }
}
