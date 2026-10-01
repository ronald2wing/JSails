/**
 * The development mail preview: an index of the app's templates and the
 * in-memory outbox, plus a route that renders each.
 *
 * The plugin registers these routes only in development mode; in any other
 * mode nothing is registered, so the paths
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
 * network could otherwise read it. The peer is the client the request frame
 * resolved from the socket (`currentRequestFrame().client` with
 * `via: 'socket'`), never a header the client writes; a request that arrived
 * with forwarding headers (the frame's `relayed`) is refused too, because
 * behind a local proxy every peer is loopback. Outside a request frame
 * nothing is resolved, so the routes fail closed. Anything else gets the same
 * 404 as a path that does not exist.
 */

import { currentRequestFrame } from 'jsails/internal';
import { publicAccess, type HttpRoutes, type RouteContext } from 'jsails/kernel';
import { renderToString } from 'jsails/render-to-string';
import type { RenderedMail } from './define-mail.js';
import type { ValidatedMail } from './mailer.js';

/** The base path of the preview routes. */
export const MAIL_PREVIEW_PATH = '/_jsails/mail';

/** The policy a rendered mail is served under; see the module comment. */
const SANDBOX_POLICY =
  "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:";

/** The policy of the index page, which renders only escaped text and links. */
const INDEX_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * What the preview reads of a template: its name, its preview props (JSON
 * data), and its renderer, bound to the template.
 *
 * @public
 */
export interface MailPreview {
  readonly name: string;
  readonly preview?: unknown;
  readonly render: (props: never) => RenderedMail;
}

/** What the preview reads from the plugin. */
export interface MailPreviewSource {
  /** The templates to list. */
  readonly mails: readonly MailPreview[];
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
  part: string | null,
  html: string | undefined,
  text: string | undefined,
): Response {
  if (part === 'text' || html === undefined) {
    return respond(text ?? '', 'text/plain', SANDBOX_POLICY);
  }
  return respond(html, 'text/html', SANDBOX_POLICY);
}

function IndexPage(props: {
  readonly mails: readonly MailPreview[];
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

/** Whether the request came straight from this machine; see the module comment. */
function fromLoopback(): boolean {
  const frame = currentRequestFrame();
  return (
    frame !== undefined &&
    frame.client.via === 'socket' &&
    !frame.relayed &&
    isLoopbackAddress(frame.client.ip)
  );
}

const ACCESS = publicAccess('development mail preview; answers only a loopback peer, else 404');

/** Register the preview routes on the plugin's registrar. */
export function mailPreviewRoutes(routes: HttpRoutes, source: MailPreviewSource): void {
  const byName = new Map(source.mails.map((mail) => [mail.name, mail]));
  const get = (path: string, answer: (context: RouteContext) => Response): void => {
    routes.add({
      methods: ['GET'],
      path,
      access: ACCESS,
      // The previews read no session: a loopback request is the whole gate.
      credentials: [],
      handler: (context) => (fromLoopback() ? answer(context) : notFound()),
    });
  };
  get(MAIL_PREVIEW_PATH, () =>
    respond(
      `<!DOCTYPE html>${renderToString(<IndexPage mails={source.mails} outbox={source.outbox()} />)}`,
      'text/html',
      INDEX_POLICY,
    ),
  );
  get(`${MAIL_PREVIEW_PATH}/templates/:name`, (context) => {
    const mail = byName.get(context.params['name'] ?? '');
    if (mail === undefined || mail.preview === undefined) {
      return notFound();
    }
    const rendered = mail.render(mail.preview as never);
    return renderPart(context.url.searchParams.get('part'), rendered.html, rendered.text);
  });
  get(`${MAIL_PREVIEW_PATH}/outbox/:index`, (context) => {
    const raw = context.params['index'] ?? '';
    const message = /^\d{1,6}$/.test(raw) ? source.outbox()?.[Number(raw)] : undefined;
    if (message === undefined) {
      return notFound();
    }
    return renderPart(context.url.searchParams.get('part'), message.html, message.text);
  });
}
