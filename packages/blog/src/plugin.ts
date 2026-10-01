/**
 * First-party blog plugin: a live blog over the tenant-free CMS
 * `BlogRepository`.
 *
 * The repository is injectable: the default is the in-memory
 * `createMemoryBlogRepository()`, and `createDatabaseBlogRepository` (see
 * `./persistence/`) backs the same `BlogRepository` contract with
 * MariaDB/Postgres/SQLite via TypeORM. One `blogPlugin` call contributes:
 *
 * - a typed `BlogRepository` service under `blogRepositoryToken`;
 * - the plugin's static `schema` (`blogEntities`), so `db:push`/`db:diff`
 *   discover the CMS tables when `@jsails/blog` is in `plugins.use` — without ever
 *   calling `setup`;
 * - a `blog.post.create` operation, guarded by a before interceptor (trim
 *   title/slug and reject an empty title with a value-free error) and an
 *   after interceptor (passes the repository-stamped post through unchanged);
 * - a `blog.post.created` event emitted after each create, observable by any
 *   plugin through the shared interceptor/observer registry;
 * - public routes, registered through the plugin's registrar (`routes.add`),
 *   each open to anyone and reading no credential: `GET /blog` (paginated,
 *   escaped list of published posts with prev/next links), `GET /blog/category/:slug`
 *   and `GET /blog/tag/:slug` (paginated published posts in a term), `GET /blog/rss.xml` /
 *   `GET /blog/atom.xml` (RSS 2.0 and Atom 1.0 feeds of the newest posts), and
 *   `GET /blog/sitemap.xml` (published post URLs plus `/blog`). Each route asks
 *   the repository for exactly the page it shows (`listPublishedPosts`), never
 *   the whole posts table.
 * - `POST /blog/posts` (form `title`/`slug`/`body`; 303 on success) only when
 *   the app passes `createRoute` with its own `access`: the write route is
 *   never registered by a bare plugin, and it accepts the session cookie, so
 *   core's access chain refuses a cross-site post before the app's access
 *   check or the handler runs.
 *
 * The public pages read the `blog.site` config set (title, tagline, posts per
 * page, time zone, social links) through the `@jsails/config` service when the
 * app provides it, and the defaults otherwise. Feed and sitemap links are built
 * on the configured `siteUrl`; the request origin is only a development
 * fallback.
 *
 * The operation and event tokens are module-level so the plugin registers
 * against the same identities its tests observe. `blogRepositoryToken` is
 * shared so an application can build one repository and hand the same instance
 * to both `blogPlugin` and `blogAdmin`, keeping the HTTP surfaces and the admin
 * CRUD surface backed by one store.
 */

import { configToken } from '@jsails/config';
import { trimTrailingSlashes } from '@jsails/content';
import { Str } from 'jsails/support';
import { JsailsError, notFound } from 'jsails/errors';
import {
  createThemeRegistry,
  renderThemeTemplate,
  themeTokensToCss,
  type ThemePackage,
  type ThemePackageRegistry,
} from '@jsails/theme';
import {
  createServiceToken,
  defineEvent,
  defineOperation,
  definePlugin,
  type AfterInterceptor,
  type BeforeInterceptor,
  type EventToken,
  type JsailsPlugin,
  type OperationToken,
  type ServiceToken,
} from 'jsails/extensions';
import { qEq, query } from 'jsails/database';
import { Respond } from 'jsails/api';
import { publicAccess, type HttpRoutes, type RouteAccess, type RouteContext } from 'jsails/kernel';
import { definePublication, publicationRegistryToken } from 'jsails/live';
import { normalizeRichText, RICH_TEXT_VERSION } from 'jsails/rich-text';
import { z } from 'zod';
import { blogEntities, JsailsBlogPost } from './persistence/index.js';
import {
  BlogContentError,
  createMemoryBlogRepository,
  isAllowedMenuHref,
  type BlogMenuItem,
  type BlogPost,
  type BlogPostCreateInput,
  type BlogPostSummary,
  type BlogRepository,
  type BlogTerm,
} from './cms/index.js';
import { BLOG_MAX_PUBLISHED_PAGE } from './cms/repository-guards.js';
import {
  BLOG_PATH,
  pageCount,
  pagination,
  postPath,
  renderBlogAtomFeed,
  renderBlogIndex,
  renderBlogRssFeed,
  renderBlogSitemap,
  renderPaginationNav,
  renderSearchForm,
  renderSearchResults,
  renderTermIndex,
  requestedPage,
  type Pagination,
} from './discovery.js';
import { PRIMARY_MENU_CACHE_KEY, readCached, settingCacheKey } from './read-cache.js';
import {
  BLOG_SEARCH_PAGE_SIZE,
  blogSearchToken,
  type BlogSearchEngine,
  type BlogSearchResult,
} from './search/contract.js';
import { BlogSearchError } from './search/http-driver.js';
import { createOramaBlogSearch } from './search/orama.js';
import { readBlogSiteSettings, type BlogSiteSettings } from './site-config.js';

