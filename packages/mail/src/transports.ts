/**
 * Mail transports: three ways to deliver a validated {@link MailMessage}.
 *
 * - {@link InMemoryMailTransport} captures messages in-process — the zero-cost
 *   default for tests, demos, and development. It is explicit, never selected
 *   implicitly by the plugin.
 * - {@link SmtpMailTransport} delivers over SMTP through nodemailer. It is
 *   fully lazy: importing this module loads no nodemailer, and constructing a
 *   transport neither connects nor resolves a URL — the nodemailer module and
 *   the connection are created on the first `send` only. Errors are sanitized
 *   into a value-free {@link MailError} (a connection URL may embed credentials
 *   and is never echoed), and `close` is idempotent. Connections are pooled
 *   and every phase has a timeout by default, so a slow or unreachable server
 *   fails a send in seconds rather than holding a request for minutes, and a
 *   burst of messages reuses a few connections instead of opening one each.
 * - {@link CallbackMailTransport} forwards each validated message to an
 *   injected callback — a seam for tests, logging, and custom delivery.
 *
 * Every transport validates its input through the shared
 * {@link validateMessage}, so a bad address or a header-injection attempt fails
 * the same way regardless of the backend. The SMTP transport hands nodemailer
 * structured `{ name, address }` objects rather than the formatted header
 * strings: nodemailer then encodes each display name itself and never parses
 * text back into a recipient list, so a display name cannot add a recipient
 * whatever its content.
 */

import {
  createLazyResource,
  isRecord,
  sanitizeBackendError,
  type LazyResource,
} from 'jsails/plugin-sdk';
import {
  MailError,
  parseMailAddress,
  validateMessage,
  validateMessageAddresses,
  type MailAddress,
  type MailRecipient,
  type MailMessage,
  type MailTransport,
  type ValidatedMail,
} from './mailer.js';

/** A transport that captures every validated message in memory. */
export interface MemoryMailTransport extends MailTransport {
  /** The messages sent so far, in order (a copy; the store is not mutable). */
  messages(): readonly ValidatedMail[];
}

/** The one failure every transport shares: a send after `close`. */
function closedError(): MailError {
  return new MailError('closed', 'the mail transport is closed');
}

/**
 * An in-memory transport. Messages are validated then captured; nothing leaves
 * the process. `close` drops the captured messages and is idempotent. This is
 * the explicit test/dev default, never chosen implicitly by the plugin.
 */
export class InMemoryMailTransport implements MemoryMailTransport {
  #captured: ValidatedMail[] = [];
  #closed = false;

  async send(message: MailMessage): Promise<void> {
    if (this.#closed) {
      throw closedError();
    }
    this.#captured.push(validateMessage(message));
  }

  messages(): readonly ValidatedMail[] {
    return [...this.#captured];
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#captured.length = 0;
  }
}

/** The sink a callback transport forwards each validated message to. */
export type MailCallback = (message: ValidatedMail) => void | Promise<void>;

/**
 * A transport that forwards every validated message to an injected callback.
 * Useful for tests and for routing mail to a custom sink. The callback is
 * trusted application code and owns any persistence or delivery it performs.
 */
export class CallbackMailTransport implements MailTransport {
  #fn: MailCallback;
  #closed = false;

  constructor(fn: MailCallback) {
    if (typeof fn !== 'function') {
      throw new TypeError('CallbackMailTransport requires a callback function');
    }
    this.#fn = fn;
  }

