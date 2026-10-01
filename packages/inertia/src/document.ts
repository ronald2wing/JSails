/**
 * The HTML document for a full page load.
 *
 * Inertia v3 boots from `<script data-page="<rootId>" type="application/json">`
 * followed by the root element; the `data-page` attribute on the root element
 * that v2 read is gone (@inertiajs/core 3.11.0 `getInitialPageFromDOM`,
 * `dist/index.js` 1233-1242). The page JSON is escaped exactly as the
 * upstream SSR body builder escapes it (`buildSSRBody`, 6161-6163): `/` as
 * `\/` and `<` as `<`, so neither `</script>` nor `<!--` can occur
 * inside the block; U+2028 and U+2029 are escaped too. The block is a data
 * block, not script: the HTML script-preparation steps stop before any CSP
 * check for a non-JavaScript type, so `script-src` never applies to it and it
 * needs no nonce or hash.
 *
 * The builder is deterministic and string-based, with no view layer: a
 * doctype, `<html lang>`, a `<head>` with charset, viewport, stylesheet,
 * module-preload, caller head strings (an SSR `<Head>` result), and module
 * scripts, then a `<body>` holding the data block and root element, or the
 * SSR body, which already contains both. Inputs are validated on every call,
 * and asset URLs and the nonce are attribute-escaped.
 */

import { InertiaError } from './inertia-error.js';
import type { InertiaPageObject } from './page.js';
import { isPlainObject } from './plain-data.js';
import { serializePage } from './serialize-page.js';

/** Client asset URLs for the document head. */
export interface DocumentAssets {
  /** Module script URLs. */
  readonly scripts?: readonly string[];
  /** Stylesheet URLs. */
  readonly styles?: readonly string[];
  /** Module-preload URLs. */
  readonly preloads?: readonly string[];
}

/** Input to {@link buildDocument}. */
export interface DocumentInput {
  readonly page: InertiaPageObject;
  /** The root element id the client mounts on. Defaults to `app`. */
  readonly rootId?: string;
  /** The document language, a BCP 47 tag. */
  readonly lang?: string;
  /** Trusted head HTML, such as the SSR `<Head>` elements. */
  readonly head?: readonly string[];
  readonly assets?: DocumentAssets;
  /** The CSP nonce for the asset tags. */
  readonly nonce?: string;
  /**
   * Trusted SSR body HTML from the render gateway. It already holds the data
   * block and the server-rendered root element, so it replaces both.
   */
  readonly ssrBody?: string;
}

/** The default root element id. */
export const DEFAULT_ROOT_ID = 'app';

const ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const NONCE = /^[A-Za-z0-9+/_=-]+$/u;

/** Build the full-page-load HTML document. */
export function buildDocument(input: DocumentInput): string {
  const rootId = input.rootId ?? DEFAULT_ROOT_ID;
  assertRootId(rootId);
  if (input.lang !== undefined && !LANG.test(input.lang)) invalid();
  if (input.nonce !== undefined && !NONCE.test(input.nonce)) invalid();
  const nonce = input.nonce === undefined ? '' : ` nonce="${input.nonce}"`;
  const assets = input.assets ?? {};
  assertAssets(assets);
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...urls(assets.styles).map((href) => `<link rel="stylesheet" href="${href}"${nonce}>`),
    ...urls(assets.preloads).map((href) => `<link rel="modulepreload" href="${href}"${nonce}>`),
    ...(input.head ?? []),
    ...urls(assets.scripts).map((src) => `<script type="module" src="${src}"${nonce}></script>`),
  ].join('');
  const body = input.ssrBody ?? pageDataBlock(input.page, rootId);
  const lang = input.lang === undefined ? '' : ` lang="${input.lang}"`;
  return `<!DOCTYPE html><html${lang}><head>${head}</head><body>${body}</body></html>`;
}

/** The data block and the empty root element for a client-rendered page. */
export function pageDataBlock(page: InertiaPageObject, rootId: string = DEFAULT_ROOT_ID): string {
  assertRootId(rootId);
  return (
    `<script data-page="${rootId}" type="application/json">` +
    `${escapeScriptJson(serializePage(page))}</script><div id="${rootId}"></div>`
  );
}

/** Escape JSON for an HTML `<script type="application/json">` element. */
export function escapeScriptJson(json: string): string {
  return json
    .replaceAll('/', '\\/')
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/** Reject a root id that is not a plain HTML id (letters, digits, `-`, `_`). */
export function assertRootId(rootId: unknown): asserts rootId is string {
  if (typeof rootId !== 'string' || !ROOT_ID.test(rootId)) invalid();
}

/**
 * Reject assets that are not a plain object whose `scripts`, `styles`, and
 * `preloads` are each absent or an array of non-empty strings.
 */
export function assertAssets(assets: unknown): asserts assets is DocumentAssets {
  if (!isPlainObject(assets)) invalid();
  for (const list of [assets.scripts, assets.styles, assets.preloads]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) invalid();
    for (const url of list as readonly unknown[]) {
      if (typeof url !== 'string' || url === '') invalid();
    }
  }
}

function urls(list: readonly string[] | undefined): string[] {
  return (list ?? []).map(escapeAttribute);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function invalid(): never {
  throw new InertiaError('invalid_options');
}
