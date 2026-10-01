/**
 * Grep guard for the live layer's query-builder blind spot.
 *
 * TypeORM's `QueryBuilder.insert`/`update`/`delete`/(`softDelete`) bypass the
 * entity subscriber subject events the change capture observes, so a row written
 * that way is silently invisible to the live layer. There is no way to observe
 * it from the capture side; the only defense is to keep query-builder writes out
 * of the codebase and fail the build when one appears outside the allowlist
 * (LIVE-PLAN.md Phase 3 note 9).
 *
 * The guard is syntactic, not semantic — it matches the obvious spelling (a
 * `createQueryBuilder(...)` chain reaching a write terminal within a short
 * span). A query-builder write hidden behind a farther assignment, or inside an
 * explicit `transaction()`, still eludes it; note 9 documents both as known,
 * unfixable-without-a-query-AST gaps. The allowlist below is deliberately empty:
 * no core source performs a query-builder write today.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Compiled core source root, reachable from the compiled test bundle. */
const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

/** Files that must never contain a query-builder write, and why (currently none). */
const ALLOWLIST: readonly string[] = [];

/**
 * A `createQueryBuilder(...)` chain reaching a write terminal `.insert(`/
 * `.update(`/`.delete(`/`.softDelete(` within a bounded span. The bound covers
 * the usual `.from`/`.into`/`.set`/`.values` interleave but not a longer
 * reassignment, by design.
 */
const WRITE_CHAIN =
  /createQueryBuilder\s*\([\s\S]{0,300}?\.(?:insert|update|delete|softDelete)\s*\(/;

/** Recursively collect every compiled `.js` source file under a directory. */
async function collectJs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Skip TypeORM's own emitted declaration maps; only `.js` (not `.js.map`) counts.
    if (entry.isDirectory()) {
      files.push(...(await collectJs(path)));
    } else if (entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

describe('query-builder writes are absent from core source', () => {
  it('no createQueryBuilder chain performs insert/update/delete/softDelete', async () => {
    const files = await collectJs(SRC_ROOT);
    assert.ok(files.length > 0, 'expected compiled core source files to scan');

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.includes(file)) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      if (WRITE_CHAIN.test(source)) {
        offenders.push(file);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'query-builder writes bypass the live capture subscriber; use the Active Record path or the allowlist',
    );
  });
});
