/**
 * The delivery core: a {@link NotificationsService} that fans one message (or
 * one defined notification per notifiable) out to a map of named channels.
 *
 * The dispatcher selects channels by name, sends through every selected
 * channel (each attempt normalized into a promise so a synchronous throw is
 * still aggregated), waits for all of them, and collapses failures into one
 * value-free {@link NotificationError} that lists only the failed channel
 * names. Each attempt is bounded by a timeout (30 s by default): a channel
 * whose backend hangs counts as failed instead of holding the caller — often
 * a request handler — for as long as the backend's own timeouts allow. The
 * slow attempt is not cancelled (the channel contract has no cancellation),
 * only no longer awaited. The plugin wires one up from its options; an
 * application can also construct one directly around its own channel map.
 *
 * Attempts run through a per-channel worker pool (10 at a time by default),
 * and an attempt's timer starts only when a worker picks it up. A batch to
 * 1000 notifiables therefore never opens 1000 SMTP sends or database writes at
 * once, and an attempt still waiting for a free worker (or a free pooled
 * connection behind it) is never reported as timed out — so a caller that
 * retries on `delivery_failed` does not resend a message that is still going
 * out.
 *
 * `send` resolves, for every notifiable, the channels to use and checks each
 * is configured and built by the notification before any delivery starts, so
 * a typo in a channel name never half-delivers a batch. A name selected twice
 * is delivered once. Each (notifiable, channel) pair is one attempt; the
 * payload is built inside the attempt, so a throwing builder fails only its
 * own channel.
 *
 * `notify` without a `channels` option uses every configured channel except
 * the opt-in ones (the plugin's `database` and `broadcast`), which a plain
 * `{ to, subject, text }` message reaches only when named explicitly.
 */

import {
  MAX_NOTIFIABLES,
  NotificationError,
  notifiableKey,
  type Notifiable,
  type NotificationChannel,
  type NotificationDefinition,
  type NotificationMessage,
  type NotificationsService,
  type NotifyOptions,
  type SendNotificationOptions,
} from './contract.js';

/** Default per-channel delivery timeout, in milliseconds. */
export const DEFAULT_CHANNEL_TIMEOUT_MS = 30_000;

/** Default number of attempts one channel runs at the same time. */
export const DEFAULT_CHANNEL_CONCURRENCY = 10;

/** Options for {@link NotificationDispatcher}. */
export interface NotificationDispatcherOptions {
  /** Milliseconds one channel may take before it counts as failed. Defaults to 30 000. */
  readonly channelTimeoutMs?: number;
  /** Attempts one channel runs at the same time. Defaults to 10. */
  readonly concurrency?: number;
  /**
   * Channels `notify` uses only when its `channels` option names them. `send`
   * is unaffected: a defined notification selects channels through `via`.
   */
  readonly optInChannels?: readonly string[];
}

/** A channel paired with its configuration name. */
interface NamedChannel {
  readonly name: string;
  readonly channel: NotificationChannel;
}

/** One delivery through one channel. */
interface Attempt {
  readonly entry: NamedChannel;
  run(): Promise<void>;
}

export class NotificationDispatcher implements NotificationsService {
  readonly #named: readonly NamedChannel[];
  readonly #defaults: readonly NamedChannel[];
  readonly #timeoutMs: number;
  readonly #concurrency: number;

