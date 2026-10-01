/**
 * `renderRoute` for tests that read a page's HTML: the outcome must be a
 * document, and its body (bytes, or a stream read whole) is returned.
 */

import assert from 'node:assert/strict';

import type { RequestContext } from '../../src/contracts/http.js';
import type { PageRenderOptions } from '../../src/contracts/render.js';
import { documentHtml, renderRoute } from '../../src/pages/page.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';

/** Render `entry` and return its document's HTML; any other outcome fails the test. */
export async function renderHtml(
  entry: RouteManifestEntry,
  context: RequestContext,
  options?: PageRenderOptions,
): Promise<string> {
  const outcome = await renderRoute(entry, context, options);
  assert.equal(outcome.kind, 'document', 'the page rendered a document');
  return documentHtml(outcome.body);
}
