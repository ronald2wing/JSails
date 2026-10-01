/**
 * First-party blog plugin: a live blog over the tenant-free CMS
 * `ContentRepository`.
 *
 * This plugin demonstrates the `definePlugin` contract end to end. The
 * repository is injectable: the default is the in-memory
 * `createContentRepository()`, and `createDatabaseContentRepository` (see
 * `./persistence/`) backs the same `ContentRepository` contract with
 * MariaDB/Postgres/SQLite via TypeORM. One `blogPlugin` call contributes:
 *
 * - a typed `ContentRepository` service under `blogRepositoryToken`;
 * - the plugin's static `schema` (`contentEntities`), so `db:push`/`db:diff`
 *   discover the CMS tables when `jsails/blog` is enabled — without ever
 *   calling `setup`;
 * - a `blog.post.create` operation, guarded by a before interceptor (trim
 *   title/slug and reject an empty title with a value-free error) and an
 *   after interceptor (passes the repository-stamped post through unchanged);
 * - a `blog.post.created` event emitted after each create, observable by any
 *   plugin through the shared interceptor/observer registry;
 * - Hono routes: the public discovery surfaces — `GET /blog` (paginated,
 *   escaped list of published posts with prev/next links), `GET /blog/category/:slug`
 *   and `GET /blog/tag/:slug` (published posts in a term), `GET /blog/rss.xml` /
 *   `GET /blog/atom.xml` (RSS 2.0 and Atom 1.0 feeds), and `GET /blog/sitemap.xml`
 *   (published post URLs plus `/blog`) — plus `POST /blog/posts` (form
 *   `title`/`slug`/`body`; 303 redirect on success, 422 with a value-free error
 *   on validation failure).
 *
 * The operation/event tokens are module-level so consumers (other plugins and
 * tests) can import the same identities the plugin registers against.
 * `blogRepositoryToken` is shared so an application can build one repository
 * and hand the same instance to both `blogPlugin` and `blogAdmin`, keeping the
 * HTTP list/create surface and the admin CRUD surface backed by one store.
 */

import { Encoding, Str } from 'jsails/support';
import { createThemeRegistry, renderThemeTemplate, type ThemePackage } from '@jsails/theme';
import {
  createServiceToken,
  defineEvent,
  defineOperation,
  definePlugin,
  type AfterInterceptor,
  type BeforeInterceptor,
  type JsailsPlugin,
  type ServiceToken,
} from 'jsails/extensions';
import { qEq, query } from 'jsails/database';
import { definePublication, publicationRegistryToken } from 'jsails/live';
import { z } from 'zod';
import { contentEntities, JsailsContentPost } from './persistence/index.js';
import {
  editorDocumentPayload,
  type EditorDocument,
  type RichTextEditorAdapter,
} from 'jsails/rich-text';
import {
  createContentRepository,
  type ContentRepository,
  type Post,
  type PostCreateInput,
} from './content/index.js';
import {
  findCategoryBySlug,
  findTagBySlug,
  paginate,
  postsInCategory,
  postsInTag,
  publishedPosts,
  renderAtomFeed,
  renderBlogIndex,
  renderCategoryIndex,
  renderRssFeed,
  renderSearchForm,
  renderSearchResults,
  renderSitemap,
  renderTagIndex,
} from './discovery.js';
import { blogSearchToken, type BlogSearchEngine } from './search-contract.js';
import { createOramaBlogSearch } from './search-orama.js';

/**
 * The author id stamped on posts created through the HTTP demo route, where no
 * authenticated author exists. It is a fixed, well-formed id (the model
 * requires one) and is never surfaced as a secret.
 */
export const BLOG_HTTP_AUTHOR_ID = 'blog-http';

/** Payload of the `blog.post.created` event. */
export interface BlogPostCreatedEvent {
  readonly post: Post;
}

/** A full-fidelity renderer supplied by an editor adapter. */
export type BlogEditorRenderer = (document: EditorDocument) => string | undefined;

/** Typed service token for the optional full-fidelity editor renderer. */
export const blogEditorRendererToken: ServiceToken<BlogEditorRenderer> =
  createServiceToken<BlogEditorRenderer>('blogEditorRenderer');