  constructor(
    channels: Readonly<Record<string, NotificationChannel>>,
    options: NotificationDispatcherOptions = {},
  ) {
    const timeoutMs = options.channelTimeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('channelTimeoutMs must be a positive integer');
    }
    const concurrency = options.concurrency ?? DEFAULT_CHANNEL_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new TypeError('concurrency must be a positive integer');
    }
    const optIn: unknown = options.optInChannels ?? [];
    if (!Array.isArray(optIn) || !optIn.every((name) => typeof name === 'string')) {
      throw new TypeError('optInChannels must be a list of channel names');
    }
    const optInNames = new Set<unknown>(optIn);
    this.#named = Object.entries(channels).map(([name, channel]) => ({ name, channel }));
    this.#defaults = this.#named.filter(({ name }) => !optInNames.has(name));
    this.#timeoutMs = timeoutMs;
    this.#concurrency = concurrency;
  }

  async notify(message: NotificationMessage, options?: NotifyOptions): Promise<void> {
    const selected =
      options?.channels === undefined ? this.#defaults : this.#selectChannels(options.channels);
    await this.#attempt(
      selected.map((entry) => ({ entry, run: async () => entry.channel.send(message) })),
    );
  }

  async send<P>(
    notifiables: Notifiable | readonly Notifiable[],
    notification: NotificationDefinition<P>,
    props: P,
    options?: SendNotificationOptions,
  ): Promise<void> {
    const list: readonly Notifiable[] = Array.isArray(notifiables)
      ? notifiables
      : [notifiables as Notifiable];
    if (list.length > MAX_NOTIFIABLES) {
      throw new NotificationError(
        'too_large',
        `a notification may be sent to at most ${MAX_NOTIFIABLES} notifiables at once`,
      );
    }
    const built = new Set(notification.channelNames);
    const plan = list.map((notifiable) => {
      notifiableKey(notifiable);
      const names = options?.channels ?? notification.via(notifiable, props);
      for (const name of names) {
        if (!built.has(name)) {
          throw new NotificationError(
            'unsupported_channel',
            'the notification builds no payload for a selected channel',
          );
        }
      }
      return { notifiable, channels: this.#selectChannels(names) };
    });

    await this.#attempt(
      plan.flatMap(({ notifiable, channels }) =>
        channels.map((entry) => ({
          entry,
          run: async () => {
            const payload = notification.build(entry.name, props, notifiable);
            const { channel } = entry;
            if (channel.deliver !== undefined) {
              await channel.deliver({ notification: notification.name, notifiable, payload });
            } else {
              await channel.send(asMessage(payload));
            }
          },
        })),
      ),
    );
  }

  /** Run every attempt, then report the channels that failed in configuration order. */
  async #attempt(attempts: readonly Attempt[]): Promise<void> {
    if (attempts.length === 0) {
      return;
    }
    const byChannel = new Map<string, Attempt[]>();
    for (const attempt of attempts) {
      const queue = byChannel.get(attempt.entry.name);
      if (queue === undefined) {
        byChannel.set(attempt.entry.name, [attempt]);
      } else {
        queue.push(attempt);
      }
    }
    const failedNames = new Set<string>();
    await Promise.all(
      [...byChannel].map(async ([name, queue]) => {
        if (!(await this.#drain(queue))) {
          failedNames.add(name);
        }
      }),
    );
    if (failedNames.size > 0) {
      throw new NotificationError('delivery_failed', 'notification delivery failed', {
        channels: this.#named.map(({ name }) => name).filter((name) => failedNames.has(name)),
      });
    }
  }

  /**
   * Run one channel's attempts through at most `concurrency` workers; resolve
   * whether every attempt succeeded. Each `run` is async, so a synchronous
   * throw from a misbehaving channel is caught like any rejection.
   */
  async #drain(queue: readonly Attempt[]): Promise<boolean> {
    let next = 0;
    let ok = true;
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        const attempt = queue[next];
        next += 1;
        if (attempt === undefined) {
          return;
        }
        try {
          await this.#bounded(() => attempt.run());
        } catch {
          // The failure is reported by channel name only, never its value.
          ok = false;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, queue.length) }, () => worker()),
    );
    return ok;
  }

  /** Run one attempt, rejecting once the timeout passes; the timer starts now. */
  async #bounded(attempt: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new NotificationError('delivery_failed', 'notification channel timed out'));
      }, this.#timeoutMs);
    });
    try {
      await Promise.race([attempt(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve the requested channel subset, once per name, rejecting an unknown name first. */
  #selectChannels(names: readonly string[]): readonly NamedChannel[] {
    const byName = new Map(this.#named.map((entry) => [entry.name, entry]));
    return [...new Set(names)].map((name) => {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new NotificationError('unknown_channel', 'notify requested an unknown channel');
      }
      return entry;
    });
  }
}

/**
 * A custom channel without `deliver` receives the payload through `send`, so
 * the payload must be a plain message.
 */
function asMessage(payload: unknown): NotificationMessage {
  const candidate = payload as Partial<Record<keyof NotificationMessage, unknown>> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.to !== 'string' ||
    typeof candidate.subject !== 'string' ||
    typeof candidate.text !== 'string'
  ) {
    throw new NotificationError(
      'invalid_payload',
      'a channel without deliver needs a { to, subject, text } payload',
    );
  }
  return { to: candidate.to, subject: candidate.subject, text: candidate.text };
}
