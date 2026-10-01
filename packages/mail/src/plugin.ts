/**
 * The `mail` plugin: exposes an application {@link MailService} under a typed
 * service token, owned and torn down by the plugin.
 *
 * `mailPlugin({ transport? | smtp? | allowMemory?, previews? })` is a plugin
 * on the `definePlugin` contract of `jsails/kernel` whose `setup` provides the
 * mailer under {@link mailToken}. Its options are data: a transport another
 * plugin provides is named by a token of the {@link mailTransportToken}
 * family, never passed as an instance. The transport is resolved lazily on
 * the first `send` with this precedence:
 *
 * 1. the `transport` service — used verbatim (identity preserved) and never
 *    closed by the plugin, since its provider owns it;
 * 2. an explicit `smtp` configuration (`url`, or `host`/`port`/`user`/`pass`);
 * 3. an SMTP URL from the environment (`MAIL_URL`, then `SMTP_URL`), both
 *    declared secrets read once, before setup, from the runner's environment;
 * 4. an in-memory transport, only when `allowMemory: true`;
 * 5. otherwise a value-free {@link MailError} — production fails closed rather
 *    than silently dropping mail.
 *
 * Nothing is connected at construction or `setup`: the transport (and, for
 * SMTP, nodemailer and its connection) is created on the first `send` and
 * reused thereafter. The cleanup closes only a plugin-owned transport.
 *
 * The service's `queue` dispatches the `mail.send` job through the jobs
 * service, an optional service the plugin declares and reads at call time, so
 * the jobs plugin may be declared in any order. In development mode the plugin
 * also registers the mail preview routes under `/_jsails/mail`; elsewhere it
 * registers no route at all.
 */

import { currentAppScope, facade, FacadeError } from 'jsails/facades';
import { jobsToken } from 'jsails/internal';
import {
  boundObject,
  createServiceToken,
  definePlugin,
  envVar,
  fn,
  tokenRef,
  type PluginFactory,
  type ServiceToken,
  type ServiceTokenFamily,
} from 'jsails/kernel';
import { createLazyResource, firstConfigured } from 'jsails/plugin-sdk';
import { z } from 'jsails/zod';

import type { MailDefinition, RenderedMail } from './define-mail.js';
import { MailError, type MailTransport, type ValidatedMail } from './mailer.js';
import { mailPreviewRoutes, type MailPreview } from './preview.js';
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

/**
 * The family of mail transport services. A plugin that owns a transport (a
 * provider's HTTP API client, say) provides it under this token or a keyed
 * member (`mailTransportToken.named('postmark')`), and the app names that
 * token in `mailPlugin({ transport })`.
 *
 * @public
 */
export const mailTransportToken: ServiceTokenFamily<MailTransport> =
  createServiceToken<MailTransport>('mail.transport');

/** Options accepted by {@link mailPlugin}. */
export interface MailPluginOptions {
  /**
   * The transport service another plugin provides; used verbatim and never
   * closed by this plugin.
   */
  readonly transport?: ServiceToken<MailTransport>;
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
   * props, which must be JSON data. Names are unique. Ignored outside
   * development.
   */
  readonly previews?: readonly MailDefinition<unknown>[];
}

/** The options as setup reads them: each preview reduced to what the preview uses. */
interface ParsedMailOptions extends Omit<MailPluginOptions, 'previews'> {
  readonly previews?: readonly MailPreview[];
}

const mailAddress = z.union([
  z.string(),
  z.object({ name: z.string(), address: z.string() }).strict(),
]);

const smtpOptions = z
  .object({
    url: z.string().optional(),
    host: z.string().optional(),
    port: z.int().optional(),
    user: z.string().optional(),
    pass: z.string().optional(),
    from: mailAddress.optional(),
    secure: z.boolean().optional(),
    requireTLS: z.boolean().optional(),
    pool: z.boolean().optional(),
    maxConnections: z.int().positive().optional(),
    connectionTimeoutMs: z.int().positive().optional(),
    greetingTimeoutMs: z.int().positive().optional(),
    socketTimeoutMs: z.int().positive().optional(),
  })
  .strict();

const preview = boundObject({
  name: z.string(),
  preview: z.json().optional(),
  render: fn<(props: never) => RenderedMail>(),
});

const mailOptions = z
  .object({
    transport: tokenRef(mailTransportToken).optional(),
    smtp: smtpOptions.optional(),
    allowMemory: z.boolean().optional(),
    previews: z
      .array(preview)
      .refine((list) => new Set(list.map((entry) => entry.name)).size === list.length, {
        message: 'must not list a mail name twice',
      })
      .optional(),
  })
  .strict() as unknown as z.ZodType<ParsedMailOptions, MailPluginOptions>;

/** A resolved transport plus whether the plugin owns (and must close) it. */
interface ResolvedTransport {
  readonly transport: MailTransport;
  readonly owned: boolean;
}

/**
 * The `mail` plugin. Setup provides the mailer and, in development, the
 * preview routes; nothing is connected until the first `send`.
 */
export const mailPlugin: PluginFactory<MailPluginOptions | undefined> = definePlugin({
  name: 'mail',
  options: mailOptions.optional(),
  env: {
    MAIL_URL: envVar.secret().optional(),
    SMTP_URL: envVar.secret().optional(),
  },
  requires: (options) => [options?.transport],
  optional: [jobsToken],
  provides: [mailToken],
  setup({ options, env, mode, services, routes }) {
    const transportToken = options?.transport;
    const explicit = transportToken === undefined ? undefined : services.get(transportToken);
    const envUrl = firstConfigured(env.MAIL_URL, env.SMTP_URL);
    // The transport once created, so the preview can read its outbox without
    // forcing a resolution. A provided transport is known now: resolving it
    // needs no I/O and the plugin never owns it.
    let current: MailTransport | undefined = explicit;
    // A failed resolution is not memoized, so a later send can retry.
    const resolved = createLazyResource<ResolvedTransport>({
      create: () => {
        const result = resolveTransport(explicit, options, envUrl);
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

    if (mode === 'development') {
      mailPreviewRoutes(routes, {
        mails: options?.previews ?? [],
        outbox: () => (current === undefined ? undefined : outboxOf(current)),
      });
    }

    return () => resolved.close();
  },
});

/** Resolve the transport per the documented precedence. */
function resolveTransport(
  explicit: MailTransport | undefined,
  options: ParsedMailOptions | undefined,
  envUrl: string | undefined,
): ResolvedTransport {
  if (explicit !== undefined) {
    return { transport: explicit, owned: false };
  }
  if (options?.smtp !== undefined) {
    return { transport: new SmtpMailTransport(options.smtp), owned: true };
  }
  if (envUrl !== undefined) {
    return { transport: new SmtpMailTransport({ url: envUrl }), owned: true };
  }
  if (options?.allowMemory === true) {
    return { transport: new InMemoryMailTransport(), owned: true };
  }
  throw new MailError(
    'missing_transport',
    'no mail transport configured: name a transport service or pass the smtp option, or set MAIL_URL/SMTP_URL',
  );
}

/** The captured messages of a transport that keeps them, else `undefined`. */
function outboxOf(transport: MailTransport): readonly ValidatedMail[] | undefined {
  return isMemoryTransport(transport) ? transport.messages() : undefined;
}

function isMemoryTransport(transport: MailTransport): transport is MemoryMailTransport {
  return typeof (transport as Partial<MemoryMailTransport>).messages === 'function';
}
