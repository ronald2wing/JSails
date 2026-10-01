/**
 * The `@jsails/webhook` error type. Value-free: no secret, no signature, no
 * body ever reaches the message or the context.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** Every way a webhook request can be rejected, plus a bad plugin option. */
export type WebhookErrorCode =
  | 'invalid_endpoint'
  | 'invalid_signature'
  | 'timestamp_out_of_tolerance'
  | 'replayed'
  | 'unsupported_replay_guard';

/** A webhook failure. */
export class WebhookError extends JsailsError {
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    options?: {
      readonly context?: Readonly<Record<string, string | number | boolean>>;
      readonly suggestion?: string;
    },
  ) {
    super(message, options);
  }
}