  async send(message: MailMessage): Promise<void> {
    if (this.#closed) {
      throw closedError();
    }
    await this.#fn(validateMessage(message));
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/** Options for {@link SmtpMailTransport}. At least one of `url` or `host`. */
export interface SmtpTransportOptions {
  /** A full connection URL (e.g. `smtps://user:pass@host:465`); wins over `host`. */
  readonly url?: string;
  /** SMTP host. */
  readonly host?: string;
  /** SMTP port. Defaults to the transport's own default for `secure`. */
  readonly port?: number;
  /** SMTP username. */
  readonly user?: string;
  /** SMTP password. */
  readonly pass?: string;
  /** Default sender used when a message omits `from`; bare or `{ name, address }`. */
  readonly from?: MailAddress;
  /** `true` for implicit TLS (port 465), `false` for STARTTLS. */
  readonly secure?: boolean;
  /** Reuse connections across sends. Defaults to `true`. */
  readonly pool?: boolean;
  /** Most simultaneous pooled connections. Defaults to 5. */
  readonly maxConnections?: number;
  /** Milliseconds to wait for the TCP connection. Defaults to 10 000. */
  readonly connectionTimeoutMs?: number;
  /** Milliseconds to wait for the server greeting after connecting. Defaults to 10 000. */
  readonly greetingTimeoutMs?: number;
  /** Milliseconds of socket inactivity before giving up. Defaults to 30 000. */
  readonly socketTimeoutMs?: number;
}

/** The pooling and timeout defaults; see {@link SmtpTransportOptions}. */
export const SMTP_DEFAULTS = Object.freeze({
  pool: true,
  maxConnections: 5,
  connectionTimeoutMs: 10_000,
  greetingTimeoutMs: 10_000,
  socketTimeoutMs: 30_000,
});

/** Pooling and timeouts in nodemailer's option names. */
interface SmtpTuning {
  readonly pool: boolean;
  readonly maxConnections: number;
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
}

/** The connection descriptor handed to the nodemailer (or injected) factory. */
export interface SmtpConnectionConfig {
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly auth?: { readonly user?: string; readonly pass?: string };
  readonly pool?: boolean;
  readonly maxConnections?: number;
  readonly connectionTimeout?: number;
  readonly greetingTimeout?: number;
  readonly socketTimeout?: number;
}

/** The underlying transporter surface the SMTP transport depends on. */
export interface SmtpTransporter {
  sendMail(mail: SmtpMailOptions): Promise<unknown>;
  close(): void;
}

/**
 * An address as nodemailer takes it: a structured object it encodes itself,
 * never a string it would parse.
 */
export interface SmtpAddress {
  readonly name: string;
  readonly address: string;
}

/** The send options the SMTP transport forwards to the underlying transporter. */
export interface SmtpMailOptions {
  readonly from?: SmtpAddress;
  // Address lists are mutable to match nodemailer's own option type.
  readonly to: SmtpAddress[];
  readonly cc?: SmtpAddress[];
  readonly bcc?: SmtpAddress[];
  readonly replyTo?: SmtpAddress[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  // Mutable to match nodemailer's own option type, which the transporter takes.
  readonly attachments?: {
    readonly filename: string;
    readonly content: Buffer;
    readonly contentType?: string;
  }[];
}

/**
 * Test seam: replace the underlying transporter factory. Defaults to loading
 * nodemailer lazily and calling its `createTransport`. Exported so a test can
 * exercise laziness, sanitized errors, and close idempotency without a live
 * SMTP server.
 */
export interface SmtpTransportDependencies {
  readonly createTransport: (
    config: SmtpConnectionConfig | string,
  ) => SmtpTransporter | Promise<SmtpTransporter>;
}

/**
 * An SMTP transport over nodemailer.
 *
 * Construction is fully lazy: no nodemailer is loaded and no connection is
 * opened until the first `send`. The connection descriptor is either the
 * supplied `url` (a string) or an object built from
 * `host`/`port`/`secure`/`user`/`pass`; both carry the pooling and timeout
 * settings. For a URL they travel as query parameters, which nodemailer reads
 * as transport options, and a parameter already in the URL wins over the
 * option and the default. Supplying neither throws a value-free
 * {@link MailError} at construction. A failed send is surfaced as a sanitized,
 * value-free {@link MailError}; `close` closes the underlying transporter
 * exactly once and is a no-op when nothing was ever created.
 */
export class SmtpMailTransport implements MailTransport {
  readonly #from: MailRecipient | undefined;
  readonly #transporter: LazyResource<SmtpTransporter>;

  constructor(options: SmtpTransportOptions, dependencies?: SmtpTransportDependencies) {
    // Guard an `unknown` view of the argument: narrowing the all-optional
    // options type itself would drop every field type.
    const raw: unknown = options;
    if (!isRecord(raw)) {
      throw new TypeError('SmtpMailTransport requires an options object');
    }
    this.#from = options.from === undefined ? undefined : parseMailAddress(options.from, 'from');
    const tuning = resolveTuning(options);
    if (options.url === undefined && options.host === undefined) {
      throw new MailError(
        'missing_smtp_connection',
        'no SMTP configuration: provide a url or a host',
      );
    }

    const url = options.url === undefined ? undefined : assertSmtpUrl(options.url);
    const connection: SmtpConnectionConfig | string =
      url !== undefined
        ? withTuning(url, tuning)
        : {
            host: options.host,
            port: options.port,
            secure: options.secure,
            auth:
              options.user !== undefined || options.pass !== undefined
                ? { user: options.user, pass: options.pass }
                : undefined,
            ...tuning,
          };

    this.#transporter = createLazyResource({
      create: () => createTransporter(connection, dependencies),
      close(transporter) {
        try {
          transporter.close();
        } catch {
          // Teardown errors are ignored: shutdown must complete.
        }
      },
    });
  }

  async send(message: MailMessage): Promise<void> {
    const validated = validateMessage(message);
    const addresses = validateMessageAddresses(message);
    if (this.#transporter.closed) {
      throw closedError();
    }
    const transporter = await this.#transporter.get();
    const from = addresses.from ?? this.#from;
    try {
      await transporter.sendMail({
        ...(from === undefined ? {} : { from: smtpAddress(from) }),
        to: addresses.to.map(smtpAddress),
        ...(addresses.cc.length === 0 ? {} : { cc: addresses.cc.map(smtpAddress) }),
        ...(addresses.bcc.length === 0 ? {} : { bcc: addresses.bcc.map(smtpAddress) }),
        ...(addresses.replyTo.length === 0 ? {} : { replyTo: addresses.replyTo.map(smtpAddress) }),
        subject: validated.subject,
        text: validated.text,
        html: validated.html,
        ...(validated.attachments === undefined
          ? {}
          : {
              attachments: validated.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: Buffer.from(
                  attachment.content.buffer,
                  attachment.content.byteOffset,
                  attachment.content.byteLength,
                ),
                ...(attachment.contentType === undefined
                  ? {}
                  : { contentType: attachment.contentType }),
              })),
            }),
      });
    } catch (error) {
      throw sanitizeMailError(error);
    }
  }

  async close(): Promise<void> {
    await this.#transporter.close();
  }
}

