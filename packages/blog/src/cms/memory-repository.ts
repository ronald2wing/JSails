/**
 * In-memory {@link BlogRepository}: the default store for a bare `blogPlugin`,
 * tests, and demos.
 *
 * {@link createMemoryBlogRepository} keeps every collection in a `Map` with
 * injectable `now`/`nextId` clocks and owns no TypeORM import. Returned
 * entities are deep-frozen decoded values of the model schemas, so neither the
 * caller nor the map entry can mutate shared state after a write. The entity
 * shapes and transition rules come from `./entity-builders.ts`; the semantics
 * and error codes are the contract's (`./repository.ts`).
 */

import { deepFreeze, type JsonValue } from 'jsails/plugin-sdk';
import { Encoding } from 'jsails/support';

import {
  createMenu,
  createPage,
  createPost,
  createRevision,
  createSetting,
  createTerm,
  mergeMenu,
  mergePage,
  mergePost,
  mergeTerm,
  transitionStatus,
} from './entity-builders.js';
import type {
  BlogMenu,
  BlogMenuCreateInput,
  BlogMenuUpdateInput,
  BlogPage,
  BlogPageCreateInput,
  BlogPageUpdateInput,
  BlogPost,
  BlogPostCreateInput,
  BlogPostUpdateInput,
  BlogRevision,
  BlogRevisionInput,
  BlogSetting,
  BlogTerm,
  BlogTermInput,
} from './model.js';
import type { BlogRepository } from './repository.js';
import {
  assertInputObject,
  createRepositoryClock,
  notFound,
  slugConflict,
} from './repository-guards.js';

/** Options for {@link createMemoryBlogRepository}. */
export interface MemoryBlogRepositoryOptions {
  /** Clock used to stamp timestamps. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Id generator. Defaults to a URL-safe random id. Must return a non-empty string. */
  readonly nextId?: () => string;
}

/** A collection entry surface; used only for slug-conflict scans. */
interface Sluggable {
  readonly id: string;
  readonly slug: string;
}

/** Raise `slug_conflict` when another entry in the collection uses the slug. */
function assertNoSlugConflict(
  entries: Iterable<Sluggable>,
  selfId: string | null,
  slug: string,
): void {
  for (const entry of entries) {
    if (entry.id !== selfId && entry.slug === slug) {
      throw slugConflict();
    }
  }
}

/** The CRUD surface of one taxonomy (categories or tags). */
interface TaxonomyStore {
  list(): Promise<readonly BlogTerm[]>;
  get(id: string): Promise<BlogTerm | undefined>;
  create(input: BlogTermInput): Promise<BlogTerm>;
  update(id: string, input: BlogTermInput): Promise<BlogTerm>;
  delete(id: string): Promise<void>;
}

/**
 * Build an in-memory {@link BlogRepository}. Option mistakes throw
 * `TypeError`; per-operation failures raise the value-free
 * {@link BlogContentError}s detailed in the contract.
 */
