/**
 * The blog's live publication (`blog.posts`, LIVE-PLAN.md Phase 10).
 *
 * The blog plugin registers the publication only when the live plugin has
 * provided a registry, so the blog keeps working in an app that does not run
 * the live layer. These tests cover both halves: the publication is absent
 * without a registry, and with one it is registered under the name the client
 * subscribes to, with a query the live layer's shape guard accepts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FileDataSource } from 'jsails/database';
import { definePlugin, runExtensions } from 'jsails/extensions';
import {
  assertPublicationShape,
  createPublicationRegistry,
  publicationRegistryToken,
  type ErasedPublication,
  type PublicationRegistry,
} from 'jsails/live';

import { JsailsContentPost } from '../src/persistence/index.js';
import { blogPlugin } from '../src/plugin.js';

/** Run the blog plugin with a registry already provided, as the live plugin does. */
async function withRegistry(): Promise<PublicationRegistry> {
  const registry = createPublicationRegistry();
  const liveStub = definePlugin({
    name: 'live-stub',
    setup({ services }) {
      services.provide(publicationRegistryToken, registry);
    },
  });
  await runExtensions([liveStub, blogPlugin()]);
  return registry;
}

/** Resolve a publication the test expects to exist, failing loudly when absent. */
function requirePublication(registry: PublicationRegistry, name: string): ErasedPublication {
  const publication = registry.get(name);
  assert.ok(publication, `publication ${name} must be registered`);
  return publication;
}

describe('blog live publication', () => {
  it('registers blog.posts when a publication registry is provided', async () => {
    const registry = await withRegistry();

    const publication = requirePublication(registry, 'blog.posts');
    assert.equal(publication.name, 'blog.posts');
    assert.equal(publication.collection, 'posts');
  });

  it('registers nothing when the live layer is not running', async () => {
    // No registry is provided, so the blog must not throw and must not invent
    // one: the publication simply does not exist in this app.
    const runtime = await runExtensions([blogPlugin()]);
    assert.equal(runtime.services.tryGet(publicationRegistryToken), undefined);
  });

  it('authorizes every subscriber, because only published posts are exposed', async () => {
    const registry = await withRegistry();
    const publication = requirePublication(registry, 'blog.posts');

    const allowed = await publication.authorize({
      params: {},
      user: null,
      request: { ip: null, origin: null, headers: {} },
    });
    assert.equal(allowed, true);
  });

  it('builds a query the live shape guard accepts', async () => {
    // The guard rejects limit/offset, relation predicates, and raw `apply`,
    // because a row could otherwise enter or leave the result set without being
    // written and the client would diverge silently (LIVE-PLAN.md §15).
    // `query()` resolves the entity's repository, so the entity needs a bound
    // data source; a read-only in-memory one is enough to build the query.
    const dataSource = await FileDataSource.create({
      models: [{ entity: JsailsContentPost, rows: [] }],
    });
    try {
      const registry = await withRegistry();
      const publication = requirePublication(registry, 'blog.posts');

      const built = publication.query({
        params: {},
        user: null,
        request: { ip: null, origin: null, headers: {} },
        signal: new AbortController().signal,
      });

      assert.doesNotThrow(() => assertPublicationShape(built));
    } finally {
      await dataSource.close();
    }
  });
});
