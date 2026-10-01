/**
 * What a static export writes for a page whose `load` redirected: an entry in
 * a host-neutral `redirects.json`, and an HTML document at the page's path
 * for a host that reads no redirect table.
 *
 * `redirects.json` is `{ "redirects": [{ "from", "to", "status" }] }`, in the
 * order the pages were planned, for a deploy step to translate into its
 * host's own rules (a `_redirects` file, a CDN rule set). The fallback
 * document sends the browser on with a zero-second refresh and a link, names
 * the target canonical, and asks crawlers not to index it. Preact renders
 * it, so the target is escaped like any attribute.
 */

import { h } from 'preact';

import { renderToString } from '../../jsx/render-to-string.js';

/** One redirect a static export recorded. */
export interface StaticRedirect {
  /** The resolved route that redirected (`/account`). */
  readonly from: string;
  /** Its `Location`: a same-origin path, or an absolute URL. */
  readonly to: string;
  readonly status: number;
}

/** The output path of the redirect table. */
export const REDIRECTS_REL = 'redirects.json';

/** The contents of `redirects.json` for `redirects`. */
export function redirectsJson(redirects: readonly StaticRedirect[]): string {
  const entries = redirects.map(({ from, to, status }) => ({ from, to, status }));
  return `${JSON.stringify({ redirects: entries }, null, 2)}\n`;
}

/** The HTML document written at a redirected page's path. */
export function redirectDocument(location: string): string {
  const document = h(
    'html',
    null,
    h(
      'head',
      null,
      h('meta', { charset: 'utf-8' }),
      h('meta', { 'http-equiv': 'refresh', content: `0; url=${location}` }),
      h('meta', { name: 'robots', content: 'noindex' }),
      h('link', { rel: 'canonical', href: location }),
      h('title', null, 'Redirecting'),
    ),
    h('body', null, h('a', { href: location }, 'Continue')),
  );
  return `<!DOCTYPE html>${renderToString(document)}`;
}
