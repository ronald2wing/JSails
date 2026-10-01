/**
 * Dev-only HTML injection of the reload client.
 *
 * The reload script is appended by the server, not by a template. A template
 * would have to be dev-gated in template code, would have to be repeated in
 * every starter, and would run during a static export — where there is no dev
 * server to connect to. Injecting at the response boundary keeps the decision
 * in one place and keeps the script out of `jsails build` output entirely.
 *
 * The transform runs on a route's answer after its handler and before the
 * output finalizer encodes and tags it, so it sees the uncompressed body and
 * its replacement is what gets compressed and tagged.
 */

import type { RequestContext } from '../contracts/http.js';
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

/**
 * The response transform that injects the reload client into a page answer:
 * a `200` `text/html` answer to a `GET` that is not streamed
 * (`X-Accel-Buffering: no`) gets the script before its closing `</body>`,
 * carrying the request's CSP nonce when it has a valid one. The body changed,
 * so the stale `Content-Length` and `ETag` are dropped; any other answer is
 * returned as it is.
 *
 * @public
 */
export function devReloadTransform(options: {
  readonly generation: () => number;
}): (response: Response, context: RequestContext) => Promise<Response> {
  return async (response, context) => {
    if (context.request.method !== 'GET' || response.status !== 200) return response;
    if (response.headers.get('x-accel-buffering') === 'no') return response;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/html')) return response;

    const html = await response.clone().text();
    const injected = injectReloadScript(html, options.generation(), context.cspNonce);
    if (injected === html) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(injected, { status: response.status, headers });
  };
}
