/**
 * Tests for the `live:list` command (LIVE-PLAN.md Phase 9).
 *
 * Publications are registered at runtime by application code, so the CLI has
 * no default path to a registry — the command reports that through its default
 * seam. The `loadRegistry` seam lets the tests inject a live
 * {@link createPublicationRegistry} with a registered publication and assert
 * the name / collection / authorize rendering, matching how the `schedules`
 * command is exercised without a live runtime.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  createPublicationRegistry,
  definePublication,
  type PublicationRegistry,
} from '../../src/live/index.js';
import { runLiveListCommand, type LiveListDeps } from '../../src/cli/live-commands.js';
import type { ModelQuery } from '../../src/database/model-query.js';

type Row = { id: number };

// A publication definition avoids a live DataSource: the `query` callback only
// ever *returns* a ModelQuery (never executes), so a stub cast through
// `unknown` stands in for the real thing without reaching `getRepository()`.
function stubQuery(): ModelQuery<Row> {
  return {} as unknown as ModelQuery<Row>;
}

function aPublication(name: string, collection: string) {
  return definePublication({
    name,
    collection,
    params: z.object({}).strict(),
    authorize: () => true,
    query: () => stubQuery(),
  });
}

function depsFor(registry: PublicationRegistry): { deps: LiveListDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: LiveListDeps = {
    loadRegistry: async () => registry,
    stdout: (text) => lines.push(text),
  };
  return { deps, lines };
}

describe('runLiveListCommand', () => {
  it('prints a registered publication with name, collection, and authorize present', async () => {
    const registry = createPublicationRegistry();
    registry.register(aPublication('blog.posts', 'posts'));

    const { deps, lines } = depsFor(registry);
    const code = await runLiveListCommand('jsails.app.js', deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, ['Publications:', '  blog.posts  posts  authorize']);
  });

  it('renders (none) for an empty registry', async () => {
    const { deps, lines } = depsFor(createPublicationRegistry());
    const code = await runLiveListCommand('jsails.app.js', deps);

    assert.equal(code, 0);
    assert.deepEqual(lines, ['Publications: (none)']);
  });

  it('reports runtime registration when no registry is reachable', async () => {
    const lines: string[] = [];
    const deps: LiveListDeps = {
      loadRegistry: async () => undefined,
      stdout: (text) => lines.push(text),
    };

    // The default app config does not exist here, so the command must not try
    // to load it and must still report the honest "registered at runtime" note.
    const code = await runLiveListCommand('jsails.app.js', deps);

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /registered at runtime/);
  });
});