/** Options for {@link blogPlugin}. */
export interface BlogPluginOptions {
  /** Override the repository; defaults to a fresh in-memory repository. */
  repository?: ContentRepository;
  /**
   * Optional editor adapter. When it provides `render(native)`, the blog exposes
   * a full-fidelity renderer under {@link blogEditorRendererToken}; otherwise
   * pages keep using the canonical renderer.
   */
  editor?: RichTextEditorAdapter;
  /**
   * Theme packages used by the public discovery routes. Empty by default so a
   * bare plugin keeps its dependency-light markup; the generated blog passes
   * `builtinThemePackages` (including Jello Elementor).
   */
  themes?: readonly ThemePackage[];
  /**
   * Search engine backing `GET /blog/search`. Defaults to
   * {@link createDatabaseBlogSearch} over this plugin's repository, so search
   * works with no external service; inject a {@link BlogSearchEngine} to plug in
   * a future index. The engine is also provided under {@link blogSearchToken}.
   */
  search?: BlogSearchEngine;
}

/** Typed service token for the content repository backing the blog. */
export const blogRepositoryToken: ServiceToken<ContentRepository> =
  createServiceToken<ContentRepository>('blogRepository');

/** Operation token for creating a post, wrapped by the before/after interceptors. */
export const createPostOperation = defineOperation<PostCreateInput, Post>('blog.post.create');

/** Event token emitted after a post is created. */
export const postCreatedEvent = defineEvent<BlogPostCreatedEvent>('blog.post.created');

/**
 * Raised when the before interceptor rejects a post. The message is fixed and
 * carries no user input, so it is safe to surface verbatim.
 */
export class BlogValidationError extends Error {
  constructor() {
    super('blog post title must be a non-empty string');
    this.name = 'BlogValidationError';
  }
}

/**
 * Derive a URL slug from a title, falling back to a fixed value when the
 * result is empty. Shared by the HTTP route and the admin resource so both
 * surfaces treat an omitted slug identically.
 */
export function deriveSlug(title: string): string {
  const slug = Str.slug(title, { lower: true, strict: true });
  return slug === '' ? 'post' : slug;
}

/**
 * The request scheme + host (no path), used as the base URL for feed and
 * sitemap links. A request that carries no parseable absolute URL (an in-process
 * test or a proxy that strips the Host header) falls back to `http://localhost`,
 * so the routes never throw on lookup.
 */
function originOf(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return 'http://localhost';
  }
}

/**
 * Build the draft block document for a post created over the form: a single
 * paragraph block wrapping the (plain-text only) body, or an empty document
 * when no body was supplied. Client HTML is never trusted — the body is stored
 * as plain block text and rendered through the allowlisted renderer, never
 * emitted verbatim.
 */
function draftDocument(body: string): PostCreateInput['blocks'] {
  const blocks =
    body === '' ? [] : [{ id: Encoding.nanoid(), type: 'paragraph' as const, text: body }];
  return { version: 1, blocks };
}

/** Theme setting key shared with blogThemeAdmin. */
const THEME_SETTING_KEY = 'theme.active';

/** Render post cards for a theme layout slot (trusted, already escaped). */
function renderPostCards(posts: readonly Post[]): string {
  if (posts.length === 0) return '<p class="text-base-content/70">No posts yet.</p>';
  return posts
    .map(
      (post) =>
        `<article><h2><a href="/blog/${encodeURIComponent(post.slug)}">${Str.escapeHtml(post.title)}</a></h2><p>${Str.escapeHtml(post.excerpt)}</p></article>`,
    )
    .join('');
}

/** Render the full themed blog document: tokens/CSS, header, layout, footer. */
function renderThemedPage(
  registry: ReturnType<typeof createThemeRegistry>,
  theme: ThemePackage,
  title: string,
  layout: 'blogIndex' | 'blogArchive',
  slots: Readonly<Record<string, string>>,
): string {
  const template = theme.layouts[layout];
  if (template === undefined) return '';
  const nav = '<a href="/blog">Blog</a><a href="/">Home</a>';
  const header =
    theme.layouts.header === undefined
      ? ''
      : renderThemeTemplate(theme.layouts.header, {
          siteName: 'JSails',
          navigation: nav,
          actions: '',
        });
  const footer =
    theme.layouts.footer === undefined
      ? ''
      : renderThemeTemplate(theme.layouts.footer, {
          copyright: 'JSails blog',
          navigation: nav,
        });
  const body = renderThemeTemplate(template, slots);
  const css = `${registry.activate(theme.name).toCss()}\n${theme.css}`;
  return `<!doctype html><html lang="en" data-theme="${Str.escapeHtml(theme.name)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${Str.escapeHtml(title)}</title><style>${css}</style></head><body>${header}<main>${body}</main>${footer}</body></html>`;
}

