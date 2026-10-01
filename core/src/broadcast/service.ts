/**
 * Broadcast kernel contract (`jsails/broadcast`).
 *
 * `broadcastPlugin` provides this service under {@link broadcastToken} as soon
 * as the extension is set up. The transport handle does not exist until the
 * application serves (`onServe`), so publishing before the server starts fails
 * closed with a value-free error rather than silently dropping the payload.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { JsonValue } from '../contracts/http.js';

/** Stable machine code carried by {@link BroadcastServiceError}. */
export type BroadcastServiceErrorCode = 'unavailable' | 'closed';

/** Raised when a broadcast is published outside the served lifecycle. */
export class BroadcastServiceError extends Error {
  readonly code: BroadcastServiceErrorCode;

  constructor(code: BroadcastServiceErrorCode, message: string) {
    super(message);
    this.name = 'BroadcastServiceError';
    this.code = code;
  }
}

/** The application-facing broadcast seam. */
export interface BroadcastService {
  /** Publish one ephemeral payload to an authorized channel. */
  publish(channel: string, event: string, data: JsonValue): void;
}

/** Opaque token for the application {@link BroadcastService}. */
export const broadcastToken: ServiceToken<BroadcastService> =
  createServiceToken<BroadcastService>('broadcast');
