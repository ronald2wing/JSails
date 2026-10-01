/**
 * The app's Valkey connection provider as a service.
 *
 * `valkeyToken` names the one {@link ValkeyConnections} of an application.
 * Every Valkey consumer (the cache and lease stores, the live change log and
 * bus, the broadcast pub/sub adapter, the jobs runtime) takes its connections
 * from it, so the app holds one client per shared role instead of one per
 * consumer, and every client runs a role policy with deadlines.
 *
 * The provider comes from `valkeyPlugin` (`./plugin.ts`), or from
 * {@link useValkeyConnections}, called by a consumer's `setup`: it returns the
 * registered provider, or, when there is none and `VALKEY_URL` is set, creates
 * it, registers it for the consumers after it, and hands its teardown to the
 * creating consumer. An app that sets `VALKEY_URL` thus still gets one
 * provider without listing a plugin. Both give the same object. This module
 * stays free of the plugin contract's option schemas, so a consumer pays only
 * for the connections.
 */

import type { ExtensionCleanup, ExtensionContext } from '../extensions/extension.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { defaultAppPrefix } from './app-prefix.js';
import { resolveValkeyUrl } from './connection.js';
import { createValkeyConnections, type ValkeyConnections } from './connections.js';

/**
 * The application's {@link ValkeyConnections}.
 *
 * @public
 */
export const valkeyToken: ServiceToken<ValkeyConnections> =
  createServiceToken<ValkeyConnections>('valkey');

/** The client name prefix of an app's connections. */
export const VALKEY_CLIENT_NAME = 'jsails';

/**
 * What {@link useValkeyConnections} found or created.
 *
 * @public
 */
export interface ValkeyConnectionsUse {
  readonly connections: ValkeyConnections;
  /** Closes the provider when this call created it; otherwise does nothing. */
  readonly release: ExtensionCleanup;
}

/**
 * The app's provider for a consumer's `setup`, given that setup's context:
 * the registered one, or one created from `VALKEY_URL` and registered for
 * later consumers, or `undefined` when neither exists. A created provider
 * keys under the default prefix of the context's `rootDir` and `mode`, never
 * of the working directory. The consumers that call it are still on the
 * legacy contract and declare no variables, so `env` defaults to the process
 * environment until they convert.
 *
 * @public
 */
export function useValkeyConnections(
  context: Pick<ExtensionContext, 'services' | 'rootDir' | 'mode'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ValkeyConnectionsUse | undefined {
  const { services, rootDir, mode } = context;
  const registered = services.tryGet(valkeyToken);
  if (registered !== undefined) {
    return { connections: registered, release: () => undefined };
  }
  const url = resolveValkeyUrl({}, env);
  if (url === undefined) {
    return undefined;
  }
  const connections = createValkeyConnections(url, {
    appPrefix: defaultAppPrefix(rootDir, { NODE_ENV: mode }),
    name: VALKEY_CLIENT_NAME,
  });
  services.provide(valkeyToken, connections);
  return { connections, release: () => connections.close() };
}
