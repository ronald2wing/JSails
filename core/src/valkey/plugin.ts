/**
 * The `valkey` plugin: the app's Valkey connection provider, listed ahead of
 * its consumers, on the `definePlugin` contract.
 *
 * Its options are checked when the factory is called
 * (`config.invalid_options`); its setup creates the provider under
 * `valkeyToken`, connecting nothing, and fails with `valkey.invalid_url` when
 * neither `url` nor `VALKEY_URL` names a server. It registers the `valkey`
 * lifecycle unit for the web and worker roles: starting it connects the
 * `command` role, so an unreachable server fails the process's start instead
 * of its first request, and its readiness probe pings. The cleanup closes the
 * provider. Consumers reach the provider through `useValkeyConnections`
 * (`./provider.ts`), which does not load this module or its option schema.
 */

import { z } from 'zod';

import { definePlugin, type PluginFactory } from '../plugins/contract/define-plugin.js';
import { envVar, fn } from '../plugins/contract/option-schemas.js';
import { defaultAppPrefix } from './app-prefix.js';
import { assertConnectionUrl } from './connection.js';
import {
  createValkeyConnections,
  NAME_PATTERN,
  PREFIX_PATTERN,
  ValkeyError,
  type ValkeyTimeouts,
} from './connections.js';
import { VALKEY_CLIENT_NAME, valkeyToken } from './provider.js';

/**
 * Options for {@link valkeyPlugin}.
 *
 * @public
 */
export interface ValkeyPluginOptions {
  /** The `redis://`/`rediss://` URL. Falls back to `VALKEY_URL`. */
  readonly url?: string;
  /**
   * The app key prefix. Defaults to `<package name>:<NODE_ENV>`, the name read
   * from the nearest `package.json` at or above the app root.
   */
  readonly appPrefix?: string;
  /** Client name prefix for `CLIENT LIST`. Defaults to `jsails`. */
  readonly name?: string;
  /** Overrides of the default connect and command deadlines. */
  readonly timeouts?: Partial<ValkeyTimeouts>;
  /** Receives post-connect failures, sanitized. Defaults to `process.emitWarning`. */
  readonly onError?: (error: Error) => void;
}

/** Whether `value` is a `redis://` or `rediss://` URL. */
function isConnectionUrl(value: string): boolean {
  try {
    assertConnectionUrl(value, (message) => new ValkeyError('invalid_url', message));
    return true;
  } catch {
    return false;
  }
}

const milliseconds = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const valkeyOptions: z.ZodType<ValkeyPluginOptions> = z
  .object({
    url: z
      .string()
      .refine(isConnectionUrl, { message: 'must be a redis:// or rediss:// URL' })
      .optional(),
    appPrefix: z.string().regex(PREFIX_PATTERN, { message: 'must be a key prefix' }).optional(),
    name: z.string().regex(NAME_PATTERN, { message: 'must be a client name' }).optional(),
    timeouts: z
      .object({ connectMs: milliseconds.optional(), commandMs: milliseconds.optional() })
      .strict()
      .optional(),
    onError: fn<(error: Error) => void>().optional(),
  })
  .strict();

/**
 * The `valkey` plugin. Setup creates the provider without connecting; the
 * `valkey` unit connects the command role when the process starts.
 *
 * @public
 */
export const valkeyPlugin: PluginFactory<ValkeyPluginOptions | undefined> = definePlugin({
  name: 'valkey',
  options: valkeyOptions.optional(),
  env: { VALKEY_URL: envVar.url().optional() },
  provides: [valkeyToken],
  setup({ options = {}, env, services, rootDir, mode, lifecycle }) {
    const url = options.url ?? env.VALKEY_URL;
    if (url === undefined) {
      throw new ValkeyError('invalid_url', 'no Valkey URL configured: set url or VALKEY_URL');
    }
    const connections = createValkeyConnections(url, {
      appPrefix: options.appPrefix ?? defaultAppPrefix(rootDir, { NODE_ENV: mode }),
      name: options.name ?? VALKEY_CLIENT_NAME,
      ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    services.provide(valkeyToken, connections);
    lifecycle.register(['web', 'worker'], {
      name: 'valkey',
      async start() {
        await connections.shared('command');
      },
      // The provider is shared by every consumer, which drain before it;
      // closing it is the cleanup's, after every consumer's.
      drain: () => undefined,
      abort: () => undefined,
      async ready() {
        const client = await connections.shared('command');
        return (await client.ping()) === 'PONG';
      },
    });
    return () => connections.close();
  },
});
