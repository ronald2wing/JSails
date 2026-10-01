/**
 * Shared filesystem fixtures for the content tests.
 *
 * Every content test builds a throwaway content root, writes a map of
 * relative-path fixtures into it, and discovers a collection. The temp-dir
 * lifecycle and the write loop are identical across the suites; only the
 * fixture data differs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

import { discoverContent, type ContentCollection } from '../src/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
export function tempRoot(t: TestContext, prefix = 'jsails-content-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a set of fixture files (paths relative to `root`, dirs created as needed). */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}

/** Build a collection in a temp dir from the given `.md` file map. */
export async function fixtureCollection(
  t: TestContext,
  files: Record<string, string>,
  prefix?: string,
): Promise<ContentCollection> {
  const root = tempRoot(t, prefix);
  writeFiles(root, files);
  return discoverContent(root);
}
