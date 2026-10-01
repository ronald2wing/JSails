/**
 * Broadcast kernel contract (`jsails/broadcast`).
 *
 * `broadcastPlugin` provides this service under {@link broadcastToken} as soon
 * as the extension is set up. The transport handle does not exist until the
 * application serves (`onServe`), so publishing before the server starts fails
 * closed with a value-free error rather than silently dropping the payload.
 * The service interface and its token are the contracts' (re-exported here).
 */

import { JsailsError } from '../errors/jsails-error.js';

export { broadcastToken, type BroadcastService } from '../contracts/broadcast-service.js';

/** Stable machine code carried by {@link BroadcastServiceError}. */
export type BroadcastServiceErrorCode = 'unavailable' | 'closed';

/** Raised when a broadcast is published outside the served lifecycle. */
export class BroadcastServiceError extends JsailsError {
  constructor(
    readonly code: BroadcastServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
