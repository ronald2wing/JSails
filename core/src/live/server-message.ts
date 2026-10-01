/**
 * The transport-agnostic server-to-client message of a live subscription,
 * shared by the server engine and the client store.
 */

import type { LiveRow } from './change-record.js';

/**
 * One server-to-client message on a live subscription: the transport-agnostic
 * wire protocol shared by the server engine and the client store.
 *
 * A `snapshot` replaces the subscription's rows; `resumed: false` tells the
 * client continuity was lost (the Ably signal), so it can show a refreshed
 * state rather than believe it holds a complete history. A successful resume
 * sends replayed `change` messages and no snapshot. An `error` carries a
 * value-free code and ends the subscription.
 */
export type LiveServerMessage =
  | {
      readonly type: 'snapshot';
      readonly subscriptionId: string;
      readonly sequence: number;
      readonly rows: readonly LiveRow[];
      /** False when the server could not resume and sent a full snapshot. */
      readonly resumed: boolean;
    }
  | {
      readonly type: 'change';
      readonly subscriptionId: string;
      readonly sequence: number;
      readonly collection: string;
      readonly id: string;
      readonly row: LiveRow | null;
    }
  | {
      readonly type: 'error';
      readonly subscriptionId: string;
      readonly code: string;
    };
