/**
 * Starter blog index page (static-export / SSG surface).
 *
 * Reads the shared CMS repository through the `blogRepositoryToken` service when
 * the host wired services in (live `serve`), and degrades to an empty list when
 * it did not (static export, browser-free SSR). The repository is
 * database-backed, so a static export never queries it: the build has no
 * request context and must not open a database connection, so this page renders
 * an empty list during SSG.
 * The live interactive list/create surface is the blog plugin's own `GET /blog`
 * and `POST /blog/posts` hook routes, which shadow this page at `/blog` during
 * `serve`; the static export renders this page instead, so `/blog` still has an
 * SSG page.
 */

import type { RequestContext } from 'jsails';
import { blogRepositoryToken, type Post } from '@jsails/blog';
import { Str } from 'jsails/support';
import { renderThemeTemplate } from '@jsails/theme';

import { loadLayout, type LayoutAssets } from '../../ui/layout.js';
import { loadTheme, loadThemeCss, renderThemeChrome } from '../../server/theme.js';

export interface BlogIndexProps {
  /** Published posts; empty when no repository is wired in. */
  posts: readonly Post[];
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** Pre-rendered theme header/footer. */
  themeHeader?: string;
  themeFooter?: string;
  /** Rendered index layout, when the active theme provides one. */
  themeHtml?: string;
}

/** Read the shared store for this request, or an empty list when absent. */
async function listPosts(context: RequestContext): Promise<readonly Post[]> {
  // Static export has no request context and must not open a database
  // connection, so it never queries the repository.
  if (context.renderMode === 'static') {
    return [];
  }
  const repository = context.services?.tryGet(blogRepositoryToken);
  if (repository === undefined) return [];
  const posts = await repository.listPosts();
  return posts.filter((post) => post.status === 'published');
}

export async function load(context: RequestContext): Promise<BlogIndexProps> {
  const [posts, assets, themeCss, theme] = await Promise.all([
    listPosts(context),
    loadLayout(context),
    loadThemeCss(context),
    loadTheme(context),
  ]);
  const chrome = renderThemeChrome(theme);
  const layout = theme.layouts.blogIndex;
  const themeHtml =
    layout === undefined
      ? undefined
      : renderThemeTemplate(layout, {
          heading: 'Blog',
          description: 'Notes, updates, and stories from the Jello Elementor blog.',
          posts: renderPosts(posts),
        });
  return {
    posts,
    assets: { ...assets, themeCss },
    ...(chrome.header === undefined ? {} : { themeHeader: chrome.header }),
    ...(chrome.footer === undefined ? {} : { themeFooter: chrome.footer }),
    ...(themeHtml === undefined ? {} : { themeHtml }),
  };
}

/** Render the post grid as trusted theme-layout HTML. */
function renderPosts(posts: readonly Post[]): string {
  if (posts.length === 0) {
    return '<p class="text-base-content/70">No posts yet.</p>';
  }
  return posts
    .map(
      (post) =>
        `<article><h2><a href="/blog/${encodeURIComponent(post.slug)}">${Str.escapeHtml(post.title)}</a></h2><p>${Str.escapeHtml(post.excerpt ?? '')}</p></article>`,
    )
    .join('');
}

export default function BlogIndexPage({
  posts,
  assets,
  themeHeader,
  themeFooter,
  themeHtml,
}: BlogIndexProps) {
  return (
    <UiLayout
      title="Blog — JSails Starter"
      assets={assets}
      themeHeader={themeHeader}
      themeFooter={themeFooter}
    >
      {themeHtml !== undefined ? (
        <div dangerouslySetInnerHTML={{ __html: themeHtml }} />
      ) : (
        <>
          <header class="text-center">
            <h1 class="text-4xl font-bold tracking-tight">Blog</h1>
            <p class="mt-2 text-base-content/70">
              Posts from the first-party blog plugin (<code>@jsails/blog</code>).
            </p>
          </header>

          {posts.length === 0 ? (
            <p class="text-base-content/70">No posts yet.</p>
          ) : (
            <ul class="w-full space-y-2">
              {posts.map((post) => (
                <li key={post.id}>
                  <a class="link" href={`/blog/${post.slug}`}>
                    {post.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </UiLayout>
  );
}
