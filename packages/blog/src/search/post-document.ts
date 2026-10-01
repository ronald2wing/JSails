/**
 * The mapping between repository posts and search-engine documents, shared by
 * every engine: the searchable body text going in, and the published posts
 * coming back out of a list of hit ids.
 */

import { richTextToPlainText } from '@jsails/editor/server';

import type { BlogRepository, BlogPost } from '../cms/index.js';

/**
 * The plain-text projection of a post's body, unbounded so the whole body stays
 * matchable (the editor's default bound is sized for excerpts, not indexes).
 */
export function postBodyText(post: BlogPost): string {
  return richTextToPlainText(post.blocks, { maxLength: Infinity });
}

/**
 * Map engine hit ids back through the repository, dropping non-published rows,
 * so a result is always a published repository `Post` and never the engine's
 * stored projection. One batch lookup replaces a query per hit; the batch
 * returns rows in no particular order, so the engine's relevance order is
 * restored here.
 */
export async function resolvePublishedHits(
  repository: BlogRepository,
  ids: readonly string[],
): Promise<readonly BlogPost[]> {
  if (ids.length === 0) return [];
  const byId = new Map((await repository.getPosts(ids)).map((post) => [post.id, post]));
  return ids
    .map((id) => byId.get(id))
    .filter((post): post is BlogPost => post !== undefined && post.status === 'published');
}