/**
 * Build the blog plugin. Every call creates its own repository unless one is
 * injected, so a plugin instance owns no global state and nothing outside the
 * application registry needs cleanup.
 */
export function blogPlugin(options: BlogPluginOptions = {}): JsailsPlugin {
  const repository = options.repository ?? createContentRepository();
  const search = options.search ?? createOramaBlogSearch({ repository });
  const themes = options.themes ?? [];
  const themeRegistry = themes.length === 0 ? undefined : createThemeRegistry({ packages: themes });

  /** Resolve the active theme, falling back to the first registered package. */
  async function activeTheme(): Promise<ThemePackage | undefined> {
    if (themeRegistry === undefined) return undefined;
    try {
      const setting = await repository.getSetting(THEME_SETTING_KEY);
      if (setting !== undefined && typeof setting.value === 'string') {
        return themeRegistry.activate(setting.value).resolveActive();
      }
    } catch {
      // A missing/stale theme setting falls back to the registry default.
    }
    return themeRegistry.resolveActive();
  }

  const beforeCreate: BeforeInterceptor<PostCreateInput> = (args) => {
    const title = args.title.trim();
    const slug = args.slug.trim();
    if (title === '') {
      throw new BlogValidationError();
    }
    // `PostCreateInput` is readonly; the interceptor seam mutates args in place.
    Object.assign(args, { title, slug });
  };

  // The repository owns ids and timestamps, so the after hook passes the
  // created post through unchanged; it is registered to keep the operation's
  // after phase part of the public interceptor seam.
  const afterCreate: AfterInterceptor<PostCreateInput, Post> = (result) => result;

  return definePlugin({
    name: 'blog',
    // Static schema: `db:push`/`db:diff` discover the CMS tables here, without
    // running `setup`, whenever `jsails/blog` is enabled.
    schema: { entities: contentEntities },
    setup({ services, configureHttp, intercept, interceptorRegistry }) {
      services.provide(blogRepositoryToken, repository);
      services.provide(blogSearchToken, search);

      // The published post list is the blog's live surface. The live plugin
      // provides the registry under this token; when the app does not run the
      // live layer there is no registry and the publication is simply not
      // registered, so the blog works without it.
      const publications = services.tryGet(publicationRegistryToken);
      publications?.register(
        definePublication({
          name: 'blog.posts',
          collection: 'posts',
          params: z.object({}).strict(),
          // Published posts are public content, so every subscriber may read
          // them. Drafts never enter the result set, so there is nothing to
          // gate per user.
          authorize: () => true,
          // Membership is a pure function of the row: no limit, no offset, no
          // relation predicate, no clock-derived filter (LIVE-PLAN.md §15).
          query: () =>
            query<JsailsContentPost>(JsailsContentPost)
              .where(qEq('status', 'published'))
              .orderBy('publishedAt', 'DESC'),
        }),
      );
      const editor = options.editor;
      const render = editor?.render;
      if (editor !== undefined && render !== undefined) {
        services.provide(blogEditorRendererToken, (document: EditorDocument) => {
          if (document.editor !== editor.id) return undefined;
          return render.call(editor, editorDocumentPayload(editor, document));
        });
      }

      // Participate in the application's interceptor graph so other plugins
      // (and tests) can hook the operation; the create route emits
      // `postCreatedEvent` so observers on the shared registry also fire.
      intercept(createPostOperation, beforeCreate);
      intercept(createPostOperation, afterCreate, { phase: 'after' });

      // Run the operation through the SHARED registry, not a private one: the
      // registry's run methods (`runBefore`/`runAfter`/`emit`) stay callable
      // after setup seals registration, so other plugins' interceptors and
      // observers on this operation/event fire for blog post creation too.
      configureHttp((app) => {
        app.get('/blog', async (c) => {
          const posts = await repository.listPosts();
          const pagination = paginate(publishedPosts(posts), c.req.query('page'));
          const theme = await activeTheme();
          const searchForm = renderSearchForm('');
          if (themeRegistry !== undefined && theme !== undefined) {
            const themed = renderThemedPage(themeRegistry, theme, 'Blog', 'blogIndex', {
              heading: 'Blog',
              description: 'Notes, updates, and stories.',
              posts: renderPostCards(pagination.items),
            });
            if (themed !== '') {
              return c.html(themed.replace('<main>', `<main>${searchForm}`));
            }
          }
          return c.html(searchForm + renderBlogIndex(pagination));
        });

        app.get('/blog/category/:slug', async (c) => {
          const categories = await repository.listCategories();
          const category = findCategoryBySlug(categories, c.req.param('slug'));
          if (category === undefined) return c.notFound();
          const posts = await repository.listPosts();
          const selected = postsInCategory(posts, category.id);
          const theme = await activeTheme();
          if (themeRegistry !== undefined && theme !== undefined) {
            const themed = renderThemedPage(themeRegistry, theme, category.name, 'blogArchive', {
              heading: category.name,
              description: category.description ?? 'Category archive',
              posts: renderPostCards(selected),
            });
            if (themed !== '') return c.html(themed);
          }
          return c.html(renderCategoryIndex(category, selected));
        });

        app.get('/blog/tag/:slug', async (c) => {
          const tags = await repository.listTags();
          const tag = findTagBySlug(tags, c.req.param('slug'));
          if (tag === undefined) return c.notFound();
          const posts = await repository.listPosts();
          const selected = postsInTag(posts, tag.id);
          const theme = await activeTheme();
          if (themeRegistry !== undefined && theme !== undefined) {
            const themed = renderThemedPage(themeRegistry, theme, tag.name, 'blogArchive', {
              heading: tag.name,
              description: tag.description ?? 'Tag archive',
              posts: renderPostCards(selected),
            });
            if (themed !== '') return c.html(themed);
          }
          return c.html(renderTagIndex(tag, selected));
        });

        app.get('/blog/search', async (c) => {
          const query = c.req.query('q') ?? '';
          const result = await search.search(query, {
            page: Number(c.req.query('page') ?? 1),
            limit: Number(c.req.query('limit') ?? 10),
          });
          const theme = await activeTheme();
          if (themeRegistry !== undefined && theme !== undefined) {
            const themed = renderThemedPage(themeRegistry, theme, 'Search', 'blogArchive', {
              heading: 'Search',
              description: 'Search posts by title, excerpt, or body.',
              posts: renderPostCards(result.posts),
            });
            if (themed !== '') {
              // Prepend the search form just inside `<main>` so the themed shell
              // keeps its header/footer while the form stays server-rendered.
              return c.html(themed.replace('<main>', `<main>${renderSearchForm(query)}`));
            }
          }
          return c.html(
            renderSearchForm(query) + renderSearchResults(query, result.posts, result.total),
          );
        });

        app.get('/blog/rss.xml', async (c) => {
          const posts = await repository.listPosts();
          return c.text(renderRssFeed(posts, originOf(c.req.url)), 200, {
            'content-type': 'application/rss+xml; charset=utf-8',
          });
        });

        app.get('/blog/atom.xml', async (c) => {
          const posts = await repository.listPosts();
          return c.text(renderAtomFeed(posts, originOf(c.req.url)), 200, {
            'content-type': 'application/atom+xml; charset=utf-8',
          });
        });

        app.get('/blog/sitemap.xml', async (c) => {
          const posts = await repository.listPosts();
          return c.text(renderSitemap(posts, originOf(c.req.url)), 200, {
            'content-type': 'application/xml; charset=utf-8',
          });
        });

        app.post('/blog/posts', async (c) => {
          const form = await c.req.parseBody();
          const title = typeof form.title === 'string' ? form.title : '';
          const body = typeof form.body === 'string' ? form.body : '';
          const rawSlug = typeof form.slug === 'string' ? form.slug : '';
          const args: PostCreateInput = {
            title,
            slug: rawSlug.trim() === '' ? deriveSlug(title) : rawSlug,
            blocks: draftDocument(body),
            status: 'draft',
            authorId: BLOG_HTTP_AUTHOR_ID,
          };
          try {
            await interceptorRegistry.runBefore(createPostOperation, args);
            const post = await repository.createPost(args);
            const created = await interceptorRegistry.runAfter(createPostOperation, args, post);
            await interceptorRegistry.emit(postCreatedEvent, { post: created });
            return c.redirect('/blog', 303);
          } catch (error) {
            if (error instanceof BlogValidationError) {
              return c.html('<p>Title is required.</p>', 422);
            }
            throw error;
          }
        });
      });
    },
  });
}
