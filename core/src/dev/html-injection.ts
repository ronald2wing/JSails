/**
 * Dev-only HTML injection of the reload client.
 *
 * The reload script is appended by the server, not by a template. A template
 * would have to be dev-gated in template code, would have to be repeated in
 * every starter, and would run during a static export — where there is no dev
 * server to connect to. Injecting at the response boundary keeps the decision
 * in one place and keeps the script out of `jsails build` output entirely.
 *
 * The middleware runs after the route handler and before `compress`/`etag`
 * finalize, so it sees the uncompressed body and its replacement is what gets
 * compressed and tagged.
 */

import { DEV_GENERATION_GLOBAL, devReloadScript } from './live-reload.js';

/** The marker that makes injection idempotent. */
const INJECTION_MARKER = `window.${DEV_GENERATION_GLOBAL}`;

/** CSP nonces are base64/base64url tokens; anything else is dropped, never echoed. */
const NONCE_PATTERN = /^[A-Za-z0-9+/_=-]{1,256}$/;

/**
 * Append the reload script to an HTML document.
 *
 * Returns the input unchanged when the document already carries the script, or
 * when it has no `</body>` to splice into (a fragment, or a streamed page).
 */
export function injectReloadScript(html: string, generation: number, nonce?: string): string {
  if (html.includes(INJECTION_MARKER)) {
    return html;
  }
  const closing = html.lastIndexOf('</body>');
  if (closing === -1) {
    return html;
  }
  const nonceAttribute =
    nonce !== undefined && NONCE_PATTERN.test(nonce) ? ` nonce="${nonce}"` : '';
  const script = `<script${nonceAttribute}>${devReloadScript(generation)}</script>`;
  return `${html.slice(0, closing)}${script}${html.slice(closing)}`;
}

/** The minimal Hono context surface the middleware needs. */
export interface HtmlContext {
  readonly req: { readonly method: string };
  res: Response;
}

/**
 * A Hono middleware that injects the reload script into HTML responses.
 *
 * Only `GET` responses that are `200` and `text/html` are touched. A streamed
 * page (`x-accel-buffering: no`) is skipped: it has no complete body to splice,
 * and reading it would buffer the stream. The body is read from a clone, so a
 * response the middleware does not change (a fragment with no `</body>`, or a
 * page that already carries the script) is sent with its original body intact.
 *
 * `nonce`, when given, returns the request's CSP nonce so the injected inline
 * script runs under an app-defined `script-src 'nonce-…'` policy.
 */
export function devReloadMiddleware(options: {
  readonly generation: () => number;
  readonly nonce?: (context: HtmlContext) => string | undefined;
}): (context: HtmlContext, next: () => Promise<void>) => Promise<void> {
  return async (context, next) => {
    await next();
    if (context.req.method !== 'GET') {
      return;
    }
    const response = context.res;
    if (response.status !== 200) {
      return;
    }
    if (response.headers.get('x-accel-buffering') === 'no') {
      return;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/html')) {
      return;
    }

    const html = await response.clone().text();
    const injected = injectReloadScript(html, options.generation(), options.nonce?.(context));
    if (injected === html) {
      return;
    }

    // The body changed, so the old length and validator are wrong. Leaving them
    // would truncate the response or serve a 304 for different content.
    //
    // They must be deleted from the *current* response, not from the new one:
    // Hono's `res` setter copies every header of the outgoing response onto the
    // replacement (skipping only `content-type`), so a delete on the new
    // Headers is undone by the assignment.
    response.headers.delete('content-length');
    response.headers.delete('etag');
    context.res = new Response(injected, {
      status: response.status,
      headers: response.headers,
    });
  };
}
