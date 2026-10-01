/**
 * The development mail preview: an index of the app's templates and the
 * in-memory outbox, plus a route that renders each.
 *
 * The plugin mounts these routes only when `NODE_ENV` is exactly
 * `development`; in any other environment nothing is registered, so the paths
 * fall through to the app's own 404. Templates render with their `preview`
 * props. The outbox lists what the plugin's in-memory transport captured
 * (`allowMemory: true`, or an explicit transport with a `messages()` reader).
 *
 * A rendered mail is served under a `sandbox` Content-Security-Policy: its
 * HTML may come from a captured message the app did not template, so the page
 * runs in an opaque origin with no script and no access to the app's cookies.
 * Every response is `no-store`.
 *
 * The routes answer only a request whose TCP peer is this machine. A
 * development server often listens on every interface, and the outbox holds
 * real mail (password-reset links, sign-in codes), so anyone on the same
 * network could otherwise read it. The peer is the client core's first
 * pipeline stage resolved from the socket (`c.var.client` with `via: 'socket'`),
 * never a header the client writes; a request that arrived with forwarding
 * headers (`c.var.relayed`) is refused too, because behind a local proxy every
 * peer is loopback. Outside that pipeline nothing is resolved, so the routes
 * fail closed. Anything else gets the same 404 as a path that does not exist.
 */

import type { ClientAddress } from 'jsails';
import type { HttpExtensionHook } from 'jsails/extensions';
import { renderToString } from 'jsails/render-to-string';
import type { MailDefinition } from './define-mail.js';
import type { ValidatedMail } from './mailer.js';

/** The base path of the preview routes. */
export const MAIL_PREVIEW_PATH = '/_jsails/mail';

/** The policy a rendered mail is served under; see the module comment. */
const SANDBOX_POLICY =
  "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:";

/** The policy of the index page, which renders only escaped text and links. */
const INDEX_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/** What the preview reads from the plugin. */
export interface MailPreviewSource {
  /** The templates to list. */
  readonly mails: readonly MailDefinition<unknown>[];
  /** The captured outbox, or `undefined` when the transport keeps none. */
  outbox(): readonly ValidatedMail[] | undefined;
}

function respond(body: string, contentType: string, policy: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': `${contentType}; charset=utf-8`,
      'content-security-policy': policy,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function notFound(): Response {
  return respond('Not found', 'text/plain', SANDBOX_POLICY, 404);
}

/** Serve one mail's HTML part, or its text part when `?part=text`. */
function renderPart(
  part: string | undefined,
  html: string | undefined,
  text: string | undefined,
): Response {
  if (part === 'text' || html === undefined) {
    return respond(text ?? '', 'text/plain', SANDBOX_POLICY);
  }
  return respond(html, 'text/html', SANDBOX_POLICY);
}

function IndexPage(props: {
  readonly mails: readonly MailDefinition<unknown>[];
  readonly outbox: readonly ValidatedMail[] | undefined;
}) {
  const { mails, outbox } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Mail preview</title>
        <style>{'body{font:15px/1.5 system-ui,sans-serif;margin:2rem;max-width:60rem}'}</style>
      </head>
      <body>
        <h1>Mail preview</h1>
        <h2>Templates</h2>
        {mails.length === 0 ? (
          <p>
            No templates. Pass them to mailPlugin({'{'} previews {'}'}).
          </p>
        ) : (
          <ul>
            {mails.map((mail) => (
              <li key={mail.name}>
                {mail.preview === undefined ? (
                  <span>{mail.name} (no preview props)</span>
                ) : (
                  <>
                    <a href={`${MAIL_PREVIEW_PATH}/templates/${encodeURIComponent(mail.name)}`}>
                      {mail.name}
                    </a>{' '}
                    <a
                      href={`${MAIL_PREVIEW_PATH}/templates/${encodeURIComponent(mail.name)}?part=text`}
                    >
                      text
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <h2>Outbox</h2>
        {outbox === undefined ? (
          <p>The outbox is kept only by the in-memory transport (allowMemory: true).</p>
        ) : outbox.length === 0 ? (
          <p>Nothing sent yet.</p>
        ) : (
          <ol>
            {outbox.map((message, index) => (
              <li key={index}>
                <a href={`${MAIL_PREVIEW_PATH}/outbox/${index}`}>{message.subject}</a> to{' '}
                {message.to} <a href={`${MAIL_PREVIEW_PATH}/outbox/${index}?part=text`}>text</a>
              </li>
            ))}
          </ol>
        )}
      </body>
    </html>
  );
}

/** True for the IPv4 and IPv6 loopback addresses, in the normalized form core resolves. */
function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address);
}

/** The parts of a route context the loopback check reads: what core's first stage resolved. */
interface PeerView {
  readonly var: { readonly client?: ClientAddress; readonly relayed?: boolean };
}

/** Whether the request came straight from this machine; see the module comment. */
function fromLoopback(context: PeerView): boolean {
  const client = context.var.client;
  return (
    client !== undefined &&
    client.via === 'socket' &&
    context.var.relayed === false &&
    isLoopbackAddress(client.ip)
  );
}

/** Build the HTTP hook that mounts the preview routes. */
export function mailPreviewHook(source: MailPreviewSource): HttpExtensionHook {
  const byName = new Map(source.mails.map((mail) => [mail.name, mail]));
  return (app) => {
    app.get(MAIL_PREVIEW_PATH, (context) => {
      if (!fromLoopback(context)) {
        return notFound();
      }
      return respond(
        `<!DOCTYPE html>${renderToString(<IndexPage mails={source.mails} outbox={source.outbox()} />)}`,
        'text/html',
        INDEX_POLICY,
      );
    });
    app.get(`${MAIL_PREVIEW_PATH}/templates/:name`, (context) => {
      if (!fromLoopback(context)) {
        return notFound();
      }
      const mail = byName.get(context.req.param('name'));
      if (mail === undefined || mail.preview === undefined) {
        return notFound();
      }
      const rendered = mail.render(mail.preview);
      return renderPart(context.req.query('part'), rendered.html, rendered.text);
    });
    app.get(`${MAIL_PREVIEW_PATH}/outbox/:index`, (context) => {
      if (!fromLoopback(context)) {
        return notFound();
      }
      const raw = context.req.param('index');
      const message = /^\d{1,6}$/.test(raw) ? source.outbox()?.[Number(raw)] : undefined;
      if (message === undefined) {
        return notFound();
      }
      return renderPart(context.req.query('part'), message.html, message.text);
    });
  };
}
