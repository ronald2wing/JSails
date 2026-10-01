/**
 * Serve the webhook plugin's routes through the real request pipeline, its
 * replay guard over a given store: a stand-in for the cache plugin provides
 * the application cache service, every namespace of it the given store.
 */

import { createApp } from 'jsails';
import { cacheToken, type CacheStore } from 'jsails/cache';
import { runExtensions } from 'jsails/extensions';
import { definePlugin } from 'jsails/kernel';

import { webhookPlugin, type WebhookPluginOptions } from '../src/plugin.js';

/** An app that serves `options`' endpoints, and the namespaces the plugin asked for. */
export async function serveWebhooks(
  options: WebhookPluginOptions,
  store: CacheStore,
): Promise<{
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly namespaces: readonly string[];
}> {
  const namespaces: string[] = [];
  const cache = definePlugin({
    name: 'test-cache',
    provides: [cacheToken],
    setup({ services }) {
      services.provide(cacheToken, {
        cache(name) {
          namespaces.push(name);
          return store;
        },
      });
    },
  });
  const runtime = await runExtensions([cache(), webhookPlugin(options)], {
    rootDir: import.meta.dirname,
    env: {},
  });
  const app = await createApp({
    manifest: { entries: [], byRoute: new Map() },
    contributions: { routes: runtime.routes, transforms: runtime.transforms },
  });
  return { app, namespaces };
}
