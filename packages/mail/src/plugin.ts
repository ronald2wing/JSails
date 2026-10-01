/**
 * The `mail` plugin: exposes an application {@link MailService} under a typed
 * service token, owned and torn down by the plugin.
 *
 * `mailPlugin({ transport? | smtp? | allowMemory?, previews? })` defines a
 * {@link JsailsPlugin} named `mail` whose `setup` provides the mailer under
 * {@link mailToken}. The transport is resolved lazily on the first `send` with
 * this precedence:
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
 *
 * The service's `queue` dispatches the `mail.send` job through the jobs
 * service registered in the same application, resolved at call time so the
 * jobs plugin may be declared in any order. In development (`NODE_ENV` exactly
 * `development`, read at `setup`) the plugin also mounts the mail preview
 * routes under `/_jsails/mail`; elsewhere it registers no route at all.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { currentAppScope, facade, FacadeError } from 'jsails/facades';
import { createLazyResource, firstConfigured, isRecord } from 'jsails/plugin-sdk';
import type { MailDefinition } from './define-mail.js';
import { MailError, type MailTransport, type ValidatedMail } from './mailer.js';
import { mailPreviewHook } from './preview.js';
import { queueMailThrough } from './queue.js';
import { mailToken, type MailService } from './service.js';
import {
  InMemoryMailTransport,
  SmtpMailTransport,
  type MemoryMailTransport,
  type SmtpTransportOptions,
} from './transports.js';

const mailFacade = facade(mailToken);

/**
 * Ambient mailer (`Mail.send(...)`, `Mail.queue(...)`). `send` resolves
 * {@link mailToken} through the live application scope; `queue` dispatches
 * through that scope's jobs service. Outside a scope both fail with
 * `FacadeError('no_app_scope')`, so code that may run without an application
 * should take a `Mailer` explicitly instead.
 */
export const Mail: MailService = Object.freeze({
  send: (message) => mailFacade.send(message),
  async queue(message, options) {
    const scope = currentAppScope();
    if (scope === undefined) {
      throw new FacadeError(
        'no_app_scope',
        mailToken.name,
        'Mail.queue was used outside an application scope; call it inside a request, setup, or job',
      );
    }
    await queueMailThrough(scope.services, message, options);
  },
} satisfies MailService);

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
  /**
   * Templates the development preview lists and renders with their `preview`
   * props. Ignored outside development.
   */
  readonly previews?: readonly MailDefinition<unknown>[];
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
  const previews = validatePreviews(options.previews);

  return definePlugin({
    name: 'mail',
    setup({ services, configureHttp }) {
      // The transport once created, so the preview can read its outbox
      // without forcing a resolution. An explicit transport is known now:
      // resolving it needs no I/O and the plugin never owns it.
      let current: MailTransport | undefined = options.transport;
      // A failed resolution is not memoized, so a later send can retry.
      const resolved = createLazyResource<ResolvedTransport>({
        create: () => {
          const result = resolveTransport(options);
          current = result.transport;
          return result;
        },
        close: ({ transport, owned }) => (owned ? transport.close() : undefined),
      });

      const service: MailService = {
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
        async queue(message, queueOptions) {
          await queueMailThrough(services, message, queueOptions);
        },
      };
      services.provide(mailToken, service);

      if (process.env.NODE_ENV === 'development') {
        configureHttp(
          mailPreviewHook({
            mails: previews,
            outbox: () => (current === undefined ? undefined : outboxOf(current)),
          }),
        );
      }

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

/** The captured messages of a transport that keeps them, else `undefined`. */
function outboxOf(transport: MailTransport): readonly ValidatedMail[] | undefined {
  return isMemoryTransport(transport) ? transport.messages() : undefined;
}

function isMemoryTransport(transport: MailTransport): transport is MemoryMailTransport {
  return typeof (transport as Partial<MemoryMailTransport>).messages === 'function';
}

/** Validate the preview list: defined templates with unique names. */
function validatePreviews(value: unknown): readonly MailDefinition<unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('previews must be an array of mail definitions');
  }
  const seen = new Set<string>();
  for (const entry of value as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.render !== 'function') {
      throw new TypeError('previews must contain mail definitions from defineMail');
    }
    if (seen.has(entry.name)) {
      throw new TypeError(`previews lists the mail "${entry.name}" twice`);
    }
    seen.add(entry.name);
  }
  return Object.freeze([...(value as readonly MailDefinition<unknown>[])]);
}

/** Whether `value` has the {@link MailTransport} surface (send + close). */
function isTransport(value: unknown): value is MailTransport {
  return isRecord(value) && typeof value.send === 'function' && typeof value.close === 'function';
}