/**
 * The author id stamped on posts created through the opt-in HTTP create route
 * (and on admin writes whose session carries no user id). It is a fixed,
 * well-formed id (the model requires one) and is never surfaced as a secret.
 */
export const BLOG_HTTP_AUTHOR_ID = 'blog-http';

/** Payload of the `blog.post.created` event. */
export interface BlogPostCreatedEvent {
  readonly post: BlogPost;
}

/** Options for {@link blogPlugin}. */
export interface BlogPluginOptions {
  /** Override the repository; defaults to a fresh in-memory repository. */
  readonly repository?: BlogRepository;
  /**
   * Theme packages used by the public discovery routes. Empty by default so a
   * bare plugin keeps its dependency-light markup; the generated blog passes
   * `builtinThemePackages` (including Jello Elementor).
   */
  readonly themes?: readonly ThemePackage[];
  /**
   * Search engine backing `GET /blog/search`. Defaults to the embedded Orama
   * engine over this plugin's repository (`createOramaBlogSearch`), so search
   * works with no external service; inject a {@link BlogSearchEngine} to use
   * another driver. The engine is also provided under {@link blogSearchToken}.
   */
  readonly search?: BlogSearchEngine;
  /**
   * The public origin (optionally with a base path) every feed and sitemap link
   * is built on, e.g. `https://blog.example.com`. Set it in production: behind
   * a TLS-terminating proxy the request URL is plain HTTP, and the request's
   * Host header is client-controlled. When set, the feeds and sitemap are also
   * marked cacheable by shared caches. When omitted, links fall back to the
   * request origin and the responses stay `private, no-store`.
   */
  readonly siteUrl?: string;
  /** Most posts the RSS/Atom feeds list (1–500). Defaults to 50. */
  readonly feedLimit?: number;
  /**
   * Opt in to `POST /blog/posts`. The route is never mounted without this, so a
   * bare plugin exposes no public write surface.
   */
  readonly createRoute?: BlogCreateRouteOptions;
}

/**
 * Options for the opt-in `POST /blog/posts` route.
 */
export interface BlogCreateRouteOptions {
  /**
   * Who may create a draft: `publicAccess(reason)`, or a check of the route's
   * request context (typically its session and role) admitting a request only
   * by returning exactly `true`. Anything else answers 401 without a session
   * and 403 with one, before the form is read.
   */
  readonly access: RouteAccess;
}

/** The menu location the public themed header renders. */
export const BLOG_PRIMARY_MENU_LOCATION = 'primary';

/** Typed service token for the content repository backing the blog. */
export const blogRepositoryToken: ServiceToken<BlogRepository> =
  createServiceToken<BlogRepository>('blogRepository');

/** Operation token for creating a post, wrapped by the before/after interceptors. */
export const createPostOperation: OperationToken<BlogPostCreateInput, BlogPost> = defineOperation<
  BlogPostCreateInput,
  BlogPost
>('blog.post.create');

/** Event token emitted after a post is created. */
export const postCreatedEvent: EventToken<BlogPostCreatedEvent> =
  defineEvent<BlogPostCreatedEvent>('blog.post.created');

/** Machine-readable reason for a {@link BlogValidationError}. */
export type BlogValidationErrorCode = 'missing_title';

/**
 * Raised when the before interceptor rejects a post. The message is fixed and
 * carries no user input, so it is safe to surface verbatim.
 */
