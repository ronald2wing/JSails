/**
 * Orama-backed blog search: the default embedded engine.
 *
 * Orama is an in-process, dependency-free TypeScript search engine. The index
 * is built lazily from the repository on first use (so a fresh process never
 * needs a separate indexing job), updated incrementally by the admin save
 * path, and rebuilt by `reindex`. Because the index lives in memory, it is
 * per-process: a multi-instance deployment should use Meilisearch, Typesense,
 * or OpenSearch instead.
 */

import {
  create,
  insert,
  insertMultiple,
  remove as removeDocument,
  search as searchIndex,
  type Orama,
} from '@orama/orama';

import type { BlogRepository, BlogPost } from '../cms/index.js';
import { publishedPosts } from '../discovery.js';
import {
  searchWindow,
  type BlogSearchEngine,
  type BlogSearchOptions,
  type BlogSearchResult,
} from './contract.js';
import { postBodyText, resolvePublishedHits } from './post-document.js';

/** Orama schema projected from a blog post. */
const ORAMA_SCHEMA = {
  id: 'string',
  title: 'string',
  excerpt: 'string',
  body: 'string',
  status: 'string',
  publishedAt: 'string',
} as const;

type OramaDb = Orama<typeof ORAMA_SCHEMA>;

/** A document stored in the Orama index. */
interface SearchDocument {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly body: string;
  readonly status: string;
  readonly publishedAt: string;
}

/** Project a post into the indexable document. */
function toDocument(post: BlogPost): SearchDocument {
  return {
    id: post.id,
    title: post.title,
    excerpt: post.excerpt,
    body: postBodyText(post),
    status: post.status,
    publishedAt: post.publishedAt ?? post.updatedAt,
  };
}

/** Build an empty Orama index with sorting enabled. */
function createIndex(): OramaDb {
  return create({ schema: ORAMA_SCHEMA, sort: { enabled: true } });
}

/** One shared engine per repository, so plugin and admin observe one index. */
const engines = new WeakMap<BlogRepository, BlogSearchEngine>();

/**
 * Build the default embedded Orama search engine over a repository.
 *
 * The first call builds the index from all published posts. The same engine is
 * returned for the same repository instance, so `blogPlugin` and `blogAdmin`
 * share one index without global application state.
 */
export function createOramaBlogSearch(options: {
  readonly repository: BlogRepository;
}): BlogSearchEngine {
  const cached = engines.get(options.repository);
  if (cached !== undefined) return cached;

  const repository = options.repository;
  let db: OramaDb | undefined;
  let building: Promise<OramaDb> | undefined;

  async function build(): Promise<OramaDb> {
    const index = createIndex();
    const posts = await repository.listPosts();
    await insertMultiple(index, publishedPosts(posts).map(toDocument));
    db = index;
    return index;
  }

  async function ensure(): Promise<OramaDb> {
    if (db !== undefined) return db;
    building ??= build();
    try {
      return await building;
    } finally {
      building = undefined;
    }
  }

  const engine: BlogSearchEngine = {
    async search(query: string, searchOptions: BlogSearchOptions = {}): Promise<BlogSearchResult> {
      const index = await ensure();
      const { limit, offset } = searchWindow(searchOptions);
      const result = await searchIndex(index, {
        term: query,
        properties: ['title', 'excerpt', 'body'],
        limit,
        offset,
        where: { status: 'published' },
      });
      const hits = result.hits ?? [];
      const ids = hits.map((hit) => (typeof hit.id === 'string' ? hit.id : String(hit.id)));
      const posts = await resolvePublishedHits(repository, ids);
      return {
        posts,
        total: result.count ?? hits.length,
      };
    },

    async index(post: BlogPost): Promise<void> {
      const index = await ensure();
      // Orama has no natural-key upsert; remove first so a re-save replaces.
      await removeDocument(index, post.id);
      if (post.status === 'published') {
        await insert(index, toDocument(post));
      }
    },

    async remove(id: string): Promise<void> {
      const index = await ensure();
      await removeDocument(index, id);
    },

    async reindex(posts: readonly BlogPost[]): Promise<void> {
      const index = createIndex();
      await insertMultiple(index, publishedPosts(posts).map(toDocument));
      db = index;
    },
  };

  engines.set(repository, engine);
  return engine;
}
