/**
 * The `mail` plugin: exposes an application {@link Mailer} under a typed
 * service token, owned and torn down by the plugin.
 *
 * `mailPlugin({ transport? | smtp? | allowMemory? })` defines a {@link JsailsPlugin}
 * named `mail` whose `setup` provides the mailer under {@link mailToken}. The
 * transport is resolved lazily on the first `send` with this precedence:
 *
 * 1. an explicit `transport` — used verbatim (identity preserved) and never
 *    closed by the plugin;
 * 2. an explicit `smtp` configuration (`url`, or `host`/`port`/`user`/`pass`);
 * 3. an SMTP URL from the environment (`MAIL_URL`, then `SMTP_URL`);
 * 4. an in-memory transport, only when `allowMemory: true`;
 * 5. otherwise a value-free {@link MailError} — production fails closed rather
 *    than silently dropping mail.
 *
 * Construction is lazy: nothing is imported, connected, or validated against
 * the environment at import, plugin construction, or `setup`. The transport
 * (and, for SMTP, nodemailer and its connection) is created on the first `send`
 * and reused thereafter. The cleanup closes only a plugin-owned transport, and
 * is a no-op when an explicit transport was provided or none was ever created.
 */

import {
  createServiceToken,
  definePlugin,
  type JsailsPlugin,
  type ServiceToken,
} from 'jsails/extensions';
import { facade } from 'jsails/facades';
import { createLazyResource, firstConfigured, isRecord } from 'jsails/plugin-sdk';
import { MailError, type Mailer, type MailTransport } from './mailer.js';
import {
  InMemoryMailTransport,
  SmtpMailTransport,
  type SmtpTransportOptions,
} from './transports.js';

/**
 * Opaque token for the application {@link Mailer}. Defined once here and shared
 * by the provider (`mailPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const mailToken: ServiceToken<Mailer> = createServiceToken<Mailer>('mail');

/**
 * Ambient mailer facade (`Mail.send({ to, subject, text })`) resolving
 * {@link mailToken} through the live application scope. Outside a scope it
 * fails with `FacadeError('no_app_scope')`, so code that may run without the
 * mail plugin should take a `Mailer` explicitly instead.
 */
export const Mail: Mailer = facade(mailToken);

/** Options accepted by {@link mailPlugin}. */
export interface MailPluginOptions {
  /** Caller-provided transport; used verbatim and never closed by the plugin. */
  readonly transport?: MailTransport;
  /** Explicit SMTP configuration (`url`, or `host`/`port`/`user`/`pass`). */
  readonly smtp?: SmtpTransportOptions;
  /**
   * When `true` and no other transport is configured, fall back to an in-memory
   * transport (tests/dev). Defaults to `false` so production fails closed with
   * a value-free error instead of silently capturing mail.
   */
  readonly allowMemory?: boolean;
}

/** A resolved transport plus whether the plugin owns (and must close) it. */
interface ResolvedTransport {
  readonly transport: MailTransport;
  readonly owned: boolean;
}

/**
 * Define the `mail` plugin. The returned plugin is inert: nothing is imported,
 * connected, or environment-resolved until the first `send` through the
 * service.
 */
export function mailPlugin(options: MailPluginOptions = {}): JsailsPlugin {
  const raw: unknown = options;
  if (!isRecord(raw)) {
    throw new TypeError('mailPlugin requires an options object');
  }
  if (options.allowMemory !== undefined && typeof options.allowMemory !== 'boolean') {
    throw new TypeError('allowMemory must be a boolean');
  }
  if (options.transport !== undefined && !isTransport(options.transport)) {
    throw new TypeError('transport must be a mail transport');
  }
  if (options.smtp !== undefined && !isRecord(options.smtp)) {
    throw new TypeError('smtp must be an SMTP transport options object');
  }

  return definePlugin({
    name: 'mail',
    setup({ services }) {
      // A failed resolution is not memoized, so a later send can retry.
      const resolved = createLazyResource<ResolvedTransport>({
        create: () => resolveTransport(options),
        close: ({ transport, owned }) => (owned ? transport.close() : undefined),
      });

      services.provide(mailToken, {
        // `async` so a resolution failure (e.g. the fail-closed "no transport
        // configured" error) surfaces as a rejection, never a synchronous
        // throw, keeping the `Promise<void>` contract of `send`.
        async send(message) {
          if (resolved.closed) {
            throw new MailError('closed', 'the mail transport is closed');
          }
          const { transport } = await resolved.get();
          return transport.send(message);
        },
      });

      return () => resolved.close();
    },
  });
}

/** Resolve the transport per the documented precedence, reading env lazily. */
function resolveTransport(options: MailPluginOptions): ResolvedTransport {
  if (options.transport !== undefined) {
    return { transport: options.transport, owned: false };
  }
  if (options.smtp !== undefined) {
    return { transport: new SmtpMailTransport(options.smtp), owned: true };
  }
  const url = firstConfigured(process.env.MAIL_URL, process.env.SMTP_URL);
  if (url !== undefined) {
    return { transport: new SmtpMailTransport({ url }), owned: true };
  }
  if (options.allowMemory === true) {
    return { transport: new InMemoryMailTransport(), owned: true };
  }
  throw new MailError(
    'missing_transport',
    'no mail transport configured: provide a transport or smtp option, or set MAIL_URL/SMTP_URL',
  );
}

/** Whether `value` has the {@link MailTransport} surface (send + close). */
function isTransport(value: unknown): value is MailTransport {
  return isRecord(value) && typeof value.send === 'function' && typeof value.close === 'function';
}
