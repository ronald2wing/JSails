/**
 * Defined notifications: `defineNotification(name, { channels, via? })`.
 *
 * A notification names itself and maps each channel it supports to a builder
 * of that channel's payload. The built-in channels expect:
 *
 * - `mail` — a mail message without `to` (or with one); the mail channel
 *   addresses it to the notifiable's `email` when `to` is absent. A
 *   `defineMail` template's `render(props)` output fits as is.
 * - `database` — a JSON object stored as the row's `data`.
 * - `broadcast` — any JSON value, published as the event's `data`.
 *
 * Any other key builds the payload for a custom channel of that name: a
 * channel with `deliver` receives it verbatim, one without receives it through
 * `send` and it must be a `{ to, subject, text }` message. `via` narrows the
 * channels per notifiable (say, skip mail for users who opted out); by default
 * every channel the notification builds is used.
 */

import type { MailMessage, MailAddressList } from '@jsails/mail';
import type { JsonObject, JsonValue } from 'jsails/plugin-sdk';
import { NotificationError, type Notifiable, type NotificationDefinition } from './contract.js';

/** A notification name: letters, digits, `.`, `_`, `-`, at most 120 characters. */
const NOTIFICATION_NAME = /^[a-z0-9][a-z0-9._-]{0,119}$/i;

/** The mail channel's payload: a mail message whose `to` may be left to the notifiable. */
export type NotificationMailContent = Omit<MailMessage, 'to'> & {
  readonly to?: MailAddressList;
};

/** One channel's payload builder. */
export type NotificationPayloadBuilder<P, T = unknown> = (props: P, notifiable: Notifiable) => T;

/** The per-channel builders, typed for the built-in channels. */
export interface NotificationChannelBuilders<P> {
  readonly mail?: NotificationPayloadBuilder<P, NotificationMailContent>;
  readonly database?: NotificationPayloadBuilder<P, JsonObject>;
  readonly broadcast?: NotificationPayloadBuilder<P, JsonValue>;
  readonly [channel: string]: NotificationPayloadBuilder<P> | undefined;
}

/** What {@link defineNotification} accepts. */
export interface NotificationTemplate<P> {
  /** A payload builder per supported channel. At least one. */
  readonly channels: NotificationChannelBuilders<P>;
  /** The channels to use for one notifiable; must be a subset of `channels`. */
  readonly via?: (notifiable: Notifiable, props: P) => readonly string[];
}

/**
 * Define a notification. Throws `TypeError` for a malformed definition; a
 * `via` that names a channel the notification does not build is refused at
 * send time with `unsupported_channel`.
 */
export function defineNotification<P>(
  name: string,
  template: NotificationTemplate<P>,
): NotificationDefinition<P> {
  if (typeof name !== 'string' || !NOTIFICATION_NAME.test(name)) {
    throw new TypeError(
      'notification name must be 1-120 letters, digits, ".", "_", or "-", starting with a letter or digit',
    );
  }
  if (template === null || typeof template !== 'object') {
    throw new TypeError('defineNotification requires a template object');
  }
  const { channels, via } = template;
  if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) {
    throw new TypeError('notification channels must map channel names to payload builders');
  }
  const builders = new Map<string, NotificationPayloadBuilder<P>>();
  for (const [channel, builder] of Object.entries(channels)) {
    if (builder === undefined) {
      continue;
    }
    if (channel.trim() === '' || typeof builder !== 'function') {
      throw new TypeError('each notification channel must name a payload builder function');
    }
    builders.set(channel, builder);
  }
  if (builders.size === 0) {
    throw new TypeError('a notification must build a payload for at least one channel');
  }
  if (via !== undefined && typeof via !== 'function') {
    throw new TypeError('notification via must be a function');
  }
  const channelNames = Object.freeze([...builders.keys()]);

  return Object.freeze({
    name,
    channelNames,
    via(notifiable: Notifiable, props: P): readonly string[] {
      if (via === undefined) {
        return channelNames;
      }
      const selected: unknown = via(notifiable, props);
      if (!Array.isArray(selected) || selected.some((entry) => typeof entry !== 'string')) {
        throw new NotificationError(
          'unsupported_channel',
          'notification via must return a list of channel names',
        );
      }
      return selected as readonly string[];
    },
    build(channel: string, props: P, notifiable: Notifiable): unknown {
      const builder = builders.get(channel);
      if (builder === undefined) {
        throw new NotificationError(
          'unsupported_channel',
          'the notification builds no payload for a selected channel',
        );
      }
      return builder(props, notifiable);
    },
  });
}