export class BlogValidationError extends JsailsError {
  readonly code: BlogValidationErrorCode = 'missing_title';

  constructor() {
    super('blog post title must be a non-empty string');
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
 * The request scheme + host (no path): the development fallback base URL for
 * feed and sitemap links when no `siteUrl` is configured. A request that
 * carries no parseable absolute URL (an in-process test) falls back to
 * `http://localhost`, so the routes never throw on lookup.
 */
function originOf(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return 'http://localhost';
  }
}

/**
 * Validate the configured public site URL: an absolute `http:`/`https:` URL
 * without credentials, query, or fragment. Trailing slashes are dropped so a
 * path can be appended.
 */
function cleanSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('blogPlugin siteUrl must be an absolute http(s) URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('blogPlugin siteUrl must be an absolute http(s) URL');
  }
  return trimTrailingSlashes(url.href);
}

/**
 * Build the draft block document for a post created over the form: a single
 * paragraph block wrapping the (plain-text only) body, or an empty document
 * when no body was supplied. Client HTML is never trusted — the body is stored
 * as plain block text and rendered through the allowlisted renderer, never
 * emitted verbatim. A browser submits textarea line breaks as CRLF and keeps
 * pasted tabs, which the model's text rules refuse in a paragraph, so they
 * become the model's `\n` and a space; any other refused character is left
 * for the post schema to refuse.
 */
function draftDocument(body: string): BlogPostCreateInput['blocks'] {
  const text = body.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  return normalizeRichText({
    version: RICH_TEXT_VERSION,
    blocks: text === '' ? [] : [{ type: 'paragraph', content: [{ text }] }],
  });
}

/**
 * The setting holding the active theme name: read by the public routes and
 * written by the `blogThemeAdmin` page.
 */
export const BLOG_THEME_SETTING_KEY = 'theme.active';

/** Render post cards for a theme layout slot (trusted, already escaped). */
function renderPostCards(posts: readonly BlogPostSummary[]): string {
  if (posts.length === 0) return '<p class="text-base-content/70">No posts yet.</p>';
  return posts
    .map(
      (post) =>
        `<article><h2><a href="${Str.escapeHtml(postPath(post))}">${Str.escapeHtml(post.title)}</a></h2><p>${Str.escapeHtml(post.excerpt)}</p></article>`,
    )
    .join('');
}

/** The navigation used when no `primary` menu has been built in the admin. */
const DEFAULT_NAVIGATION = '<a href="/blog">Blog</a><a href="/">Home</a>';

/**
 * The stored `primary` menu's top-level items as links, or the default
 * navigation when the menu is absent or empty. Every href is re-checked against
 * the menu link policy at render time, so a row written before the policy (or
 * by code that bypassed the repository) still never emits a script URL.
 */
function renderNavigation(items: readonly BlogMenuItem[] | undefined): string {
  const links = [...(items ?? [])]
    .filter((item) => isAllowedMenuHref(item.href))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => `<a href="${Str.escapeHtml(item.href)}">${Str.escapeHtml(item.label)}</a>`);
  return links.length === 0 ? DEFAULT_NAVIGATION : links.join('');
}

