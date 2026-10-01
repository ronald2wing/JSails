/**
 * The `@jsails/webhook` error type. Value-free: no secret, no signature, no
 * body ever reaches the message or the context.
 */

import { JsailsError } from 'jsails/errors';

/**
 * Every way a webhook request can be rejected, plus a bad endpoint
 * configuration (`invalid_endpoint`: a plugin option or a direct call's options).
 */
export type WebhookErrorCode =
  'invalid_endpoint' | 'invalid_signature' | 'timestamp_out_of_tolerance' | 'replayed';

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
