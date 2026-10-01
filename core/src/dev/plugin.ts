/**
 * Dev plugin (`jsails/dev`): the live-reload stream and the reload client
 * injected into HTML answers, in development.
 *
 * The server owns both halves. The route streams `/_jsails/dev/reload`, and a
 * response transform appends the client script to every HTML answer of a page,
 * API or mounted route, so no template has to know about it and a static
 * export never sees it. Framework answers outside a route (the 404 page of an
 * unmatched path) are not transformed.
 *
 * `devPlugin({ enabled? })` is a plugin on the `definePlugin` contract;
 * `enabled` defaults to whether the process runs in development mode. When it
 * is off, setup registers nothing. The generation the stream reports comes
 * from the file the dev parent names in `JSAILS_DEV_GENERATION`, a variable
 * the plugin declares; without a parent (a plain `jsails serve` in
 * development) the generation is a constant 0, so the route and the injection
 * work and nothing reloads. The cleanup stops the channel's polling.
 */

import { z } from 'zod';

import { publicAccess } from '../api/access-ref.js';
import { definePlugin, type PluginFactory } from '../plugins/contract/define-plugin.js';
import { envVar } from '../plugins/contract/option-schemas.js';
import { createGenerationChannel, DEV_GENERATION_ENV } from './generation.js';
import { devReloadTransform } from './html-injection.js';
import { liveReloadResponse } from './live-reload.js';

/**
 * Options for {@link devPlugin}.
 *
 * @public
 */
export interface DevPluginOptions {
  /** Serve the reload route and inject the client. Defaults to development mode. */
  readonly enabled?: boolean;
}

const devOptions: z.ZodType<DevPluginOptions> = z
  .object({ enabled: z.boolean().optional() })
  .strict();

/** The path of the reload stream the injected client subscribes to. */
const RELOAD_PATH = '/_jsails/dev/reload';

/**
 * The first-party dev plugin. In development it serves the reload stream and
 * injects the reload client; elsewhere it registers nothing.
 *
 * @public
 */
export const devPlugin: PluginFactory<DevPluginOptions | undefined> = definePlugin({
  name: 'dev',
  options: devOptions.optional(),
  env: { [DEV_GENERATION_ENV]: envVar.string().optional() },
  setup({ options, env, mode, routes }) {
    if (!(options?.enabled ?? mode === 'development')) return;
    const channel = createGenerationChannel({ path: env[DEV_GENERATION_ENV] });
    routes.add({
      methods: ['GET'],
      path: RELOAD_PATH,
      access: publicAccess('development live-reload stream; it carries only a build counter'),
      // The stream reads no session, so a cookie the browser sends is not a credential here.
      credentials: [],
      handler: (ctx) => liveReloadResponse({ channel, signal: ctx.signal }),
    });
    routes.transform(
      ['page', 'api', 'mount'],
      devReloadTransform({ generation: () => channel.current() }),
    );
    return () => channel.close();
  },
});