/** The configured social profiles as footer links; only http(s) URLs render. */
function renderSocialLinks(social: Readonly<Record<string, string>>): string {
  return Object.entries(social)
    .filter(([, href]) => /^https?:\/\//i.test(href) && isAllowedMenuHref(href))
    .map(
      ([platform, href]) =>
        `<a href="${Str.escapeHtml(href)}" rel="me noopener">${Str.escapeHtml(platform)}</a>`,
    )
    .join('');
}

/** What one themed document renders: the shell inputs plus the layout slots. */
interface ThemedPage {
  readonly title: string;
  readonly layout: 'blogIndex' | 'blogArchive';
  /** Layout slots; inserted verbatim, so every value is already escaped markup. */
  readonly slots: Readonly<Record<string, string>>;
  /** Trusted markup placed at the top of `<main>`, before the layout. */
  readonly lead?: string;
  readonly site: BlogSiteSettings;
  readonly navigation: string;
}

/**
 * Most characters of a search query that are searched and echoed back. A
 * longer `q` is truncated, which bounds both the engine request and the page.
 */
export const BLOG_SEARCH_MAX_QUERY_LENGTH = 200;

/** Default and largest number of items in the RSS/Atom feeds. */
export const BLOG_FEED_DEFAULT_LIMIT = 50;
const BLOG_FEED_MAX_LIMIT = 500;

/** Shared-cache lifetime of the feeds and sitemap when a `siteUrl` fixes their links. */
const FEED_CACHE_CONTROL = 'public, max-age=300';

/** Deepest page a listing link may ask for; larger values clamp to the last page. */
const BLOG_MAX_PAGE = 1_000_000;

/** The largest form `POST /blog/posts` reads. */
const CREATE_FORM_BYTES = 1024 * 1024;

/**
 * Build the blog plugin. Every call creates its own repository unless one is
 * injected, so a plugin instance owns no global state and nothing outside the
 * application registry needs cleanup.
 */
export function blogPlugin(options: BlogPluginOptions = {}): JsailsPlugin {
  const repository = options.repository ?? createMemoryBlogRepository();
  const search = options.search ?? createOramaBlogSearch({ repository });
  const themes = options.themes ?? [];
  const themeRegistry = themes.length === 0 ? undefined : createThemeRegistry({ packages: themes });
  const siteUrl = options.siteUrl === undefined ? undefined : cleanSiteUrl(options.siteUrl);
  const feedLimit = options.feedLimit ?? BLOG_FEED_DEFAULT_LIMIT;
  if (!Number.isInteger(feedLimit) || feedLimit < 1 || feedLimit > BLOG_FEED_MAX_LIMIT) {
    throw new TypeError('blogPlugin feedLimit must be an integer from 1 to 500');
  }
  const createRoute = options.createRoute;
  if (
    createRoute !== undefined &&
    (createRoute === null || typeof createRoute !== 'object' || createRoute.access === undefined)
  ) {
    throw new TypeError('blogPlugin createRoute requires an access');
  }

  // A theme's token CSS and stylesheet depend only on its name, and the
  // registry is immutable, so each is serialized once per process.
  const themeCss = new Map<string, string>();
  function cssFor(registry: ThemePackageRegistry, theme: ThemePackage): string {
    let css = themeCss.get(theme.name);
    if (css === undefined) {
      css = `${themeTokensToCss(registry.activate(theme.name).resolution)}\n${theme.css}`;
      themeCss.set(theme.name, css);
    }
    return css;
  }

  /** Resolve the active theme, falling back to the first registered package. */
  async function activeTheme(): Promise<ThemePackage | undefined> {
    if (themeRegistry === undefined) return undefined;
    try {
      const value = await readCached(
        repository,
        settingCacheKey(BLOG_THEME_SETTING_KEY),
        async () => (await repository.getSetting(BLOG_THEME_SETTING_KEY))?.value,
      );
      if (typeof value === 'string') {
        return themeRegistry.activate(value).resolveActive();
      }
    } catch {
      // A stale theme setting (a name no longer registered) or an unreadable
      // settings table falls back to the registry default.
    }
    return themeRegistry.resolveActive();
  }

  /** The `primary` menu's items (cached briefly), or `undefined` when there is none. */
  function primaryMenu(): Promise<readonly BlogMenuItem[] | undefined> {
    return readCached(repository, PRIMARY_MENU_CACHE_KEY, async () => {
      const menus = await repository.listMenus();
      return menus.find((menu) => menu.location === BLOG_PRIMARY_MENU_LOCATION)?.items;
    });
  }

  /** Render the full themed document: tokens/CSS, header, layout, footer. */
  function renderThemedPage(
    registry: ThemePackageRegistry,
    theme: ThemePackage,
    page: ThemedPage,
  ): string {
    const template = theme.layouts[page.layout];
    if (template === undefined) return '';
    const siteName = Str.escapeHtml(page.site.title);
    const header =
      theme.layouts.header === undefined
        ? ''
        : renderThemeTemplate(theme.layouts.header, {
            siteName,
            navigation: page.navigation,
            actions: '',
          });
    const footer =
      theme.layouts.footer === undefined
        ? ''
        : renderThemeTemplate(theme.layouts.footer, {
            copyright: siteName,
            navigation: page.navigation + renderSocialLinks(page.site.social),
          });
    const body = renderThemeTemplate(template, page.slots);
    return `<!doctype html><html lang="en" data-theme="${Str.escapeHtml(theme.name)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${Str.escapeHtml(page.title)}</title><style>${cssFor(registry, theme)}</style></head><body>${header}<main>${page.lead ?? ''}${body}</main>${footer}</body></html>`;
  }

  /**
   * The themed document for `page`, or `undefined` when no theme is configured
   * or the active theme has no layout for it (the caller then renders the
   * plain markup).
   */
  async function themed(page: Omit<ThemedPage, 'navigation'>): Promise<string | undefined> {
    const theme = await activeTheme();
    if (themeRegistry === undefined || theme === undefined) return undefined;
    if (theme.layouts[page.layout] === undefined) return undefined;
    const navigation = renderNavigation(await primaryMenu());
    return renderThemedPage(themeRegistry, theme, { ...page, navigation });
  }

  /**
   * Fetch exactly one page of published posts. A page past the end clamps to
   * the last page (one extra query, only for an out-of-range link).
   */
  async function loadPage(
    rawPage: string | undefined,
    pageSize: number,
    basePath: string,
    filter: { readonly categoryId?: string; readonly tagId?: string },
  ): Promise<Pagination> {
    const requested = Math.min(requestedPage(rawPage), BLOG_MAX_PAGE);
    const query = (page: number) =>
      repository.listPublishedPosts({ limit: pageSize, offset: (page - 1) * pageSize, ...filter });
    let result = await query(requested);
    const totalPages = pageCount(result.total, pageSize);
    const page = Math.min(requested, totalPages);
    if (page !== requested) result = await query(page);
    return pagination(result.posts, page, totalPages, basePath);
  }

  const beforeCreate: BeforeInterceptor<BlogPostCreateInput> = (args) => {
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
  const afterCreate: AfterInterceptor<BlogPostCreateInput, BlogPost> = (result) => result;

  return definePlugin({
    name: 'blog',
    // Static schema: `db:push`/`db:diff` discover the CMS tables here, without
    // running `setup`, whenever `@jsails/blog` is in `plugins.use`.
    schema: { entities: blogEntities },
    setup({ services, routes, intercept, interceptorRegistry }) {
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
          // Only what a public post list renders. Authorship, media, and
          // taxonomy ids stay server-side, and the rich-text body is loaded
          // with the post page, not streamed to every list subscriber.
          fields: ['id', 'title', 'slug', 'excerpt', 'publishedAt'],
          // Membership must be a pure function of the row (no limit, offset,
          // relation predicate, or clock-derived filter): the live layer
          // re-evaluates it per changed row, so anything else would let the
          // server and client result sets diverge silently
          // (docs/design/live.md §15).
          query: () =>
            query<JsailsBlogPost>(JsailsBlogPost)
              .where(qEq('status', 'published'))
              .orderBy('publishedAt', 'DESC'),
        }),
      );
      // The config service is looked up per request rather than here: the
      // config plugin may be set up after this one, and service reads stay
      // valid after setup seals the registry.
      const siteSettings = (): Promise<BlogSiteSettings> =>
        readBlogSiteSettings(services.tryGet(configToken));

      // Participate in the application's interceptor graph so other plugins
      // (and tests) can hook the operation; the create route emits
      // `postCreatedEvent` so observers on the shared registry also fire.
      intercept(createPostOperation, beforeCreate);
      intercept(createPostOperation, afterCreate, { phase: 'after' });

      /** A public `GET` route reading no credential, so an anonymous answer may be shared. */
      const page = (
        path: string,
        reason: string,
        handler: (context: RouteContext) => Promise<Response>,
      ): void => {
        routes.add({
          methods: ['GET'],
          path,
          access: publicAccess(reason),
          credentials: [],
          handler,
        });
      };

      page('/blog', 'public list of published posts', async (context) => {
        const site = await siteSettings();
        const rawPage = context.url.searchParams.get('page') ?? undefined;
        const pages = await loadPage(rawPage, site.postsPerPage, BLOG_PATH, {});
        const searchForm = renderSearchForm('');
        const document = await themed({
          title: site.title,
          layout: 'blogIndex',
          lead: searchForm,
          site,
          slots: {
            heading: Str.escapeHtml(site.title),
            description: Str.escapeHtml(
              site.tagline === '' ? 'Notes, updates, and stories.' : site.tagline,
            ),
            posts: renderPostCards(pages.items) + renderPaginationNav(pages),
          },
        });
        return Respond.html(document ?? searchForm + renderBlogIndex(pages));
      });

      page('/blog/category/:slug', 'public category archive', async (context) => {
        const category = await repository.getCategoryBySlug(context.params['slug'] ?? '');
        if (category === undefined) throw notFound();
        return Respond.html(
          await renderTermArchive(
            context.url.searchParams.get('page') ?? undefined,
            category,
            'category',
            'Category archive',
            { categoryId: category.id },
          ),
        );
      });

      page('/blog/tag/:slug', 'public tag archive', async (context) => {
        const tag = await repository.getTagBySlug(context.params['slug'] ?? '');
        if (tag === undefined) throw notFound();
        return Respond.html(
          await renderTermArchive(
            context.url.searchParams.get('page') ?? undefined,
            tag,
            'tag',
            'Tag archive',
            { tagId: tag.id },
          ),
        );
      });

      /** A category or tag archive: one paginated page of its published posts. */
      async function renderTermArchive(
        rawPage: string | undefined,
        term: BlogTerm,
        kind: 'category' | 'tag',
        fallbackDescription: string,
        filter: { readonly categoryId?: string; readonly tagId?: string },
      ): Promise<string> {
        const site = await siteSettings();
        const basePath = `${BLOG_PATH}/${kind}/${encodeURIComponent(term.slug)}`;
        const pages = await loadPage(rawPage, site.postsPerPage, basePath, filter);
        const document = await themed({
          title: term.name,
          layout: 'blogArchive',
          site,
          // Theme slots are inserted verbatim, so producer text is escaped here.
          slots: {
            heading: Str.escapeHtml(term.name),
            description: Str.escapeHtml(term.description ?? fallbackDescription),
            posts: renderPostCards(pages.items) + renderPaginationNav(pages),
          },
        });
        return document ?? renderTermIndex(term, pages);
      }

      page('/blog/search', 'public post search', async (context) => {
        const params = context.url.searchParams;
        const query = (params.get('q') ?? '').slice(0, BLOG_SEARCH_MAX_QUERY_LENGTH);
        const site = await siteSettings();
        const searchForm = renderSearchForm(query);
        let result: BlogSearchResult;
        try {
          result = await search.search(query, {
            page: Number(params.get('page') ?? 1),
            limit: Number(params.get('limit') ?? BLOG_SEARCH_PAGE_SIZE),
          });
        } catch (error) {
          // An unreachable or misconfigured search engine is an outage of
          // one feature, not a server fault: answer 503 with the form so the
          // visitor can retry.
          if (!(error instanceof BlogSearchError)) throw error;
          const unavailable = '<p>Search is temporarily unavailable.</p>';
          const document = await themed({
            title: 'Search',
            layout: 'blogArchive',
            lead: searchForm,
            site,
            slots: { heading: 'Search', description: '', posts: unavailable },
          });
          return Respond.html(document ?? searchForm + unavailable, { status: 503 });
        }
        const document = await themed({
          title: 'Search',
          layout: 'blogArchive',
          // The form is a lead fragment concatenated into the document, never
          // spliced in with `String#replace`, whose replacement patterns
          // (`$&`, `` $` ``) would expand inside the echoed query.
          lead: searchForm,
          site,
          slots: {
            heading: 'Search',
            description: 'Search posts by title, excerpt, or body.',
            posts: renderPostCards(result.posts),
          },
        });
        return Respond.html(
          document ?? searchForm + renderSearchResults(query, result.posts, result.total),
        );
      });

      /**
       * The base URL and headers for a feed or sitemap. With a configured
       * `siteUrl` every link is fixed, so shared caches may store the
       * response; the request-origin fallback varies with the Host header, so
       * that response keeps the framework's default `private, no-store`.
       */
      function feedResponse(requestUrl: string): {
        readonly base: string;
        readonly cacheHeaders: Readonly<Record<string, string>>;
      } {
        return {
          base: siteUrl ?? originOf(requestUrl),
          cacheHeaders: siteUrl === undefined ? {} : { 'cache-control': FEED_CACHE_CONTROL },
        };
      }

      /** An XML document of `contentType` with the feed's cache headers. */
      const xmlDocument = (
        body: string,
        contentType: string,
        cacheHeaders: Readonly<Record<string, string>>,
      ): Response =>
        Respond.xml(body, {
          headers: { 'content-type': `${contentType}; charset=utf-8`, ...cacheHeaders },
        });

      page('/blog/rss.xml', 'public RSS feed', async (context) => {
        const site = await siteSettings();
        const { posts } = await repository.listPublishedPosts({ limit: feedLimit, offset: 0 });
        const feed = feedResponse(context.request.url);
        return xmlDocument(
          renderBlogRssFeed(posts, {
            siteUrl: feed.base,
            title: site.title,
            description: site.tagline,
          }),
          'application/rss+xml',
          feed.cacheHeaders,
        );
      });

      page('/blog/atom.xml', 'public Atom feed', async (context) => {
        const site = await siteSettings();
        const { posts } = await repository.listPublishedPosts({ limit: feedLimit, offset: 0 });
        const feed = feedResponse(context.request.url);
        return xmlDocument(
          renderBlogAtomFeed(posts, {
            siteUrl: feed.base,
            title: site.title,
            description: site.tagline,
          }),
          'application/atom+xml',
          feed.cacheHeaders,
        );
      });

      page('/blog/sitemap.xml', 'public sitemap', async (context) => {
        const site = await siteSettings();
        const { posts } = await repository.listPublishedPosts({
          limit: BLOG_MAX_PUBLISHED_PAGE,
          offset: 0,
        });
        const feed = feedResponse(context.request.url);
        return xmlDocument(
          renderBlogSitemap(posts, feed.base, site.timezone),
          'application/xml',
          feed.cacheHeaders,
        );
      });

      // The create route is a write surface, so it exists only when the app
      // opts in with its own access; a bare plugin registers none.
      if (createRoute !== undefined) {
        registerCreateRoute(routes, createRoute);
      }

      /**
       * `POST /blog/posts`: draft creation behind the app's access. It
       * accepts the session cookie, so core's access chain has refused a
       * cross-site post and run the access before the form is read.
       */
      function registerCreateRoute(registrar: HttpRoutes, route: BlogCreateRouteOptions): void {
        registrar.add({
          methods: ['POST'],
          path: `${BLOG_PATH}/posts`,
          access: route.access,
          body: { kind: 'form', maxBytes: CREATE_FORM_BYTES },
          handler: async (context) => {
            const form = await context.body.form();
            const field = (name: string): string => {
              const value = form.get(name);
              return typeof value === 'string' ? value : '';
            };
            const title = field('title');
            const rawSlug = field('slug');
            const args: BlogPostCreateInput = {
              title,
              slug: rawSlug.trim() === '' ? deriveSlug(title) : rawSlug,
              blocks: draftDocument(field('body')),
              status: 'draft',
              authorId: BLOG_HTTP_AUTHOR_ID,
            };
            try {
              // Run the operation through the SHARED registry, not a private one:
              // its run methods stay callable after setup seals registration, so
              // other plugins' interceptors and observers fire for this create.
              await interceptorRegistry.runBefore(createPostOperation, args);
              const post = await repository.createPost(args);
              const created = await interceptorRegistry.runAfter(createPostOperation, args, post);
              await interceptorRegistry.emit(postCreatedEvent, { post: created });
              return Respond.redirect(BLOG_PATH, { status: 303 });
            } catch (error) {
              if (error instanceof BlogValidationError) {
                return Respond.html('<p>Title is required.</p>', { status: 422 });
              }
              // A repository rejection (slug already taken, malformed slug,
              // over-long input) is a client error, not a server failure.
              if (error instanceof BlogContentError) {
                return error.code === 'slug_conflict'
                  ? Respond.html('<p>That slug is already in use.</p>', { status: 409 })
                  : Respond.html('<p>The post could not be created.</p>', { status: 422 });
              }
              throw error;
            }
          },
        });
      }
    },
  });
}
