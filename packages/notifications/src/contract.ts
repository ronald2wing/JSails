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
 * A defined notification (`defineNotification`) is richer: it is sent to a
 * {@link Notifiable} and builds one payload per channel (a mail message, a
 * database row's JSON, a broadcast payload). A channel that understands such
 * payloads implements {@link NotificationChannel.deliver}; one that does not is
 * handed the payload through `send`, which must then be a
 * {@link NotificationMessage}. Every built-in channel implements both.
 *
 * Delivery stays a synchronous primitive here: there is no retry policy. An
 * application that needs retries or out-of-process delivery should enqueue
 * the work with the jobs plugin and send from the job handler (`@jsails/mail`'s
 * `Mail.queue` does this for mail).
 */

import type { MailAddress } from '@jsails/mail';
import { JsailsError } from 'jsails/errors';

/** A message to deliver. Every field is required. */
export interface NotificationMessage {
  /** Single recipient address (channel-specific format, e.g. an email address). */
  readonly to: string;
  /** Subject line. */
  readonly subject: string;
  /** Plain-text body. */
  readonly text: string;
}

/**
 * Whoever a defined notification is sent to. `id` keys the database channel's
 * rows and the default broadcast channel; `email` is the mail channel's
 * default recipient; `broadcastChannel` overrides the broadcast channel name.
 */
export interface Notifiable {
  /** A stable identifier: a non-empty string or a safe integer. */
  readonly id: string | number;
  /** The mail channel's recipient when the mail payload names none. */
  readonly email?: MailAddress;
  /** The broadcast channel to publish to, instead of the channel's default. */
  readonly broadcastChannel?: string;
}

/** One defined notification on its way through one channel. */
export interface NotificationDelivery {
  /** The notification's name. */
  readonly notification: string;
  /** The recipient. */
  readonly notifiable: Notifiable;
  /** What the notification built for this channel. */
  readonly payload: unknown;
}

/** The delivery surface every channel exposes. */
export interface NotificationChannel {
  /** Deliver one message. Rejects on failure; the error is never surfaced verbatim. */
  send(message: NotificationMessage): Promise<void>;
  /**
   * Deliver one defined notification. Optional: without it, the payload is
   * passed to {@link send} and must be a {@link NotificationMessage}.
   */
  deliver?(delivery: NotificationDelivery): Promise<void>;
}

/** Options for {@link NotificationsService.notify}. */
export interface NotifyOptions {
  /**
   * The channels to use, in order. Omit to use every configured channel
   * except the opt-in ones (the plugin's `database` and `broadcast`).
   */
  readonly channels?: readonly string[];
}

/** Options for {@link NotificationsService.send}. */
export interface SendNotificationOptions {
  /**
   * The channels to use. Omit to use the notification's own selection (its
   * `via`, else every channel it builds a payload for).
   */
  readonly channels?: readonly string[];
}

/** A defined notification, as `defineNotification` returns it. */
export interface NotificationDefinition<P> {
  /** The notification's name, stored as the database row's `type`. */
  readonly name: string;
  /** The channels this notification builds a payload for, in definition order. */
  readonly channelNames: readonly string[];
  /** The channels to use for `notifiable`; every built channel when not customized. */
  via(notifiable: Notifiable, props: P): readonly string[];
  /** Build the payload for `channel`. Throws for a channel it does not build. */
  build(channel: string, props: P, notifiable: Notifiable): unknown;
}

/** The service the notifications plugin provides: send through named channels. */
export interface NotificationsService {
  /**
   * Deliver one message through the selected channels (all configured channels
   * when `options.channels` is omitted) in order, waiting for every attempt.
   * Any failures are aggregated into a {@link NotificationError}
   * (`delivery_failed`); an unknown channel name rejects (`unknown_channel`)
   * and so does a selection with no channel in it (`no_channel`), both
   * before any channel is attempted, so `notify` never resolves without
   * having delivered through at least one channel.
   */
  notify(message: NotificationMessage, options?: NotifyOptions): Promise<void>;
  /**
   * Send a defined notification to one or more notifiables. Every selected
   * channel must be configured (`unknown_channel`) and built by the
   * notification (`unsupported_channel`); both are checked for every
   * notifiable before any delivery starts. Failures are aggregated like
   * {@link notify}.
   */
  send<P>(
    notifiables: Notifiable | readonly Notifiable[],
    notification: NotificationDefinition<P>,
    props: P,
    options?: SendNotificationOptions,
  ): Promise<void>;
}

/** Stable failure codes carried by {@link NotificationError}. */
export type NotificationErrorCode =
  | 'delivery_failed'
  | 'unknown_channel'
  | 'no_channel'
  | 'unsupported_channel'
  | 'invalid_notifiable'
  | 'invalid_payload'
  | 'missing_address'
  | 'missing_broadcast'
  | 'too_large'
  | 'not_found'
  | 'not_initialized'
  | 'missing_table';

/**
 * Raised by `notify`, `send`, and the stores. The message is fixed and
 * value-free: it never carries a requested channel name, an underlying
 * transport error, an address, a subject, a credential, or a payload. For
 * `delivery_failed`, {@link channels} lists the configured names of the
 * channels that failed, in configuration order; otherwise it is empty.
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

/** The largest number of notifiables one `send` accepts. */
export const MAX_NOTIFIABLES = 1000;

/** The widest notifiable key; matches the `jsails_notifications.notifiable` column. */
export const NOTIFIABLE_KEY_LENGTH = 190;

/**
 * Validate a notifiable and return its key (`String(id)`). The key is at most
 * 190 characters so it fits the database channel's column.
 */
export function notifiableKey(notifiable: Notifiable): string {
  const raw: unknown = notifiable;
  if (raw === null || typeof raw !== 'object') {
    throw new NotificationError('invalid_notifiable', 'a notifiable must be an object with an id');
  }
  const { id } = notifiable;
  if (typeof id === 'number' ? Number.isSafeInteger(id) : typeof id === 'string' && id !== '') {
    const key = String(id);
    if (key.length <= NOTIFIABLE_KEY_LENGTH) {
      return key;
    }
  }
  throw new NotificationError(
    'invalid_notifiable',
    `a notifiable id must be a safe integer or a string of 1-${NOTIFIABLE_KEY_LENGTH} characters`,
  );
}
