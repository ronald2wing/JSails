/**
 * Tests for the dev loop's incremental auto-import injector: only the files a
 * burst names are processed, and the injector's own writes are not changes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createIncrementalAutoImports } from '../../src/dev/incremental-auto-imports.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const USES_HOOK = 'export function C() { const [v] = useState(0); return v; }\n';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-dev-inject-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'dist', 'ui'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'ui', 'a.js'), USES_HOOK);
  writeFileSync(join(dir, 'dist', 'ui', 'b.js'), USES_HOOK);
  return dir;
}

describe('createIncrementalAutoImports', () => {
  it('processes only the compiled files the burst names', () => {
    const dir = project();
    const injector = createIncrementalAutoImports(dir);

    const result = injector.injectChanged(['dist/ui/a.js']);

    assert.deepEqual(result, { relevant: true, error: undefined });
    assert.match(readFileSync(join(dir, 'dist', 'ui', 'a.js'), 'utf8'), /import \{ useState \}/);
    assert.equal(
      readFileSync(join(dir, 'dist', 'ui', 'b.js'), 'utf8'),
      USES_HOOK,
      'an unnamed file is not touched',
    );
  });

  it('reports the echo of its own write as not relevant', () => {
    const dir = project();
    const injector = createIncrementalAutoImports(dir);
    injector.injectChanged(['dist/ui/a.js']);
    const injected = readFileSync(join(dir, 'dist', 'ui', 'a.js'), 'utf8');

    assert.equal(injector.injectChanged(['dist/ui/a.js']).relevant, false);
    assert.equal(readFileSync(join(dir, 'dist', 'ui', 'a.js'), 'utf8'), injected);

    // A real re-emit after the echo is a change again.
    writeFileSync(join(dir, 'dist', 'ui', 'a.js'), USES_HOOK);
    assert.equal(injector.injectChanged(['dist/ui/a.js']).relevant, true);
  });

  it('treats non-dist, deleted, and unnamed bursts as relevant', () => {
    const dir = project();
    const injector = createIncrementalAutoImports(dir);

    assert.equal(injector.injectChanged(['jsails.app.js']).relevant, true);
    assert.equal(injector.injectChanged(['dist/ui/gone.js']).relevant, true);

    const full = injector.injectChanged(undefined);
    assert.equal(full.relevant, true);
    assert.match(readFileSync(join(dir, 'dist', 'ui', 'b.js'), 'utf8'), /import \{ useState \}/);
  });

  it('returns an out-of-scope use as an error without throwing', () => {
    const dir = project();
    mkdirSync(join(dir, 'dist', 'server'));
    writeFileSync(join(dir, 'dist', 'server', 'x.js'), USES_HOOK);
    const injector = createIncrementalAutoImports(dir);

    const result = injector.injectChanged(['dist/server/x.js', 'dist/ui/a.js']);

    assert.equal(result.relevant, true);
    assert.ok(result.error instanceof Error);
    assert.match(readFileSync(join(dir, 'dist', 'ui', 'a.js'), 'utf8'), /import \{ useState \}/);
  });
});
