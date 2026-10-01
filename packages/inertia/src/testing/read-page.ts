/**
 * Read the page object out of a response, as the client would.
 *
 * {@link readInertiaPage} accepts both representations: the JSON body of an
 * Inertia response (`X-Inertia: true`) and the HTML document, from whose
 * `<script data-page="<rootId>" type="application/json">` element it takes
 * the page, the element @inertiajs/core 3.11.0 `getInitialPageFromDOM`
 * reads. Big integers are revived from their `{ "$bigint": "…" }` markers
 * when the page sets `preserveBigIntegers`, as `parsePage` from
 * `@inertiajs/core/json` does, so a test sees the values the browser sees.
 * A response that carries no page (a redirect, a `409`, a document without
 * the element) is a `not_a_page` error.
 */

import { DEFAULT_ROOT_ID, assertRootId } from '../document.js';
import { InertiaError } from '../inertia-error.js';
import type { InertiaPageObject } from '../page.js';
import { isPlainObject } from '../plain-data.js';
import { BIGINT_MARKER } from '../serialize-page.js';

/** Options for {@link readInertiaPage}. */
export interface ReadInertiaPageOptions {
  /** The root id of the document's data element. Defaults to `app`. */
  readonly rootId?: string;
}

/** The page object a response carries, in either representation. */
export async function readInertiaPage(
  response: Response,
  options: ReadInertiaPageOptions = {},
): Promise<InertiaPageObject> {
  const rootId = options.rootId ?? DEFAULT_ROOT_ID;
  assertRootId(rootId);
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.clone().text();
  if (response.headers.get('x-inertia') === 'true' && contentType.includes('application/json')) {
    return parsePageText(text);
  }
  if (contentType.includes('text/html')) {
    const json = dataBlock(text, rootId);
    if (json !== null) return parsePageText(json);
  }
  throw new InertiaError('not_a_page');
}

/** The text of the document's page data element, or `null` when there is none. */
function dataBlock(html: string, rootId: string): string | null {
  const open = `<script data-page="${rootId}" type="application/json">`;
  const start = html.indexOf(open);
  if (start === -1) return null;
  const end = html.indexOf('</script>', start + open.length);
  if (end === -1) return null;
  return html.slice(start + open.length, end);
}

function parsePageText(text: string): InertiaPageObject {
  let page: unknown;
  try {
    page = JSON.parse(text);
  } catch (error) {
    throw new InertiaError('not_a_page', { cause: error });
  }
  if (!isPageObject(page)) throw new InertiaError('not_a_page');
  if (page.preserveBigIntegers !== true) return page;
  const revived = revive(page);
  if (!isPageObject(revived)) throw new InertiaError('not_a_page');
  return revived;
}

function isPageObject(value: unknown): value is InertiaPageObject {
  return (
    isPlainObject(value) &&
    typeof value.component === 'string' &&
    isPlainObject(value.props) &&
    typeof value.url === 'string' &&
    typeof value.version === 'string'
  );
}

/** A copy of `value` with every `{ "$bigint": "digits" }` marker revived. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (!isPlainObject(value)) return value;
  const marker = value[BIGINT_MARKER];
  if (typeof marker === 'string') {
    if (!/^-?\d+$/u.test(marker)) throw new InertiaError('not_a_page');
    return BigInt(marker);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
}
