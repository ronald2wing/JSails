/**
 * Dev plugin (`jsails/dev`): mounts the live-reload SSE route and injects the
 * reload client into HTML responses in development.
 *
 * The server owns both halves. The route streams `/_jsails/dev/reload`, and a
 * middleware appends the client script to every HTML response — no template
 * has to know about it, and a static export never sees it. The plugin is inert
 * in any other environment: `setup` registers no hook unless `enabled`.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createGenerationChannel, DEV_GENERATION_ENV } from './dev-generation.js';
import { devReloadMiddleware } from './html-injection.js';
import { liveReloadResponse } from './live-reload.js';

/** Options for {@link devPlugin}. */
export interface DevPluginOptions {
  /** Mount the reload route. Defaults to `NODE_ENV === 'development'`. */
  readonly enabled?: boolean;
}

/**
 * The first-party dev plugin. In development it mounts the reload SSE route and
 * injects the reload client; elsewhere it is a no-op (no hook is registered).
 */
export function devPlugin(options: DevPluginOptions = {}): JsailsPlugin {
  const enabled = options.enabled ?? process.env.NODE_ENV === 'development';
  return definePlugin({
    name: 'dev',
    setup({ configureHttp }) {
      if (!enabled) return;
      // The dev parent writes the generation file and passes its path. Without
      // a parent (a plain `jsails serve` in development) the channel is a
      // constant 0: the route and the injection still work, nothing reloads.
      const channel = createGenerationChannel({ path: process.env[DEV_GENERATION_ENV] });
      configureHttp((app) => {
        app.get('/_jsails/dev/reload', () => liveReloadResponse({ channel }));
        app.use('*', devReloadMiddleware({ generation: () => channel.current() }));
      });
    },
  });
}
