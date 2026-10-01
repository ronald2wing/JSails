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
 * database write (see `admin-resource.ts`).
 */

import type { RichTextBlock } from 'jsails/rich-text';

import type { ContentRepository, Post } from './content/index.js';
import { publishedPosts } from './discovery.js';
import { BLOG_SEARCH_PAGE_SIZE, type BlogSearchEngine } from './search-contract.js';

/**
 * Project a rich-text document's blocks into a single plain-text string for
 * matching. Text-bearing blocks (paragraph, heading, list, quote, callout, and
 * the CTA label) contribute their text; code, media, embed, and divider blocks
 * contribute nothing. This mirrors `richTextToPlainText` from
 * `@jsails/editor/server` as a local, dependency-free projection so the blog
 * needs no editor import for search.
 */
export function postSearchText(post: Post): string {
  const parts: string[] = [];
  for (const block of post.blocks.blocks) {
    pushBlockText(block, parts);
  }
  return parts.filter((part) => part.trim().length > 0).join('\n');
}

/** Append a block's textual content (if any) to `parts`. */
function pushBlockText(block: RichTextBlock, parts: string[]): void {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'callout':
      parts.push(block.text);
      return;
    case 'list':
      for (const item of block.items) {
        parts.push(item);
      }
      return;
    case 'quote': {
      const citation = block.citation;
      parts.push(
        citation !== undefined && citation !== '' ? `${block.text} (${citation})` : block.text,
      );
      return;
    }
    case 'cta':
      parts.push(block.label);
      return;
    // Code, media, embeds, and dividers carry no plain text.
    case 'code':
    case 'image':
    case 'gallery':
    case 'embed':
    case 'divider':
      return;
  }
}

/** The combined searchable text of a post: title, excerpt, and projected body. */
function postSearchableText(post: Post): string {
  return `${post.title}\n${post.excerpt}\n${postSearchText(post)}`;
}

/** Normalize a page value to a positive integer, falling back to 1. */
function pageOf(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** Normalize a limit value to a positive integer, falling back to the default. */
function limitOf(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Build the reference search engine over a {@link ContentRepository}: published
 * posts are read on every search and matched case-insensitively over the title,
 * excerpt, and plain-text body, ordered newest-first (the same deterministic
 * order as {@link publishedPosts}). No external service or dependency is
 * involved, and indexing is a documented no-op because there is no separate
 * index to keep current.
 */
export function createDatabaseBlogSearch(options: {
  readonly repository: ContentRepository;
}): BlogSearchEngine {
  const repository = options.repository;

  return {
    async search(query, searchOptions = {}) {
      const needle = query.trim().toLowerCase();
      const posts = await repository.listPosts();
      // `publishedPosts` filters to published and sorts newest-first, giving the
      // deterministic ordering the contract requires.
      const matched = publishedPosts(posts).filter((post) => {
        if (needle === '') return true;
        return postSearchableText(post).toLowerCase().includes(needle);
      });

      const limit = limitOf(searchOptions.limit, BLOG_SEARCH_PAGE_SIZE);
      const page = pageOf(searchOptions.page);
      const start = (page - 1) * limit;
      return {
        posts: matched.slice(start, start + limit),
        total: matched.length,
      };
    },
    async index() {
      // The repository is the source of truth: every search re-reads it, so a
      // separate index would only drift. This exists for contract symmetry.
    },
    async remove() {
      // Documented no-op, as above.
    },
    async reindex() {
      // Documented no-op, as above.
    },
  };
}