export function createMemoryBlogRepository(
  options: MemoryBlogRepositoryOptions = {},
): BlogRepository {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMemoryBlogRepository requires an options object');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  if (options.nextId !== undefined && typeof options.nextId !== 'function') {
    throw new TypeError('nextId must be a function');
  }

  const { makeId, stamp } = createRepositoryClock(
    options.nextId ?? (() => Encoding.nanoid()),
    options.now ?? (() => new Date()),
  );

  const posts = new Map<string, BlogPost>();
  const pages = new Map<string, BlogPage>();
  const settings = new Map<string, BlogSetting>();
  const menus = new Map<string, BlogMenu>();
  const revisions: BlogRevision[] = [];

  /** Freeze and store an entity, returning the stored value. */
  function store<T extends { readonly id: string }>(map: Map<string, T>, entity: T): T {
    const frozen = deepFreeze(entity);
    map.set(frozen.id, frozen);
    return frozen;
  }

  /** Read an entity or raise `not_found`. */
  function existing<T>(map: Map<string, T>, id: string, label: string): T {
    const current = map.get(id);
    if (current === undefined) {
      throw notFound(label);
    }
    return current;
  }

  /** Delete an entity or raise `not_found`. */
  async function remove(map: Map<string, unknown>, id: string, label: string): Promise<void> {
    if (!map.delete(id)) {
      throw notFound(label);
    }
  }

  /**
   * One taxonomy's CRUD over its own map. Categories and tags share the term
   * shape and the per-collection slug namespace, so they share this code.
   */
  function taxonomyStore(label: string): TaxonomyStore {
    const terms = new Map<string, BlogTerm>();

    function save(term: BlogTerm, selfId: string | null): BlogTerm {
      assertNoSlugConflict(terms.values(), selfId, term.slug);
      return store(terms, term);
    }

    return {
      list: async () => [...terms.values()],
      get: async (id) => terms.get(id),
      create: async (input) => {
        assertInputObject(input, label);
        return save(createTerm(input, makeId(), label), null);
      },
      update: async (id, input) => {
        const current = existing(terms, id, label);
        assertInputObject(input, label);
        return save(mergeTerm(current, input, label), id);
      },
      delete: (id) => remove(terms, id, label),
    };
  }

  const categories = taxonomyStore('category');
  const tags = taxonomyStore('tag');

  // -- Posts ----------------------------------------------------------------

  async function insertPost(input: BlogPostCreateInput): Promise<BlogPost> {
    assertInputObject(input, 'post');
    const post = createPost(input, { id: makeId(), timestamp: stamp() });
    assertNoSlugConflict(posts.values(), null, post.slug);
    return store(posts, post);
  }

  async function updatePost(id: string, input: BlogPostUpdateInput): Promise<BlogPost> {
    const current = existing(posts, id, 'post');
    assertInputObject(input, 'post');
    const post = mergePost(current, input, stamp());
    assertNoSlugConflict(posts.values(), current.id, post.slug);
    return store(posts, post);
  }

  async function transitionPost(
    id: string,
    transition: 'publish' | 'unpublish',
  ): Promise<BlogPost> {
    const current = existing(posts, id, 'post');
    const status = transitionStatus(current.status, transition);
    if (status === undefined) {
      return current;
    }
    const timestamp = stamp();
    return store(posts, {
      ...current,
      status,
      ...(status === 'published' ? { publishedAt: timestamp } : {}),
      updatedAt: timestamp,
    });
  }

  // -- Pages ----------------------------------------------------------------

  async function insertPage(input: BlogPageCreateInput): Promise<BlogPage> {
    assertInputObject(input, 'page');
    const page = createPage(input, { id: makeId(), timestamp: stamp() });
    assertNoSlugConflict(pages.values(), null, page.slug);
    return store(pages, page);
  }

  async function updatePage(id: string, input: BlogPageUpdateInput): Promise<BlogPage> {
    const current = existing(pages, id, 'page');
    assertInputObject(input, 'page');
    const page = mergePage(current, input, stamp());
    assertNoSlugConflict(pages.values(), current.id, page.slug);
    return store(pages, page);
  }

  async function transitionPage(
    id: string,
    transition: 'publish' | 'unpublish',
  ): Promise<BlogPage> {
    const current = existing(pages, id, 'page');
    const status = transitionStatus(current.status, transition);
    if (status === undefined) {
      return current;
    }
    return store(pages, { ...current, status, updatedAt: stamp() });
  }

  // -- Settings -------------------------------------------------------------

  async function setSetting(key: string, value: JsonValue): Promise<BlogSetting> {
    const setting = deepFreeze(createSetting(key, value, stamp()));
    settings.set(setting.key, setting);
    return setting;
  }

  // -- Menus ----------------------------------------------------------------

  async function insertMenu(input: BlogMenuCreateInput): Promise<BlogMenu> {
    assertInputObject(input, 'menu');
    return store(menus, createMenu(input, makeId()));
  }

  async function updateMenu(id: string, input: BlogMenuUpdateInput): Promise<BlogMenu> {
    const current = existing(menus, id, 'menu');
    assertInputObject(input, 'menu');
    return store(menus, mergeMenu(current, input));
  }

  // -- Revisions ------------------------------------------------------------

  async function appendRevision(input: BlogRevisionInput): Promise<BlogRevision> {
    assertInputObject(input, 'revision');
    const revision = deepFreeze(createRevision(input, { id: makeId(), timestamp: stamp() }));
    revisions.push(revision);
    return revision;
  }

  return {
    listPosts: async () => [...posts.values()],
    getPost: async (id) => posts.get(id),
    getPosts: async (ids) =>
      ids.map((id) => posts.get(id)).filter((post): post is BlogPost => post !== undefined),
    createPost: insertPost,
    updatePost,
    publishPost: (id) => transitionPost(id, 'publish'),
    unpublishPost: (id) => transitionPost(id, 'unpublish'),
    deletePost: (id) => remove(posts, id, 'post'),

    listPages: async () => [...pages.values()],
    getPage: async (id) => pages.get(id),
    createPage: insertPage,
    updatePage,
    publishPage: (id) => transitionPage(id, 'publish'),
    unpublishPage: (id) => transitionPage(id, 'unpublish'),
    deletePage: (id) => remove(pages, id, 'page'),

    listCategories: categories.list,
    getCategory: categories.get,
    createCategory: categories.create,
    updateCategory: categories.update,
    deleteCategory: categories.delete,

    listTags: tags.list,
    getTag: tags.get,
    createTag: tags.create,
    updateTag: tags.update,
    deleteTag: tags.delete,

    listSettings: async () => [...settings.values()],
    getSetting: async (key) => settings.get(key),
    setSetting,

    listMenus: async () => [...menus.values()],
    getMenu: async (id) => menus.get(id),
    createMenu: insertMenu,
    updateMenu,
    deleteMenu: (id) => remove(menus, id, 'menu'),

    listRevisions: async (entryType, entryId) =>
      revisions.filter(
        (revision) => revision.entryType === entryType && revision.entryId === entryId,
      ),
    appendRevision,
  };
}