/** A fresh copy, so nodemailer never holds a reference into the caller's message. */
function smtpAddress(recipient: MailRecipient): SmtpAddress {
  return { name: recipient.name, address: recipient.address };
}

/** Validate the pooling and timeout options, filling the defaults. */
function resolveTuning(options: SmtpTransportOptions): SmtpTuning {
  const positive = (value: unknown, name: string, fallback: number): number => {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`SmtpMailTransport ${name} must be a positive integer`);
    }
    return value;
  };
  if (options.pool !== undefined && typeof options.pool !== 'boolean') {
    throw new TypeError('SmtpMailTransport pool must be a boolean');
  }
  return {
    pool: options.pool ?? SMTP_DEFAULTS.pool,
    maxConnections: positive(
      options.maxConnections,
      'maxConnections',
      SMTP_DEFAULTS.maxConnections,
    ),
    connectionTimeout: positive(
      options.connectionTimeoutMs,
      'connectionTimeoutMs',
      SMTP_DEFAULTS.connectionTimeoutMs,
    ),
    greetingTimeout: positive(
      options.greetingTimeoutMs,
      'greetingTimeoutMs',
      SMTP_DEFAULTS.greetingTimeoutMs,
    ),
    socketTimeout: positive(
      options.socketTimeoutMs,
      'socketTimeoutMs',
      SMTP_DEFAULTS.socketTimeoutMs,
    ),
  };
}

/** Carry the tuning as URL query parameters, keeping any the URL already sets. */
function withTuning(url: string, tuning: SmtpTuning): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(tuning)) {
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

/** Resolve the transporter factory and construct the underlying transporter. */
async function createTransporter(
  connection: SmtpConnectionConfig | string,
  dependencies: SmtpTransportDependencies | undefined,
): Promise<SmtpTransporter> {
  try {
    const createTransport =
      dependencies?.createTransport ?? (await loadNodemailerCreateTransport());
    return await createTransport(connection);
  } catch (error) {
    throw sanitizeMailError(error);
  }
}

/** Load nodemailer's `createTransport` lazily, only when no seam is present. */
async function loadNodemailerCreateTransport(): Promise<
  (config: SmtpConnectionConfig | string) => SmtpTransporter
> {
  const nodemailer = await import('nodemailer');
  return (config) => nodemailer.createTransport(config);
}

/** Reduce a backend error to a payload-free {@link MailError}. */
function sanitizeMailError(error: unknown): MailError {
  return sanitizeBackendError(
    error,
    'mail transport',
    (message) => new MailError('transport_failed', message),
  ) as MailError;
}

/**
 * Validate a connection URL as an explicit `smtp://`/`smtps://` URL, returning
 * it unchanged. Rejects anything else with a value-free {@link MailError}; the
 * value (which may embed credentials) is never echoed.
 */
function assertSmtpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MailError(
      'invalid_smtp_url',
      'the SMTP connection URL must be a non-empty smtp:// or smtps:// URL',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MailError(
      'invalid_smtp_url',
      'the SMTP connection URL must be a valid smtp:// or smtps:// URL',
    );
  }
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    throw new MailError(
      'invalid_smtp_url',
      'the SMTP connection URL must use the smtp:// or smtps:// scheme',
    );
  }
  return value;
}
