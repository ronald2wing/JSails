/**
 * The notifications contract: the message, the channel and service surfaces,
 * and the value-free {@link NotificationError}.
 *
 * A {@link NotificationMessage} is deliberately smaller than a mail message —
 * `to`, `subject`, and a required plain-text `text` body — so any channel
 * (mail, SMS, push, ...) can consume it. A {@link NotificationChannel} delivers
 * one message to one destination; it is stateless with respect to the plugin
 * and owns no connection, so the plugin never closes it.
 *
 * There is deliberately no durable queue, retry policy, or database here:
 * delivery stays a synchronous primitive. An application that needs retries or
 * out-of-process delivery should enqueue the message with the jobs plugin and
 * send from the job handler instead of calling `notify` directly; the channel
 * remains the delivery primitive either way.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** A message to deliver. Every field is required. */
export interface NotificationMessage {
  /** Single recipient address (channel-specific format, e.g. an email address). */
  readonly to: string;
  /** Subject line. */
  readonly subject: string;
  /** Plain-text body. */
  readonly text: string;
}

/** The delivery surface every channel exposes. */
export interface NotificationChannel {
  /** Deliver one message. Rejects on failure; the error is never surfaced verbatim. */
  send(message: NotificationMessage): Promise<void>;
}

/** Options for {@link NotificationsService.notify}. */
export interface NotifyOptions {
  /** The channels to use, in order. Omit to use every configured channel. */
  readonly channels?: readonly string[];
}

/** The service the notifications plugin provides: send through named channels. */
export interface NotificationsService {
  /**
   * Deliver one message through the selected channels (all configured channels
   * when `options.channels` is omitted) in order, waiting for every attempt.
   * Any failures are aggregated into a {@link NotificationError}
   * (`delivery_failed`); an unknown channel name rejects (`unknown_channel`)
   * before any channel is attempted.
   */
  notify(message: NotificationMessage, options?: NotifyOptions): Promise<void>;
}

/** Stable failure codes carried by {@link NotificationError}. */
export type NotificationErrorCode = 'delivery_failed' | 'unknown_channel';

/**
 * Raised by `notify`. The message is fixed and value-free: it never carries a
 * requested channel name, an underlying transport error, an address, a subject,
 * a credential, or a payload. For `delivery_failed`, {@link channels} lists the
 * configured names of the channels that failed, in configuration order; for
 * `unknown_channel` it is empty.
 */
export class NotificationError extends JsailsError {
  /** The failed channel names (configuration identifiers), in configuration order. */
  readonly channels: readonly string[];

  constructor(
    readonly code: NotificationErrorCode,
    message: string,
    options: { readonly channels?: readonly string[] } = {},
  ) {
    super(message);
    this.channels = Object.freeze([...(options.channels ?? [])]);
  }
}
