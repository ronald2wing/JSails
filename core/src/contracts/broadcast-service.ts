/**
 * The broadcast service contract: the application-facing publish seam the
 * `broadcast` plugin provides, and its token. It lives with the contracts,
 * not with the Socket.IO runtime, so a plugin that only publishes (the
 * notifications plugin's broadcast channel) declares the token without
 * loading Socket.IO. `jsails/broadcast` and `jsails/internal` export the same
 * objects.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { JsonValue } from './http.js';

/**
 * The application-facing broadcast seam.
 *
 * @public
 */
export interface BroadcastService {
  /** Publish one ephemeral payload to an authorized channel. */
  publish(channel: string, event: string, data: JsonValue): void;
  /**
   * Re-run connection authentication and channel authorization for every
   * connected client, disconnecting identities that no longer authenticate and
   * evicting revoked channel memberships. Call it after a logout or a
   * permission change. Resolves without effect before the application serves.
   */
  revalidate(): Promise<void>;
}

/**
 * Opaque token for the application {@link BroadcastService}.
 *
 * @public
 */
export const broadcastToken: ServiceToken<BroadcastService> =
  createServiceToken<BroadcastService>('broadcast');
