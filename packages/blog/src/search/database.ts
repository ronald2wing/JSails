/**
 * Database-driver search for the blog: the no-dependency, no-service reference
 * implementation of {@link BlogSearchEngine}.
 *
 * It reads the repository's published posts directly and matches over the
 * title, excerpt, and a plain-text projection of the body. The "database" is
 * the repository itself, so nothing external is required and there is no
 * separate index to keep in sync.
 *
 * Indexing through this engine is intentionally a no-op success: because every
 * search re-reads the repository, `index`/`remove`/`reindex` exist only to keep
 * the contract symmetric with engines that maintain a separate index. The admin
 * therefore calls them after every successful save without ever risking the
 * database write.
 */

import type { BlogRepository, BlogPost } from '../cms/index.js';
import { publishedPosts } from '../discovery.js';
import { searchWindow, type BlogSearchEngine } from './contract.js';
import { postBodyText } from './post-document.js';

/** The combined searchable text of a post: title, excerpt, and projected body. */
function searchableText(post: BlogPost): string {
  return `${post.title}\n${post.excerpt}\n${postBodyText(post)}`;
}

/**
 * Build the reference search engine over a {@link BlogRepository}: published
 * posts are read on every search and matched case-insensitively over the title,
 * excerpt, and plain-text body, ordered newest-first (the same deterministic
 * order as {@link publishedPosts}).
 */
export function createDatabaseBlogSearch(options: {
  readonly repository: BlogRepository;
}): BlogSearchEngine {
  const repository = options.repository;

  return {
    async search(query, searchOptions) {
      const needle = query.trim().toLowerCase();
      const matched = publishedPosts(await repository.listPosts()).filter(
        (post) => needle === '' || searchableText(post).toLowerCase().includes(needle),
      );
      const { limit, offset } = searchWindow(searchOptions);
      return { posts: matched.slice(offset, offset + limit), total: matched.length };
    },
    // The repository is the source of truth: every search re-reads it, so a
    // separate index would only drift. These exist for contract symmetry.
    async index() {},
    async remove() {},
    async reindex() {},
  };
}
